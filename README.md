# YouTube MCP AIO

YouTube MCP AIO 1.1.1 is a read-only research server with four task-oriented tools. The small surface is deliberate: video metadata, transcripts, comments, search, channels, playlists, and trending data are exposed through coherent views instead of many low-level API tools.

It supports local stdio and Google Cloud Run Streamable HTTP. Steam remains a separate plugin and service so YouTube schemas are absent when they are irrelevant.

## Public tool surface

| Tool | Views/scopes |
| --- | --- |
| `youtube_video_get` | One video's `metadata`, paged `transcript`, or paged `comments`; replies are opt-in and bounded by `reply_limit` |
| `youtube_search` | `global`, `channel`, `transcript`, or `trending` search |
| `youtube_channel_get` | Profile, statistics, branding, and uploads-playlist selections |
| `youtube_playlist_get` | Playlist metadata and a signed page of items |

All tools are read-only and idempotent. Responses share a bounded envelope with provider provenance, quota cost, freshness, warnings, untrusted-field markers, and opaque signed cursors. The default result budget is 12,288 bytes, the hard maximum is 32,768 bytes, and cursors expire after 86,400 seconds. Transcript pages return only `availableLanguageCount` by default; set `options.include_available_languages=true` to include the full language list on page one without repeating it on cursor pages. Channel-controlled titles are marked untrusted in video, search, and playlist responses.

## Providers

- The YouTube Data API v3 supplies official public video, search, channel, playlist, comment, and trending data when `YOUTUBE_API_KEY` is configured.
- `yt-dlp` and YouTube.js form the public transcript fallback chain. Cloud Run adds a pinned local PO-token sidecar for `yt-dlp`; no account cookies are used.
- No Google account OAuth bootstrap or account-scoped write route is included in 1.1.0.

Provider modes:

- `hybrid` (default): official public data plus transcript fallbacks;
- `official`: Data API only;
- `unofficial`: no-key transcript and limited metadata paths only.

## Local stdio

Node.js 24 or newer is required. `yt-dlp` is optional locally.

```powershell
npm ci
npm run build
npm start
```

Generic MCP client configuration:

```json
{
  "mcpServers": {
    "youtube-mcp-aio": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/absolute/path/youtube-mcp-server-AIO/dist/index.js", "--stdio"],
      "env": {
        "YOUTUBE_API_KEY": "OPTIONAL_RESTRICTED_API_KEY"
      }
    }
  }
}
```

## Google Cloud Run

The cloud profile is one public Cloud Run service with an ingress MCP container and a private localhost-only PO-token sidecar. `/mcp` is bearer- or OAuth-protected and `/health` is public. Local HTTP defaults remain on `/healthz`. Firestore makes daily quota guards and one-time OAuth codes consistent across requests, restarts, and up to two instances; the MCP transport remains stateless.

```powershell
pwsh -File .\scripts\provision-gcp.ps1 -ProjectId "YOUR_PROJECT_ID"
pwsh -File .\scripts\deploy-cloud-run.ps1 -ProjectId "YOUR_PROJECT_ID" -Promote
```

Deployment requires a clean Git worktree. It builds a full Git SHA tag, resolves the Artifact Registry digest, creates a tagged zero-traffic candidate, checks `/health`, OAuth discovery, bearer rejection, the exact four-tool contract, a multi-video transcript matrix, bounded comments/replies, and locale-region inference, and promotes only with `-Promote`. ChatGPT uses Authorization Code + PKCE with a private personal access key; Codex can continue using the existing bearer. See [docs/CLOUD_RUN.md](docs/CLOUD_RUN.md).

Remote plugin configuration lives in `.mcp.json` and currently targets the Raspberry Pi deployment. `scripts/sync-codex-plugin.ps1` can build local or remote plugin profiles, but changes the user's plugin installation and is not part of CI or deployment. The Cloud Run deployment remains documented as an optional rollback or alternative hosting target.

