[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,
  [string]$Region = "asia-northeast1",
  [string]$ServiceName = "youtube-mcp-aio",
  [string]$RepositoryName = "mcp",
  [string]$ImageName = "youtube-mcp-aio",
  [string]$RuntimeServiceAccountName = "youtube-mcp-runner",
  [string]$SmokeVideoId = "dQw4w9WgXcQ",
  [string]$TokenEnvironmentVariable = "YOUTUBE_MCP_ACCESS_TOKEN",
  [switch]$RotateAccessToken,
  [switch]$Promote
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Gcloud {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & gcloud @Arguments
  if ($LASTEXITCODE -ne 0) { throw "gcloud command failed: gcloud $($Arguments -join ' ')" }
}

function Test-GcloudResource {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & gcloud @Arguments *> $null
  return $LASTEXITCODE -eq 0
}

function New-RandomHex {
  param([int]$ByteCount = 32)
  $bytes = [byte[]]::new($ByteCount)
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Get-LatestSecretVersion {
  param([string]$Name)
  $raw = @(& gcloud secrets versions list $Name --project $ProjectId --filter "state=ENABLED" --sort-by "~createTime" --limit 1 --format "value(name)") -join ""
  $raw = $raw.Trim()
  if ($LASTEXITCODE -ne 0) { throw "Could not list versions for '$Name'. Run provision-gcp.ps1 first." }
  if ([string]::IsNullOrWhiteSpace($raw)) { throw "Secret '$Name' has no enabled numeric version." }
  return ($raw -split "/")[-1]
}

function Add-SecretVersion {
  param([string]$Name, [string]$Value)
  $Value | & gcloud secrets versions add $Name --project $ProjectId --data-file=- --quiet
  if ($LASTEXITCODE -ne 0) { throw "Could not rotate '$Name'." }
}

function Get-ServiceDocument {
  $json = & gcloud run services describe $ServiceName --project $ProjectId --region $Region --format json
  if ($LASTEXITCODE -ne 0) { throw "Cloud Run service '$ServiceName' could not be described." }
  return ($json | ConvertFrom-Json)
}

function Get-TaggedUrl {
  param([object]$Document, [string]$Tag)
  $entries = @()
  if ($Document.status.PSObject.Properties.Name -contains "traffic") { $entries += @($Document.status.traffic) }
  if ($Document.status.PSObject.Properties.Name -contains "trafficStatuses") { $entries += @($Document.status.trafficStatuses) }
  $match = @($entries | Where-Object { $_.tag -eq $Tag -and $_.url } | Select-Object -First 1)
  if ($match.Count -eq 0) { return $null }
  return [string]$match[0].url
}

function Get-TaggedRevision {
  param([object]$Document, [string]$Tag)
  $entries = @()
  if ($Document.status.PSObject.Properties.Name -contains "traffic") { $entries += @($Document.status.traffic) }
  if ($Document.status.PSObject.Properties.Name -contains "trafficStatuses") { $entries += @($Document.status.trafficStatuses) }
  $match = @($entries | Where-Object { $_.tag -eq $Tag -and $_.revisionName } | Select-Object -First 1)
  if ($match.Count -eq 0) { return $null }
  return [string]$match[0].revisionName
}

function Deploy-Candidate {
  param([string]$RevisionSuffix, [string]$PublicBaseUrl, [string]$AllowedHosts, [bool]$NoTraffic)
  $envValues = "^@^MCP_TRANSPORT=http@HOST=0.0.0.0@PORT=8080@MCP_PATH=/mcp@HEALTH_PATH=/healthz@HTTP_MAX_BODY_BYTES=2097152@HTTP_REQUEST_TIMEOUT_MS=300000@MCP_ALLOW_UNAUTHENTICATED=false@PUBLIC_BASE_URL=$PublicBaseUrl@MCP_ALLOWED_HOSTS=$AllowedHosts@YOUTUBE_QUOTA_STORE=firestore@GOOGLE_CLOUD_PROJECT=$ProjectId@YOUTUBE_CURSOR_TTL_SECONDS=86400@YOUTUBE_MAX_RESULT_BYTES=12288"
  $secretValues = "^@^MCP_ACCESS_TOKEN=youtube-mcp-access-token:$accessVersion@YOUTUBE_CURSOR_SECRET=youtube-mcp-cursor-secret:$cursorSecretVersion@YOUTUBE_API_KEY=youtube-data-api-key:$apiKeyVersion"
  $arguments = @(
    "run", "deploy", $ServiceName, "--project", $ProjectId, "--region", $Region,
    "--image", $immutableImage, "--allow-unauthenticated", "--ingress", "all",
    "--execution-environment", "gen2", "--service-account", $runtimeServiceAccount,
    "--port", "8080", "--cpu", "1", "--memory", "1Gi", "--concurrency", "4",
    "--timeout", "300", "--min-instances", "0", "--max-instances", "2",
    "--set-env-vars", $envValues, "--set-secrets", $secretValues,
    "--revision-suffix", $RevisionSuffix, "--tag", "candidate",
    "--labels", "app=youtube-mcp-aio,git-sha=$shortSha", "--quiet"
  )
  if ($NoTraffic) { $arguments += "--no-traffic" }
  Invoke-Gcloud @arguments
}

function Test-HttpStatus {
  param([string]$Url, [int]$ExpectedStatus)
  try {
    $response = Invoke-WebRequest -Uri $Url -Method Post -ContentType "application/json" -Body "{}"
    $status = [int]$response.StatusCode
  }
  catch {
    if (-not $_.Exception.Response) { throw }
    $status = [int]$_.Exception.Response.StatusCode
  }
  if ($status -ne $ExpectedStatus) { throw "Expected HTTP $ExpectedStatus from '$Url', received $status." }
}

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) { throw "Google Cloud CLI (gcloud) is not installed or is not on PATH." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git is required for SHA-tagged builds." }
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "Node.js 24 and npm are required for the frozen MCP SDK smoke client." }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$gitSha = (& git -C $projectRoot rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $gitSha -notmatch "^[0-9a-f]{40}$") { throw "The repository HEAD is not a full Git SHA." }
$dirty = & git -C $projectRoot status --porcelain
if ($LASTEXITCODE -ne 0 -or $dirty) { throw "Deployment requires a clean worktree so the SHA identifies the exact build context." }
Push-Location $projectRoot
try {
  & npm ci --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed; the smoke client must use package-lock.json." }
}
finally { Pop-Location }

$shortSha = $gitSha.Substring(0, 12)
$revisionNonce = Get-Date -AsUTC -Format "yyyyMMddHHmmss"
$runtimeServiceAccount = "$RuntimeServiceAccountName@$ProjectId.iam.gserviceaccount.com"
$taggedImage = "$Region-docker.pkg.dev/$ProjectId/$RepositoryName/${ImageName}:$gitSha"

if (-not (Test-GcloudResource secrets describe youtube-mcp-access-token --project $ProjectId)) { throw "Missing youtube-mcp-access-token. Run provision-gcp.ps1 first." }
if ($RotateAccessToken) { Add-SecretVersion "youtube-mcp-access-token" (New-RandomHex 32) }
$accessVersion = Get-LatestSecretVersion "youtube-mcp-access-token"
$cursorSecretVersion = Get-LatestSecretVersion "youtube-mcp-cursor-secret"
$apiKeyVersion = Get-LatestSecretVersion "youtube-data-api-key"

Write-Host "[1/6] Building immutable image $taggedImage..." -ForegroundColor Cyan
Push-Location $projectRoot
try { Invoke-Gcloud builds submit . --project $ProjectId --tag $taggedImage --quiet }
finally { Pop-Location }
$digest = (& gcloud artifacts docker images describe $taggedImage --project $ProjectId --format "value(image_summary.digest)").Trim()
if ($LASTEXITCODE -ne 0 -or $digest -notmatch "^sha256:[0-9a-f]{64}$") { throw "Artifact Registry returned no valid digest for '$taggedImage'." }
$immutableImage = "$Region-docker.pkg.dev/$ProjectId/$RepositoryName/$ImageName@$digest"

$serviceExists = Test-GcloudResource run services describe $ServiceName --project $ProjectId --region $Region
if (-not $serviceExists -and -not $Promote) { throw "The first deployment has no prior revision. Re-run with -Promote after reviewing the bootstrap exception." }
$serviceUrl = ""
$candidateUrl = ""
if ($serviceExists) {
  $serviceDocument = Get-ServiceDocument
  $serviceUrl = [string]$serviceDocument.status.url
  $candidateUrl = Get-TaggedUrl $serviceDocument "candidate"
}

if ([string]::IsNullOrWhiteSpace($candidateUrl)) {
  Write-Host "[2/6] Discovering the stable candidate tag URL..." -ForegroundColor Cyan
  $bootstrapHosts = if ($serviceUrl) { ([Uri]$serviceUrl).Host } else { "" }
  Deploy-Candidate "$shortSha-bootstrap-$revisionNonce" $serviceUrl $bootstrapHosts $true
  $serviceDocument = Get-ServiceDocument
  $serviceUrl = [string]$serviceDocument.status.url
  $candidateUrl = Get-TaggedUrl $serviceDocument "candidate"
  if ([string]::IsNullOrWhiteSpace($candidateUrl)) { throw "Cloud Run did not publish a candidate tag URL." }
}

Write-Host "[3/6] Deploying the hardened candidate by digest with zero traffic..." -ForegroundColor Cyan
$serviceHost = ([Uri]$serviceUrl).Host
$candidateHost = ([Uri]$candidateUrl).Host
Deploy-Candidate "$shortSha-candidate-$revisionNonce" $serviceUrl "$serviceHost,$candidateHost" $true
$serviceDocument = Get-ServiceDocument
$candidateUrl = Get-TaggedUrl $serviceDocument "candidate"
$candidateRevision = Get-TaggedRevision $serviceDocument "candidate"
if (-not $candidateUrl -or -not $candidateRevision) {
  throw "The hardened candidate URL/revision could not be resolved."
}

Write-Host "[4/6] Smoking /healthz, bearer enforcement, and the four-tool contract..." -ForegroundColor Cyan
$health = Invoke-RestMethod -Uri "$candidateUrl/healthz" -Method Get
if (-not $health.ok) { throw "Candidate health response did not report ok=true." }
Test-HttpStatus "$candidateUrl/mcp" 401
$accessToken = (& gcloud secrets versions access $accessVersion --secret youtube-mcp-access-token --project $ProjectId).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($accessToken)) { throw "Could not read the pinned bearer secret version." }
$priorSmokeToken = $env:MCP_SMOKE_ACCESS_TOKEN
try {
  $env:MCP_SMOKE_ACCESS_TOKEN = $accessToken
  & node (Join-Path $PSScriptRoot "smoke-cloud-run.mjs") `
    --url "$candidateUrl/mcp" `
    --video $SmokeVideoId
  if ($LASTEXITCODE -ne 0) { throw "Protocol-aware YouTube candidate smoke failed." }
}
finally {
  if ($null -eq $priorSmokeToken) { Remove-Item Env:MCP_SMOKE_ACCESS_TOKEN -ErrorAction SilentlyContinue }
  else { $env:MCP_SMOKE_ACCESS_TOKEN = $priorSmokeToken }
}

