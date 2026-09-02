# YouTube MCP Landscape Research

Survey date: **2026-08-29**

This document records the projects and official interfaces reviewed before creating the v0.1 architecture. It is a design survey, not an endorsement or a claim that every repository is production-ready.

## Representative open-source MCP servers

| Project | Notable ideas | What this project borrows or changes |
| --- | --- | --- |
| [`pauling-ai/youtube-mcp-server`](https://github.com/pauling-ai/youtube-mcp-server) | Roughly forty tools spanning Data API, Analytics, Reporting, publishing, playlists, comments, transcripts, SEO, and quota tracking | Confirms the long-term AIO scope. This project avoids exposing every low-level operation at once and starts with a smaller stable read-only surface. |
| [`wynandw87/claude-code-youtube-mcp`](https://github.com/wynandw87/claude-code-youtube-mcp) | Search, metadata, channels, playlists, comments, trending, engagement, chapters, SponsorBlock, most-replayed, and transcripts | Broad public-data feature checklist. SponsorBlock stays optional and outside the MIT core because of its separate database/API license. |
| [`fabioc-aloha/youtube-mcp-tools`](https://github.com/fabioc-aloha/youtube-mcp-tools) | Evidence-first research, timestamp citations, selected/excluded evidence, semantic chunking, cross-video synthesis, learning paths, and content repurposing | Strongest inspiration for transcript evidence and future corpus workflows. This project keeps model generation host-side and focuses the server on retrieval, normalization, indexing, and evidence packaging. |
| [`glonorce/youtube_mcp`](https://github.com/glonorce/youtube_mcp) | Channel resolution, uploads, playlists, keyword search, comments, video/transcript lookup, and quota-aware defaults | Reinforces uploads-playlist traversal and safe pagination rather than repeated channel searches. |
| [`mrsknetwork/ytmcp`](https://github.com/mrsknetwork/ytmcp) | Clear tiers: guest/`yt-dlp`, API-key public data, and OAuth account/member access | Direct inspiration for explicit capability modes and provider reporting. |
| [`kirbah/mcp-youtube`](https://github.com/kirbah/mcp-youtube) | Token-conscious structured results, validation, and a persistent MongoDB cache to save quota | This project uses bounded normalized responses now and plans local SQLite/FTS rather than requiring an external database. |
| [`coyaSONG/youtube-mcp-server`](https://github.com/coyaSONG/youtube-mcp-server) | Exact timestamp links, transcript search with windows and pagination, cross-video evidence, plus bearer/CORS/session controls for HTTP | Direct inspiration for citation-ready transcript search and the remote-security roadmap. |
| [`anaisbetts/mcp-youtube`](https://github.com/anaisbetts/mcp-youtube) | Minimal transcript MCP using `yt-dlp` | Useful baseline showing why `yt-dlp` should be one provider, not the entire architecture. |
| [`kimtaeyoon83/mcp-server-youtube-transcript`](https://github.com/kimtaeyoon83/mcp-server-youtube-transcript) | Focused transcript-only MCP | Confirms the demand for a zero-key path, while highlighting the need for metadata, evidence search, and provider fallbacks. |
| [`LuanRT/YouTube.js`](https://github.com/LuanRT/YouTube.js) | TypeScript client for YouTube's internal InnerTube API without a Data API key | Used as an unofficial provider. The implementation does not trust only `getTranscript()`; it also checks multiple player clients and reads caption-track URLs directly. |

## Specialized ideas found across the ecosystem

The survey also surfaced recurring or specialized features worth considering later:

- channel outlier detection and competitor benchmarking;
- sponsor and brand-mention databases;
- semantic transcript chunks and cross-video evidence synthesis;
- flashcards, quizzes, learning paths, and content repurposing;
- most-replayed heatmaps and chapters;
- hosted transcript services with payment or usage metering;
- creator upload/update/delete operations;
- subscriptions, members, and membership tiers;
- YouTube Analytics retention, traffic, audience, and revenue reports;
- YouTube Reporting bulk jobs for large channel datasets.

These should be layered over a common evidence and collection substrate instead of each becoming a disconnected MCP tool.

## Official interfaces and constraints

### MCP TypeScript SDK v2

The project uses the split stable v2 packages rather than the old monolithic v1 SDK:

- [`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server)
- [MCP TypeScript SDK repository](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28)

Version 1.1.1 supports both local stdio and stateless Streamable HTTP. Private remote access uses a fixed bearer while shared multi-user authorization remains outside this release.

### YouTube Data API quota model

Official quota reference:

- [Quota costs for YouTube Data API requests](https://developers.google.com/youtube/v3/determine_quota_cost)

The current model documented for June 1, 2026 separates some expensive operations into dedicated daily call buckets. In particular, `search.list` is tracked separately from ordinary Data API units. This project therefore does **not** encode the older folklore that every search costs 100 ordinary units. It keeps conservative, configurable process-local guards for:

- ordinary Data API requests; and
- `search.list` calls.

Every result page is another request. Invalid requests can still consume quota, so validation happens before network calls when possible.

### Captions API is not a public-transcript API

Official references:

- [`captions.list`](https://developers.google.com/youtube/v3/docs/captions/list)
- [`captions.download`](https://developers.google.com/youtube/v3/docs/captions/download)

The official captions endpoints require OAuth authorization, and downloading a caption track requires sufficient permission over the video. They therefore cannot replace unofficial transcript retrieval for arbitrary public videos. The future official captions provider is for owned or authorized channel content.

### Analytics and Reporting

Official references:

- [YouTube Analytics API](https://developers.google.com/youtube/analytics)
- [YouTube Reporting API](https://developers.google.com/youtube/reporting/v1/reports)

The Analytics API is suited to targeted queries over dimensions and metrics. The Reporting API is suited to scheduled bulk reports. Both require OAuth and should live in a separate creator/account capability group.

### Terms, retention, and deletion

Relevant official documents:

- [YouTube Terms of Service](https://www.youtube.com/static?template=terms)
- [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service)
- [YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies)

Architecture implications:

1. Official API data and unofficial extraction paths stay visibly separated.
2. Provider names and warnings are returned with results.
3. Official API caches use short TTLs rather than indefinite retention.
4. Persistent storage must record source, retrieval time, and deletion/refresh policy.
5. A future OAuth deployment needs user-data deletion and revocation handling.
6. Media downloading, browser-cookie account access, and watch-history mutation are not part of the default server.

### SponsorBlock licensing

SponsorBlock's server/API/database license is published separately:

- [SponsorBlock server license](https://github.com/ajayyy/SponsorBlockServer/blob/master/LICENSE)

Because the database/API carries non-commercial share-alike conditions unless separate permission is granted, SponsorBlock is not a core dependency. A future adapter must be opt-in, attributed, license-documented, and isolated from the MIT-licensed core.

## Consolidated product conclusions

### 1. “All-in-one” should mean one coherent substrate, not fifty exposed endpoints

A giant flat tool list makes tool selection harder for models and increases maintenance cost. High-level tools should remain stable while providers and official API calls can change underneath them.

### 2. Evidence is the product boundary

The server should return normalized facts, timestamps, source URLs, selected and excluded evidence, collection IDs, and pagination. Summaries and prose generation normally belong to the host model unless an explicit external model adapter is configured.

### 3. Large retrieval needs local corpora

Comments, channel archives, and multi-video transcripts cannot safely be returned in one MCP response. The correct path is:

1. collect pages into a local corpus;
2. store source and retrieval metadata;
3. index text locally;
4. query, filter, sample, and aggregate;
5. return bounded evidence packs.

### 4. Provider chains are mandatory for public transcripts

All unofficial transcript approaches can break independently through parser changes, endpoint changes, bot checks, PO-token requirements, IP reputation, geography, or caption availability. The server therefore treats `yt-dlp`, YouTube.js caption tracks, and future adapters as interchangeable providers with explicit attempts and fallbacks.

### 5. Writes and account data deserve a separate trust boundary

Publishing, editing, deleting, moderating, subscriptions, memberships, Analytics, and Reporting should require explicit OAuth scopes and configuration. They should not silently appear just because a read-only API key exists.