Hosts that implement OpenAI [Tool Search](https://developers.openai.com/api/docs/guides/tools-tool-search) can defer this server's definitions until YouTube work is actually selected. Enable `tool_search` and mark the MCP tool as `defer_loading` in the host/API tool configuration; do not add `defer_loading` to this plugin's `.mcp.json`, which follows the [Codex plugin packaging contract](https://developers.openai.com/plugins/build/plugins).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | empty | Enables official public Data API operations |
| `YOUTUBE_PROVIDER_MODE` | `hybrid` | `hybrid`, `official`, or `unofficial` |
| `YOUTUBE_TRANSCRIPT_PROVIDERS` | `yt-dlp,youtubejs` | Transcript fallback order |
| `YT_DLP_PATH` | `yt-dlp` | Local executable; image uses `/opt/yt-dlp/bin/yt-dlp` |
| `YT_DLP_POT_PROVIDER_ENABLED` | `false` | Use the localhost PO-token provider; Cloud Run sets this with its pinned sidecar |
| `YOUTUBE_DEFAULT_REGION` | `US` | Default trending region when neither `filters.region` nor a locale region is present |
| `YOUTUBE_DEFAULT_LANGUAGE` | `en` | Preferred transcript/result language |
| `YOUTUBE_CACHE_TTL_SECONDS` | `900` | Bounded process-local cache freshness |
| `YOUTUBE_API_DAILY_BUDGET` | `9000` | Conservative ordinary Data API guard |
| `YOUTUBE_SEARCH_DAILY_BUDGET` | `90` | Conservative search-call guard |
| `YOUTUBE_QUOTA_STORE` | `memory` | Cloud deployment sets `firestore` |
| `GOOGLE_CLOUD_PROJECT` | empty | Required by the Firestore quota adapter |
| `YOUTUBE_CURSOR_SECRET` | bearer fallback | Cursor-signing secret |
| `YOUTUBE_CURSOR_TTL_SECONDS` | `86400` | Cursor validity |
| `YOUTUBE_MAX_RESULT_BYTES` | `12288` | Default result limit; hard maximum 32,768 |
| `MCP_TRANSPORT` | auto | stdio locally, HTTP on Cloud Run; CLI flag wins |
| `MCP_PATH` | `/mcp` | Streamable HTTP path |
| `HEALTH_PATH` | `/healthz` locally; `/health` on Cloud Run | Public health path |
| `HTTP_MAX_BODY_BYTES` | `2097152` | Maximum request body (2 MiB) |
| `HTTP_REQUEST_TIMEOUT_MS` | `300000` | Node request timeout aligned with Cloud Run |
| `MCP_ACCESS_TOKEN` | empty | Required fixed bearer in HTTP mode |
| `MCP_OAUTH_ENABLED` | `false` | Enable personal ChatGPT OAuth 2.1 endpoints |
| `MCP_OAUTH_LOGIN_SECRET` | empty | Private key entered only on the hosted authorization page |
| `MCP_OAUTH_SIGNING_SECRET` | empty | Signs audience-bound access and refresh tokens |
| `MCP_OAUTH_STORE` | `memory` | Cloud deployment uses Firestore for one-time codes |
| `PUBLIC_BASE_URL` | empty | Stable HTTPS URL used for Host validation |
| `MCP_ALLOWED_HOSTS` | empty | Additional exact candidate/stable hosts |

See [.env.example](.env.example) for the complete local template.

## Security and policy

- Browser Origin and Host are exact-allowlisted in HTTP mode.
- YouTube titles, descriptions, comments, and transcripts are marked as untrusted content.
- API and bearer secrets are injected by service-specific Secret Manager IAM bindings at numeric versions.
- The existing fixed bearer and personal OAuth 2.1 flow are for one private operator. OAuth accepts only ChatGPT client metadata URLs, requires PKCE S256 and the exact MCP audience, and is not a shared multi-user identity system.
- The default server does not upload/download media, use browser cookies, modify watch history, or perform account writes.
- `locale` only supplies a trending region when it contains an explicit region subtag such as `ko-KR`; `filters.region` always wins.

## Development

```powershell
npm ci
npm run check
```

Plugin routing fixtures under `docs/evals` are review artifacts. They have not been executed against newly created Codex tasks.

## Documents

- [Cloud Run operations](docs/CLOUD_RUN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Migration milestones](docs/ROADMAP.md)
- [Ecosystem research](docs/RESEARCH.md)

MIT License. See [LICENSE](LICENSE).
