[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$Region = "asia-northeast1",
  [string]$RepositoryName = "mcp",
  [string]$RuntimeServiceAccountName = "youtube-mcp-runner",
  [string]$ApiKeyId = "youtube-mcp-aio-v1"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Gcloud {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & gcloud @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "gcloud command failed: gcloud $($Arguments -join ' ')"
  }
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

function Ensure-Secret {
  param([string]$Name)
  if (-not (Test-GcloudResource secrets describe $Name --project $ProjectId)) {
    Invoke-Gcloud secrets create $Name `
      --project $ProjectId `
      --replication-policy automatic
  }
}

function Get-LatestSecretVersion {
  param([string]$Name)
  $raw = (& gcloud secrets versions list $Name `
    --project $ProjectId `
    --filter "state=ENABLED" `
    --sort-by "~createTime" `
    --limit 1 `
    --format "value(name)").Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Could not list Secret Manager versions for '$Name'."
  }
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return $null
  }
  return ($raw -split "/")[-1]
}

function Add-SecretVersion {
  param([string]$Name, [string]$Value)
  $Value | & gcloud secrets versions add $Name `
    --project $ProjectId `
    --data-file=- `
    --quiet
  if ($LASTEXITCODE -ne 0) {
    throw "Could not add a Secret Manager version for '$Name'."
  }
}

function Grant-ProjectRole {
  param([string]$Member, [string]$Role)
  Invoke-Gcloud projects add-iam-policy-binding $ProjectId `
    --member $Member `
    --role $Role `
    --condition None `
    --quiet
}

function Grant-SecretRole {
  param([string]$Secret, [string]$ServiceAccount)
  Invoke-Gcloud secrets add-iam-policy-binding $Secret `
    --project $ProjectId `
    --member "serviceAccount:$ServiceAccount" `
    --role roles/secretmanager.secretAccessor `
    --condition None `
    --quiet
}

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw "Google Cloud CLI (gcloud) is not installed or is not on PATH."
}

Write-Host "[1/6] Enabling APIs in $ProjectId..." -ForegroundColor Cyan
Invoke-Gcloud services enable `
  run.googleapis.com `
  cloudbuild.googleapis.com `
  artifactregistry.googleapis.com `
  secretmanager.googleapis.com `
  iam.googleapis.com `
  firestore.googleapis.com `
  apikeys.googleapis.com `
  youtube.googleapis.com `
  --project $ProjectId

Write-Host "[2/6] Creating regional Artifact Registry..." -ForegroundColor Cyan
if (-not (Test-GcloudResource artifacts repositories describe $RepositoryName --project $ProjectId --location $Region)) {
  Invoke-Gcloud artifacts repositories create $RepositoryName `
    --project $ProjectId `
    --location $Region `
    --repository-format docker `
    --description "Private MCP container images"
}
$buildIdentity = (& gcloud builds get-default-service-account --project $ProjectId).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($buildIdentity)) {
  throw "Cloud Build's default service account could not be resolved."
}
$buildIdentity = ($buildIdentity -split "/")[-1]
Invoke-Gcloud artifacts repositories add-iam-policy-binding $RepositoryName `
  --project $ProjectId `
  --location $Region `
  --member "serviceAccount:$buildIdentity" `
  --role roles/artifactregistry.writer `
  --condition None `
  --quiet

Write-Host "[3/6] Creating the runtime identity..." -ForegroundColor Cyan
$runtimeServiceAccount = "$RuntimeServiceAccountName@$ProjectId.iam.gserviceaccount.com"
if (-not (Test-GcloudResource iam service-accounts describe $runtimeServiceAccount --project $ProjectId)) {
  Invoke-Gcloud iam service-accounts create $RuntimeServiceAccountName `
    --project $ProjectId `
    --display-name "YouTube MCP Cloud Run runtime"
}

Write-Host "[4/6] Initializing secrets without rotating existing values..." -ForegroundColor Cyan
Ensure-Secret "youtube-mcp-access-token"
if (-not (Get-LatestSecretVersion "youtube-mcp-access-token")) {
  Add-SecretVersion "youtube-mcp-access-token" (New-RandomHex 32)
}
Ensure-Secret "youtube-mcp-cursor-secret"
if (-not (Get-LatestSecretVersion "youtube-mcp-cursor-secret")) {
  Add-SecretVersion "youtube-mcp-cursor-secret" (New-RandomHex 32)
}

Ensure-Secret "youtube-data-api-key"
if (-not (Test-GcloudResource services api-keys describe $ApiKeyId --project $ProjectId)) {
  Invoke-Gcloud services api-keys create `
    --project $ProjectId `
    --key-id $ApiKeyId `
    --display-name "YouTube MCP Data API" `
    --api-target "service=youtube.googleapis.com"
}
if (-not (Get-LatestSecretVersion "youtube-data-api-key")) {
  $apiKey = (& gcloud services api-keys get-key-string $ApiKeyId `
    --project $ProjectId `
    --format "value(keyString)").Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($apiKey)) {
    throw "The restricted YouTube Data API key string could not be read."
  }
  Add-SecretVersion "youtube-data-api-key" $apiKey
  $apiKey = $null
}
Grant-SecretRole "youtube-mcp-access-token" $runtimeServiceAccount
Grant-SecretRole "youtube-mcp-cursor-secret" $runtimeServiceAccount
Grant-SecretRole "youtube-data-api-key" $runtimeServiceAccount

Write-Host "[5/6] Creating Firestore Native quota storage..." -ForegroundColor Cyan
if (-not (Test-GcloudResource firestore databases describe --database "(default)" --project $ProjectId)) {
  Invoke-Gcloud firestore databases create `
    --database "(default)" `
    --location $Region `
    --type firestore-native `
    --delete-protection `
    --project $ProjectId `
    --quiet
}
$firestoreLocation = (& gcloud firestore databases describe `
  --database "(default)" `
  --project $ProjectId `
  --format "value(locationId)").Trim()
if ($LASTEXITCODE -ne 0 -or $firestoreLocation -ne $Region) {
  throw "Firestore (default) must be in '$Region'; current location is '$firestoreLocation'."
}
Grant-ProjectRole "serviceAccount:$runtimeServiceAccount" roles/datastore.user

Write-Host "[6/6] Provisioning complete." -ForegroundColor Green
Write-Host "Region:            $Region"
Write-Host "Artifact Registry: $Region-docker.pkg.dev/$ProjectId/$RepositoryName"
Write-Host "Runtime identity:  $runtimeServiceAccount"
Write-Host "Quota store:       Firestore Native / youtube_quota"
Write-Host "API key:           restricted to youtube.googleapis.com"
Write-Host "Bearer token:      initialized only if absent; rotate only during deploy with -RotateAccessToken"
