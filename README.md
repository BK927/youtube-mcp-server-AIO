# YouTube MCP Server AIO

Evidence-first, quota-aware, all-in-one YouTube MCP server for research, channel analysis, transcripts, comments, playlists, and future creator analytics.

> Current status: **v0.2 read-only remote-ready MVP**. Local stdio and authenticated stateless Streamable HTTP are implemented, with a Cloud Run Dockerfile and deployment scripts. Google OAuth bootstrap is available for future account-scoped tools; creator writes, Analytics/Reporting, and persistent research corpora are not implemented yet.

## Why this project exists

Most YouTube MCP servers specialize in one of two extremes:

- a tiny transcript-only wrapper that is easy to use but fragile; or
- dozens of low-level API tools that consume model context, quota, and setup effort.

This project keeps a small stable tool surface while routing requests through replaceable providers. It separates official API access from unofficial public-transcript access, returns citation-ready timestamps, guards quota locally, and paginates large results instead of dumping everything into an LLM context window.

## Implemented tools

| Tool | API key | Purpose |
| --- | --- | --- |
| `youtube_capabilities` | No | Inspect modes, providers, availability, safeguards, and quota guards |
| `youtube_video_get` | Optional | Official full metadata when keyed; limited oEmbed metadata otherwise |
| `youtube_transcript_get` | No* | Paginated transcript segments with exact timestamp links |
| `youtube_transcript_search` | No* | Search transcript evidence with context and time-window filters |
| `youtube_search` | Yes | Search videos through `search.list` |
| `youtube_channel_get` | Yes | Resolve channel ID, handle, URL, legacy username, or name |
| `youtube_channel_videos` | Yes | List uploads through the uploads playlist without spending search calls |
| `youtube_playlist_get` | Yes | Playlist metadata and paginated items |
| `youtube_comments_get` | Yes | Paginated public comment threads and optional embedded replies |
| `youtube_trending` | Yes | Official regional `mostPopular` chart |
| `youtube_quota_status` | No | Inspect process-local ordinary-data and search guards |

\* Public transcripts rely on unofficial interfaces. They can fail for videos without captions, blocked regions, bot checks, or future YouTube changes.

## Transcript provider chain

Default order:

1. `yt-dlp` — used when the executable is installed and discoverable.
2. `youtubejs` — tries multiple YouTube player clients and reads caption-track URLs directly; it also retains YouTube.js's transcript endpoint as a fallback.

A provider failure does not immediately fail the tool. The server records the attempt and moves to the next provider. Results identify the provider and include relevant warnings.

## Installation

Requirements:

- Node.js 24 or newer
- npm
- Optional: a YouTube Data API v3 key
- Optional but recommended: `yt-dlp`

```bash
cd C:\Users\dead4\repo\youtube-mcp-server-AIO
npm install
copy .env.example .env
npm run check
npm run build
```

The executable entry is:

```text
C:\Users\dead4\repo\youtube-mcp-server-AIO\dist\index.js
```

## MCP client configuration

Generic local stdio configuration:

```json
{
  "mcpServers": {
    "youtube-aio": {
      "command": "node",
      "args": [
        "C:\\Users\\dead4\\repo\\youtube-mcp-server-AIO\\dist\\index.js"
      ],
      "env": {
        "YOUTUBE_API_KEY": "YOUR_OPTIONAL_API_KEY",
        "YOUTUBE_PROVIDER_MODE": "hybrid",
        "YOUTUBE_DEFAULT_REGION": "KR",
        "YOUTUBE_DEFAULT_LANGUAGE": "ko"
      }
    }
  }
}
```

The server also loads `.env` from the project root, regardless of the MCP client's working directory. Client-supplied environment variables take precedence when already set.

## Remote Streamable HTTP and Cloud Run

HTTP mode preserves the same 11-tool surface and exposes one MCP endpoint:

```text
https://YOUR_CLOUD_RUN_SERVICE.run.app/mcp
```

It also exposes:

```text
GET /healthz
GET /
GET /oauth/google/status
GET /oauth/google/setup
POST /oauth/google/start
GET /oauth/google/callback
```

