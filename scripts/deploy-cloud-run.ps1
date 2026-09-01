[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$Region = "asia-northeast1",
  [string]$ServiceName = "youtube-mcp-aio",
  [string]$ServiceAccountName = "youtube-mcp-runner",
  [string]$ApiKeyId = "youtube-mcp-aio-v3",
  [string]$TokenEnvironmentVariable = "YOUTUBE_MCP_ACCESS_TOKEN"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Gcloud {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & gcloud @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "gcloud command failed with exit code $LASTEXITCODE."
  }
}

function New-RandomHex {
  param([int]$ByteCount = 32)
  $bytes = New-Object byte[] $ByteCount
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  }
  finally {
    $generator.Dispose()
  }
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Set-SecretValue {
  param(
    [string]$Name,
    [string]$Value
  )

  & gcloud secrets describe $Name --project $ProjectId --format "value(name)" *> $null
  if ($LASTEXITCODE -ne 0) {
    Invoke-Gcloud secrets create $Name `
      --project $ProjectId `
      --replication-policy automatic `
      --quiet
  }

  $Value | & gcloud secrets versions add $Name `
    --project $ProjectId `
    --data-file=- `
    --quiet
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to add a version to Secret Manager secret '$Name'."
  }
}

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw "Google Cloud CLI (gcloud) is not installed or is not on PATH."
}

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ServiceAccount = "$ServiceAccountName@$ProjectId.iam.gserviceaccount.com"
$ProjectNumber = (& gcloud projects describe $ProjectId --format "value(projectNumber)").Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($ProjectNumber)) {
  throw "Google Cloud project '$ProjectId' was not found or is not accessible."
}
$BuildServiceAccount = "$ProjectNumber-compute@developer.gserviceaccount.com"

Write-Host "`n[1/6] Selecting project and enabling APIs..." -ForegroundColor Cyan
Invoke-Gcloud config set project $ProjectId
Invoke-Gcloud services enable `
  run.googleapis.com `
  cloudbuild.googleapis.com `
  artifactregistry.googleapis.com `
  secretmanager.googleapis.com `
  iam.googleapis.com `
  apikeys.googleapis.com `
  youtube.googleapis.com `
  --project $ProjectId

Write-Host "`n[2/6] Preparing Cloud Run runtime and build identities..." -ForegroundColor Cyan
& gcloud iam service-accounts describe $ServiceAccount --project $ProjectId *> $null
if ($LASTEXITCODE -ne 0) {
  Invoke-Gcloud iam service-accounts create $ServiceAccountName `
    --project $ProjectId `
    --display-name "YouTube MCP Cloud Run runtime"
}

$BuildIdentityFound = $false
for ($attempt = 1; $attempt -le 12; $attempt++) {
  & gcloud iam service-accounts describe $BuildServiceAccount --project $ProjectId *> $null
  if ($LASTEXITCODE -eq 0) {
    $BuildIdentityFound = $true
    break
  }
  Start-Sleep -Seconds 5
}
if (-not $BuildIdentityFound) {
  throw "The default Cloud Build identity '$BuildServiceAccount' was not created. Wait a minute and run the script again."
}

Invoke-Gcloud projects add-iam-policy-binding $ProjectId `
  --member "serviceAccount:$BuildServiceAccount" `
  --role "roles/run.builder" `
  --condition=None `
  --quiet

Write-Host "`n[3/6] Creating a YouTube-only API key and private server credential..." -ForegroundColor Cyan
& gcloud services api-keys describe $ApiKeyId --project $ProjectId --format "value(name)" *> $null
if ($LASTEXITCODE -ne 0) {
  & gcloud services api-keys create `
    --project $ProjectId `
    --key-id $ApiKeyId `
    --display-name "YouTube MCP AIO" `
    --api-target "service=youtube.googleapis.com" `
    --quiet *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create YouTube API key '$ApiKeyId'."
  }
}
$YouTubeApiKey = (& gcloud services api-keys get-key-string $ApiKeyId `
  --project $ProjectId `
  --format "value(keyString)").Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($YouTubeApiKey)) {
  throw "The restricted YouTube API key could not be retrieved."
}
$McpAccessToken = New-RandomHex 32

Set-SecretValue -Name "youtube-api-key" -Value $YouTubeApiKey.Trim()
Set-SecretValue -Name "youtube-mcp-access-token" -Value $McpAccessToken
$YouTubeApiKey = $null

Write-Host "`n[4/6] Granting the runtime access to this project's secrets..." -ForegroundColor Cyan
Invoke-Gcloud projects add-iam-policy-binding $ProjectId `
  --member "serviceAccount:$ServiceAccount" `
  --role "roles/secretmanager.secretAccessor" `
  --condition=None `
  --quiet

Write-Host "`n[5/6] Building from the Dockerfile and deploying to Cloud Run..." -ForegroundColor Cyan
Push-Location $ProjectRoot
try {
  Invoke-Gcloud run deploy $ServiceName `
    --project $ProjectId `
    --region $Region `
    --source . `
    --allow-unauthenticated `
    --service-account $ServiceAccount `
    --port 8080 `
    --cpu 1 `
    --memory 512Mi `
    --concurrency 10 `
    --timeout 300 `
    --min 0 `
    --max 1 `
    --update-env-vars "MCP_TRANSPORT=http,HEALTH_PATH=/health,YOUTUBE_PROVIDER_MODE=hybrid,YOUTUBE_DEFAULT_REGION=KR,YOUTUBE_DEFAULT_LANGUAGE=ko,MCP_ALLOW_UNAUTHENTICATED=false" `
    --update-secrets "YOUTUBE_API_KEY=youtube-api-key:latest,MCP_ACCESS_TOKEN=youtube-mcp-access-token:latest" `
    --quiet
}
finally {
  Pop-Location
}

$ServiceUrl = (& gcloud run services describe $ServiceName `
  --project $ProjectId `
  --region $Region `
  --format "value(status.url)").Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($ServiceUrl)) {
  throw "Deployment succeeded, but the Cloud Run service URL could not be read."
}
$ServiceHost = ([Uri]$ServiceUrl).Host

Write-Host "`n[6/6] Pinning the public URL and Host validation..." -ForegroundColor Cyan
Invoke-Gcloud run services update $ServiceName `
  --project $ProjectId `
  --region $Region `
  --update-env-vars "PUBLIC_BASE_URL=$ServiceUrl,MCP_ALLOWED_HOSTS=$ServiceHost" `
  --quiet

[Environment]::SetEnvironmentVariable($TokenEnvironmentVariable, $McpAccessToken, "User")
Set-Item -Path "Env:$TokenEnvironmentVariable" -Value $McpAccessToken

Write-Host "`nDeployment complete." -ForegroundColor Green
Write-Host "MCP URL:     $ServiceUrl/mcp"
Write-Host "Health URL:  $ServiceUrl/health"
Write-Host "OAuth URI:   $ServiceUrl/oauth/google/callback"
Write-Host "Credential: saved as user environment variable $TokenEnvironmentVariable"
Write-Host "Cloud Run is public at the IAM layer so ordinary MCP clients can reach it, but /mcp rejects requests that do not carry this bearer token."
