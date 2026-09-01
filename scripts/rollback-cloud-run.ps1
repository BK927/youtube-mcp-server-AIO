[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ProjectId,
  [Parameter(Mandatory = $true)][ValidatePattern("^[a-z][a-z0-9-]{0,62}$")][string]$Revision,
  [string]$Region = "asia-northeast1",
  [string]$ServiceName = "youtube-mcp-aio"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$revisionJson = & gcloud run revisions describe $Revision `
  --project $ProjectId --region $Region --format json
if ($LASTEXITCODE -ne 0) { throw "Revision '$Revision' was not found in '$Region'." }
$revisionDocument = $revisionJson | ConvertFrom-Json
$revisionService = [string]$revisionDocument.metadata.labels.'serving.knative.dev/service'
if ($revisionService -ne $ServiceName) {
  throw "Revision '$Revision' belongs to '$revisionService', not '$ServiceName'."
}
& gcloud run services update-traffic $ServiceName --project $ProjectId --region $Region --to-revisions "$Revision=100" --quiet
if ($LASTEXITCODE -ne 0) { throw "Cloud Run rollback failed." }
Write-Host "Rolled $ServiceName back to $Revision at 100%." -ForegroundColor Green