Internet-facing HTTP mode refuses to start without a 32+ character `MCP_ACCESS_TOKEN`, unless the operator explicitly opts into an unauthenticated server. Clients send the token as:

```text
Authorization: Bearer <MCP_ACCESS_TOKEN>
```

A Dockerfile installs the Node.js server plus an isolated `yt-dlp` Python environment. The included PowerShell script deploys that Dockerfile from source, stores secrets in Google Secret Manager, sets scale-to-zero, and prints the resulting URL and bearer token:

```powershell
pwsh -ExecutionPolicy Bypass -File .\scripts\deploy-cloud-run.ps1 `
  -ProjectId "YOUR_PROJECT_ID"
```

See [`docs/CLOUD_RUN.md`](docs/CLOUD_RUN.md) for the complete first deployment, URI setup, Google OAuth bootstrap, verification, redeployment, cost behavior, and troubleshooting guide.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | empty | Enables official search, channel, playlist, comment, and trending tools |
| `YOUTUBE_PROVIDER_MODE` | `hybrid` | `hybrid`, `official`, or `unofficial` |
| `YOUTUBE_TRANSCRIPT_PROVIDERS` | `yt-dlp,youtubejs` | Ordered transcript providers |
| `YT_DLP_PATH` | `yt-dlp` | Executable name or absolute path |
| `YOUTUBE_DEFAULT_REGION` | `US` | Default two-letter region for trending |
| `YOUTUBE_DEFAULT_LANGUAGE` | `en` | Preferred transcript/session language |
| `YOUTUBE_REQUEST_TIMEOUT_MS` | `15000` | Network timeout |
| `YOUTUBE_CACHE_TTL_SECONDS` | `900` | In-memory metadata/transcript cache TTL |
| `YOUTUBE_API_DAILY_BUDGET` | `9000` | Conservative local guard for ordinary Data API calls |
| `YOUTUBE_SEARCH_DAILY_BUDGET` | `90` | Conservative local guard for `search.list` calls |
| `YOUTUBE_ENABLE_WRITE_TOOLS` | `false` | Reserved; write tools are not implemented in v0.2 |

Remote runtime variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_TRANSPORT` | auto | `stdio` locally, `http` when `K_SERVICE` exists; CLI flags override it |
| `HOST` | `0.0.0.0` | HTTP bind address |
| `PORT` | `8080` | HTTP port; Cloud Run injects this variable |
| `PUBLIC_BASE_URL` | empty | Stable HTTPS Cloud Run/service base URL used for advertised endpoints and OAuth redirects |
| `MCP_PATH` | `/mcp` | Streamable HTTP endpoint |
| `HEALTH_PATH` | `/healthz` | Health endpoint |
| `MCP_ACCESS_TOKEN` | empty | 32+ character bearer token required for private HTTP MCP access |
| `MCP_ALLOW_UNAUTHENTICATED` | `false` | Explicitly permit a public `/mcp`; unsafe for normal Internet deployment |
| `MCP_ALLOWED_ORIGINS` | empty | Additional comma/space-separated exact browser origins |
| `MCP_ALLOWED_HOSTS` | empty | Additional hostnames; `PUBLIC_BASE_URL` is added automatically |
| `HTTP_MAX_BODY_BYTES` | `2097152` | Maximum MCP request body size |
| `HTTP_REQUEST_TIMEOUT_MS` | `300000` | Node HTTP request timeout; keep aligned with Cloud Run timeout |

Optional Google OAuth bootstrap variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `GOOGLE_OAUTH_ENABLED` | `false` | Enables setup, start, callback, and status routes |
| `GOOGLE_OAUTH_CLIENT_ID` | empty | Web application OAuth client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | empty | OAuth client secret; store in Secret Manager |
| `GOOGLE_OAUTH_STATE_SECRET` | empty | 32+ character HMAC secret for expiring OAuth state |
| `GOOGLE_OAUTH_SETUP_TOKEN` | empty | 32+ character password protecting authorization startup |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | empty | Persisted account grant for future account-scoped tools |
| `GOOGLE_OAUTH_SCOPES` | `youtube.readonly` | Space/comma-separated minimal Google scopes |

