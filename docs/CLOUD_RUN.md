# Deploying YouTube MCP Server AIO to Google Cloud Run

This guide deploys the server as a remote, stateless Streamable HTTP MCP service while retaining local stdio support.

## Resulting endpoints

After deployment, Cloud Run gives the service a stable HTTPS base URL such as:

```text
https://youtube-mcp-aio-123456789012.asia-northeast1.run.app
```

The application exposes:

```text
MCP endpoint        https://...run.app/mcp
Health check        https://...run.app/health
Service metadata    https://...run.app/
OAuth status        https://...run.app/oauth/google/status
OAuth setup page    https://...run.app/oauth/google/setup
Google callback     https://...run.app/oauth/google/callback
```

The exact Google OAuth redirect URI is therefore:

```text
<CLOUD_RUN_SERVICE_URL>/oauth/google/callback
```

For the server-side OAuth flow, leave **Authorized JavaScript origins** empty. Register the exact callback URL under **Authorized redirect URIs**. Scheme, hostname, path, case, and trailing slash must match; this project intentionally uses no trailing slash.

## Two different authentication layers

Do not confuse these credentials:

1. `MCP_ACCESS_TOKEN` authenticates a client calling `/mcp`.
2. Google OAuth authorizes this server to access YouTube user/account data.
3. `YOUTUBE_API_KEY` authorizes public YouTube Data API requests and is enough for public search, public comments, channels, playlists, and trending data.

Google OAuth is optional in v0.2. Its bootstrap and secure token-storage path are implemented, but the current read-only public-data tools do not consume the stored refresh token yet. It is groundwork for owned-channel, write, Analytics, and Reporting tools.

## What the deployment script configures

`scripts/deploy-cloud-run.ps1` does the following:

- selects the Google Cloud project;
- enables Cloud Run, Cloud Build, Artifact Registry, and Secret Manager APIs;
- creates a dedicated Cloud Run runtime service account;
- gives the default Cloud Build identity the Cloud Run Builder role required for source deployment;
- stores the YouTube API key and MCP bearer token in Secret Manager;
- deploys from the repository Dockerfile;
- configures 1 vCPU, 512 MiB RAM, concurrency 10, 300-second Cloud Run request timeout, minimum instances 0, and maximum instances 1;
- retrieves the generated Cloud Run URL;
- pins `PUBLIC_BASE_URL` and Host validation to that URL;
- prints the final MCP endpoint and the generated bearer token.

The service is public at the Cloud Run IAM layer so ordinary remote MCP clients can reach it. The application still rejects `/mcp` requests without the separate bearer token. Root, health, and OAuth bootstrap/status endpoints do not expose YouTube or MCP credentials.

## Prerequisites

1. Create or select a Google Cloud project.
2. Link a Cloud Billing account to the project. The Cloud Run free tier can cover light personal use, but Cloud Run still uses a billing account and usage beyond the free tier can be charged.
3. Install the current Google Cloud CLI on Windows.
4. Open PowerShell and authenticate:

```powershell
gcloud init
gcloud auth login
gcloud auth list
gcloud projects list
```

Use the immutable **Project ID**, not the display name or numeric project number, in the commands below.

You do not need Docker Desktop for the scripted deployment. `gcloud run deploy --source .` uploads the source, and Cloud Build builds the included Dockerfile remotely.

## One-command first deployment

Open PowerShell:

```powershell
cd C:\Users\dead4\repo\youtube-mcp-server-AIO
npm install
npm run check

pwsh -ExecutionPolicy Bypass -File .\scripts\deploy-cloud-run.ps1 `
  -ProjectId "YOUR_PROJECT_ID"
```

The default values are:

```text
Region       asia-northeast1 (Tokyo)
Service      youtube-mcp-aio
Runtime SA   youtube-mcp-runner
```

To deploy in Seoul instead:

```powershell
pwsh -ExecutionPolicy Bypass -File .\scripts\deploy-cloud-run.ps1 `
  -ProjectId "YOUR_PROJECT_ID" `
  -Region "asia-northeast3"
