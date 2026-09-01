[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$Region = "asia-northeast1",
  [string]$ServiceName = "youtube-mcp-aio"
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

function Get-PlainText {
  param([Security.SecureString]$SecureValue)
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
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

$ServiceUrl = (& gcloud run services describe $ServiceName `
  --project $ProjectId `
  --region $Region `
  --format "value(status.url)").Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($ServiceUrl)) {
  throw "Cloud Run service '$ServiceName' was not found in $Region. Deploy it first."
}

$RedirectUri = "$ServiceUrl/oauth/google/callback"
Write-Host "`nCreate a Google OAuth client with these exact settings:" -ForegroundColor Cyan
Write-Host "Application type:               Web application"
Write-Host "Authorized JavaScript origins: leave empty"
Write-Host "Authorized redirect URI:       $RedirectUri" -ForegroundColor Yellow
Write-Host ""
Read-Host "Press Enter after creating the OAuth client"

$ClientId = (Read-Host "OAuth Client ID").Trim()
if ([string]::IsNullOrWhiteSpace($ClientId)) {
  throw "OAuth Client ID cannot be empty."
}
$ClientSecretSecure = Read-Host "OAuth Client Secret" -AsSecureString
$ClientSecret = Get-PlainText $ClientSecretSecure
if ([string]::IsNullOrWhiteSpace($ClientSecret)) {
  throw "OAuth Client Secret cannot be empty."
}

$StateSecret = New-RandomHex 32
$SetupToken = New-RandomHex 32

Set-SecretValue -Name "google-oauth-client-secret" -Value $ClientSecret.Trim()
Set-SecretValue -Name "google-oauth-state-secret" -Value $StateSecret
Set-SecretValue -Name "google-oauth-setup-token" -Value $SetupToken
$ClientSecret = $null
$ClientSecretSecure = $null

Invoke-Gcloud run services update $ServiceName `
  --project $ProjectId `
  --region $Region `
  --update-env-vars "GOOGLE_OAUTH_ENABLED=true,GOOGLE_OAUTH_CLIENT_ID=$ClientId,GOOGLE_OAUTH_SCOPES=https://www.googleapis.com/auth/youtube.readonly" `
  --update-secrets "GOOGLE_OAUTH_CLIENT_SECRET=google-oauth-client-secret:latest,GOOGLE_OAUTH_STATE_SECRET=google-oauth-state-secret:latest,GOOGLE_OAUTH_SETUP_TOKEN=google-oauth-setup-token:latest" `
  --quiet

Write-Host "`nGoogle OAuth bootstrap is enabled." -ForegroundColor Green
Write-Host "Open: $ServiceUrl/oauth/google/setup"
Write-Host "OAuth setup token (enter it in that page):" -ForegroundColor Yellow
Write-Host $SetupToken
Write-Host ""
Write-Host "After Google redirects back, copy the refresh token shown once and run scripts/store-google-refresh-token.ps1."