### Provider modes

- `hybrid`: official Data API when a key exists, plus unofficial transcript providers.
- `official`: disables unofficial transcript providers. Public transcript retrieval will normally be unavailable until an owned-video OAuth captions provider is added.
- `unofficial`: disables Data API tools even when a key is present; useful for a no-key research-only deployment.

## Design choices

### Citation-ready transcript evidence

Every segment includes:

- zero-based segment index;
- start, end, and duration in seconds;
- human-readable timestamp;
- cleaned text;
- a direct YouTube URL with the timestamp.

`youtube_transcript_search` adds surrounding segments and paginated matches, so an agent can cite evidence without retrieving an entire transcript.

### Quota-aware official access

The server tracks ordinary Data API operations and `search.list` calls separately. It lists channel uploads via the channel's uploads playlist instead of search. The ledger is deliberately conservative and process-local: it cannot observe calls from other applications sharing the same Google Cloud project.

### Bounded responses

Transcript pages, searches, playlists, comments, channel uploads, and trending results all have explicit limits and continuation tokens or offsets. “Unlimited retrieval” should be implemented as persistent local collection plus search, not as one enormous MCP response.

### Official and unofficial boundaries

- Official Data API access is isolated in `YouTubeDataApiClient`.
- Public transcript providers are isolated behind `TranscriptProvider`.
- Results report which provider supplied the data.
- No browser cookies, watch history, media downloading, or hidden account access are enabled.
- Write tools are intentionally absent from the initial release.

## Development

```bash
npm run dev         # stdio server from TypeScript
npm run dev:http    # authenticated HTTP server from TypeScript
npm run typecheck
npm test
npm run check       # typecheck + tests + production build
npm run build
npm start           # compiled stdio server
npm run start:http  # compiled HTTP server
```

HTTP development requires at least:

```powershell
$env:MCP_ACCESS_TOKEN = "replace-with-at-least-32-random-characters"
npm run dev:http
```

Current automated coverage includes URL/ID parsing, time formats, JSON3 and WebVTT caption parsing, transcript evidence search, pagination, quota guards, runtime configuration, bearer authentication, signed Google OAuth state/token exchange, and a real MCP client exchange over Streamable HTTP.

A live integration check was also performed against a captioned public lecture video. The direct YouTube player caption-track provider returned 286 timestamped English segments after the higher-level transcript endpoint failed, validating the intended fallback architecture.

## Known limits

- `yt-dlp` is optional for local installs; the Cloud Run Docker image installs it in an isolated Python environment. YouTube.js direct caption tracks remain the fallback.
- Comment replies embedded in `commentThreads.list` can be partial. Dedicated reply pagination belongs in the comment-corpus milestone.
- Channel names and old custom `/c/` URLs may use a first-result channel search and should be treated as a resolution guess; IDs and handles are deterministic.
- The quota ledger resets with the process and does not query the Google Cloud Console.
- Remote HTTP is deliberately stateless. Cache and quota guards are process-local, so the supplied Cloud Run deployment caps the service at one instance.
- Remote MCP client authentication currently uses a fixed bearer token, not a complete MCP OAuth authorization server. The client must support a custom Authorization header.
- Google OAuth authorization-code bootstrap and refresh-token storage are implemented, but current tools do not consume the refresh token yet.
- OAuth creator/account tools and YouTube Analytics/Reporting are not implemented yet.

## Documents

- [`docs/CLOUD_RUN.md`](docs/CLOUD_RUN.md) — remote deployment, exact OAuth URIs, secrets, security, verification, and troubleshooting
- [`docs/RESEARCH.md`](docs/RESEARCH.md) — surveyed MCP servers, APIs, policies, and ideas worth borrowing
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — provider boundaries and data flow
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — staged path toward the full AIO server

## Policy and licensing note

The repository code is MIT licensed. YouTube's APIs, website, captions, and third-party datasets remain governed by their own terms. Unofficial provider use can be fragile and may be unsuitable for some deployments. SponsorBlock is deliberately not bundled into the core because its database/API licensing has non-commercial share-alike conditions unless separate permission is obtained.