```

Tokyo is the script default because it is a Tier 1 Cloud Run pricing region and remains geographically close. Seoul is closer but is currently a Tier 2 pricing region. Either region still receives the billing-account-level free-tier discount; prices past the free tier differ.

The script enables YouTube Data API v3 and the API Keys API, creates or reuses an API key restricted to `youtube.googleapis.com`, and stores it in Secret Manager. It also creates a private MCP bearer token and saves it as the Windows user environment variable `YOUTUBE_MCP_ACCESS_TOKEN`. It then prints something similar to:

```text
MCP URL:     https://youtube-mcp-aio-....run.app/mcp
Health URL:  https://youtube-mcp-aio-....run.app/health
OAuth URI:   https://youtube-mcp-aio-....run.app/oauth/google/callback
Credential:  saved as user environment variable YOUTUBE_MCP_ACCESS_TOKEN
```

## Verify the deployment

Set the values printed by the script:

```powershell
$BaseUrl = "https://youtube-mcp-aio-....run.app"
$McpToken = [Environment]::GetEnvironmentVariable("YOUTUBE_MCP_ACCESS_TOKEN", "User")
```

Health check:

```powershell
Invoke-RestMethod "$BaseUrl/health"
```

Expected shape:

```json
{
  "ok": true,
  "service": "youtube-mcp-server-aio",
  "version": "0.2.0"
}
```

Confirm that the MCP endpoint is protected:

```powershell
try {
  Invoke-WebRequest "$BaseUrl/mcp"
} catch {
  $_.Exception.Response.StatusCode.value__
}
```

Expected status: `401`.

A real MCP client must connect using Streamable HTTP and send:

```text
Authorization: Bearer <MCP_ACCESS_TOKEN>
```

A plain browser visit to `/mcp` is not a valid MCP protocol test.

## Google OAuth setup — optional

Skip this section while using only public YouTube data. Perform it when owned-channel, account-scoped, Analytics, Reporting, upload, or write functionality is added.

### 1. Get the exact callback URL

After the initial deployment, run:

```powershell
gcloud run services describe youtube-mcp-aio `
  --project "YOUR_PROJECT_ID" `
  --region "asia-northeast1" `
  --format "value(status.url)"
```

Append:

```text
/oauth/google/callback
```

Example:

```text
https://youtube-mcp-aio-123456789012.asia-northeast1.run.app/oauth/google/callback
```

### 2. Create the OAuth client

In Google Cloud Console:

```text
Google Auth Platform / Clients
→ Create client
→ Application type: Web application
```

Set:

```text
Authorized JavaScript origins: leave empty
Authorized redirect URIs:      exact Cloud Run callback URL
```

Do not enter `/mcp` as the redirect URI. `/mcp` is the MCP protocol endpoint; `/oauth/google/callback` is the Google authorization-code callback.

If the OAuth app is in Testing mode, add the Google account you will authorize as a test user on the Audience page.

### 3. Store the OAuth client safely and enable bootstrap

Run:

```powershell
pwsh -ExecutionPolicy Bypass -File .\scripts\configure-google-oauth.ps1 `
  -ProjectId "YOUR_PROJECT_ID" `
  -Region "asia-northeast1"
```

The script:

- repeats the exact URI values to enter in Google Cloud Console;
- asks for the OAuth Client ID and Client Secret;
- stores the Client Secret and two generated protection secrets in Secret Manager;
- enables the OAuth bootstrap routes;
- prints an OAuth setup URL and a one-time setup password.

Open the printed setup URL:

```text
https://...run.app/oauth/google/setup
```

Enter the printed setup token, complete Google consent, and copy the refresh token displayed after the callback.

### 4. Persist the refresh token

Cloud Run instances are ephemeral, so the callback never writes credentials to a local file. Store the displayed refresh token with:

```powershell
pwsh -ExecutionPolicy Bypass -File .\scripts\store-google-refresh-token.ps1 `
  -ProjectId "YOUR_PROJECT_ID" `
  -Region "asia-northeast1"
```

The script stores it in Secret Manager as `google-oauth-refresh-token` and maps it to `GOOGLE_OAUTH_REFRESH_TOKEN` on a new revision.

Verify status:

```powershell
Invoke-RestMethod "$BaseUrl/oauth/google/status"
```

`refreshTokenConfigured` should be `true`.

## Redeploy after code changes

Run the same deployment script again:

```powershell
pwsh -ExecutionPolicy Bypass -File .\scripts\deploy-cloud-run.ps1 `
  -ProjectId "YOUR_PROJECT_ID" `
  -Region "asia-northeast1"
```