Write-Host "[5/6] Candidate smoke passed." -ForegroundColor Green
if ($Promote) {
  Invoke-Gcloud run services update-traffic $ServiceName --project $ProjectId --region $Region --to-tags "candidate=100" --quiet
  Write-Host "Promoted candidate to 100%." -ForegroundColor Green
}
else { Write-Host "Candidate remains at 0%; promote it only after approval." -ForegroundColor Yellow }

if ($Promote) {
  Write-Host "[6/6] Saving the promoted bearer credential for this Windows account..." -ForegroundColor Cyan
  [Environment]::SetEnvironmentVariable($TokenEnvironmentVariable, $accessToken, "User")
  Set-Item -Path "Env:$TokenEnvironmentVariable" -Value $accessToken
}
else {
  Write-Host "[6/6] Candidate credential was not persisted because production was not promoted." -ForegroundColor Yellow
}
Write-Host "Image:      $immutableImage"
Write-Host "Revision:   $candidateRevision"
Write-Host "Candidate:  $candidateUrl/mcp"
Write-Host "Production: $serviceUrl/mcp"
Write-Host "Health:     $serviceUrl/healthz"
Write-Host "Secrets:    youtube-mcp-access-token:$accessVersion, youtube-mcp-cursor-secret:$cursorSecretVersion, youtube-data-api-key:$apiKeyVersion"
