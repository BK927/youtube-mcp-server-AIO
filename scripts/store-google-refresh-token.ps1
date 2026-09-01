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

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw "Google Cloud CLI (gcloud) is not installed or is not on PATH."
}

$RefreshTokenSecure = Read-Host "Google OAuth refresh token" -AsSecureString
$RefreshToken = Get-PlainText $RefreshTokenSecure
if ([string]::IsNullOrWhiteSpace($RefreshToken)) {
  throw "Refresh token cannot be empty."
}

& gcloud secrets describe google-oauth-refresh-token `
  --project $ProjectId `
  --format "value(name)" *> $null
if ($LASTEXITCODE -ne 0) {
  Invoke-Gcloud secrets create google-oauth-refresh-token `
    --project $ProjectId `
    --replication-policy automatic `
    --quiet
}

$RefreshToken.Trim() | & gcloud secrets versions add google-oauth-refresh-token `
  --project $ProjectId `
  --data-file=- `
  --quiet
if ($LASTEXITCODE -ne 0) {
  throw "Failed to store the refresh token in Secret Manager."
}
$RefreshToken = $null
$RefreshTokenSecure = $null

Invoke-Gcloud run services update $ServiceName `
  --project $ProjectId `
  --region $Region `
  --update-secrets "GOOGLE_OAUTH_REFRESH_TOKEN=google-oauth-refresh-token:latest" `
  --quiet

$ServiceUrl = (& gcloud run services describe $ServiceName `
  --project $ProjectId `
  --region $Region `
  --format "value(status.url)").Trim()

Write-Host "`nRefresh token stored and a new Cloud Run revision deployed." -ForegroundColor Green
Write-Host "OAuth status: $ServiceUrl/oauth/google/status"