The script updates rather than clears unrelated environment variables and secret mappings, so previously configured Google OAuth values are preserved. It rotates the MCP bearer token on every run and updates the Windows user environment variable. Start a new Codex process after redeployment so it reads the new value.

To avoid rotating the token during an ordinary code-only deployment, use `gcloud run deploy` directly after the first setup:

```powershell
gcloud run deploy youtube-mcp-aio `
  --project "YOUR_PROJECT_ID" `
  --region "asia-northeast1" `
  --source . `
  --allow-unauthenticated `
  --service-account "youtube-mcp-runner@YOUR_PROJECT_ID.iam.gserviceaccount.com" `
  --port 8080 `
  --cpu 1 `
  --memory 512Mi `
  --concurrency 10 `
  --timeout 300 `
  --min 0 `
  --max 1
```

Existing revision configuration persists unless explicitly changed.

## Cost behavior

The deployment uses request-based billing and `--min 0`. When idle, Cloud Run can scale the service to zero. The first request after an idle period can therefore experience a cold start, especially because the container includes Node.js, Python, and yt-dlp.

The script sets `--max 1` as a cost and quota guard for a personal server. It also means one instance handles all simultaneous work. Raise it only after persistent quota storage and distributed rate limiting are implemented; the current API quota ledger and cache are process-local.

Cloud Build and Artifact Registry are also involved in source deployment. Repeated builds and retained container images can create small charges outside the Cloud Run request free tier, so configure a Google Cloud budget alert and occasionally review Artifact Registry storage.

## Security notes

- `.env`, build output, and local dependencies are excluded by `.gcloudignore` and `.dockerignore`.
- API keys, OAuth client secrets, refresh tokens, and the MCP bearer token belong in Secret Manager, not the source tree.
- The Cloud Run URL is public at the IAM layer, but `/mcp` is protected inside the application with a constant-time checked bearer token.
- The implementation validates `Origin` when present and validates the Host against the deployed service hostname.
- `GOOGLE_OAUTH_SETUP_TOKEN` protects the route that begins account authorization.
- OAuth `state` is HMAC-signed and expires after ten minutes by default.
- The callback does not log or persist access tokens. It displays a refresh token only so the operator can move it into Secret Manager.
- Keep `MCP_ALLOW_UNAUTHENTICATED=false` for Internet deployments.

The static MCP bearer token is a pragmatic private-server mechanism, not a complete MCP OAuth authorization server. A client must support a fixed Authorization header or bearer-token provider. If a particular MCP host cannot supply one, do not simply make the server public; add standards-based MCP authorization or place an authenticated gateway in front of it.

## Troubleshooting

### `gcloud` is not recognized

Install Google Cloud CLI, restart PowerShell, then run:

```powershell
gcloud init
```

### Billing error

Link an active Cloud Billing account to the selected project. The free tier is a discount applied after measuring usage; it is not a no-billing-account mode.

### Source build lacks permission

The script grants `roles/run.builder` to the project's default Compute Engine build identity. IAM changes may take a minute to propagate. Wait briefly and rerun the script.

### Cloud Run starts but fails health checks

Read logs:

```powershell
gcloud run services logs read youtube-mcp-aio `
  --project "YOUR_PROJECT_ID" `
  --region "asia-northeast1" `
  --limit 100
```

The container must listen on the injected `PORT`; the project already does this.

### `/mcp` returns `401`

Send the exact bearer token printed during deployment. The YouTube API key and Google OAuth token are not valid MCP access tokens.

### `/mcp` returns `403`

Check the request's `Origin` and Host. `PUBLIC_BASE_URL`, `MCP_ALLOWED_HOSTS`, and optional `MCP_ALLOWED_ORIGINS` must match the URL used by the client.

### Google says `redirect_uri_mismatch`

Compare the URI in Google Cloud Console against:

```text
https://YOUR_SERVICE.run.app/oauth/google/callback
```

Every character must match, including `https`, hostname, path, letter case, and the absence of a trailing slash.

### Google does not return a refresh token

The implementation requests offline access and forces a consent prompt. If Google still omits it, revoke the app's existing access in the Google Account, then run the setup flow again.

### A remote MCP client cannot add a bearer token

That client is not compatible with this private static-token deployment as configured. Use a client that supports an Authorization header, or implement MCP-native OAuth before exposing it broadly.
