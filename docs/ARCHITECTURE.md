# Architecture

## Goals

1. Keep the MCP tool surface small, stable, and understandable.
2. Separate official YouTube APIs from unofficial public-data providers.
3. Return bounded, citation-ready evidence rather than giant raw payloads.
4. Allow provider replacement without changing tool names.
5. Make quota, authentication, provenance, and policy constraints visible.
6. Grow into creator Analytics/Reporting and large local research corpora without rewriting the core.

## Current v0.2 topology

```text
Local MCP client                          Remote MCP client
       |                                        |
       | stdio                                  | HTTPS + Bearer token
       v                                        v
serveStdio()                         Cloud Run / Node HTTP server
       |                               |--> Host + Origin guards
       |                               |--> request byte/time limits
       |                               |--> /healthz
       |                               '--> /mcp
       |                                        |
       '--------------------|-------------------'
                            v
                  createYoutubeMcpServer()
                            |
                            v
                     YouTubeService
          |-------------------------------------|
          |                                     |
          v                                     v
Official public data                         Public transcript chain
YouTubeDataApiClient                         TranscriptProviderChain
  |                                            |--> yt-dlp provider
  |                                            |--> YouTube.js provider
  |                                                  |--> ANDROID caption tracks
  |                                                  |--> IOS caption tracks
  |                                                  |--> WEB caption tracks
  |                                                  '--> transcript fallback
  |--> videos/search/channels/playlists/comments
  '--> QuotaLedger

No-key video metadata
  '--> YouTube oEmbed

Optional upstream account authorization
  /oauth/google/setup
        | protected by GOOGLE_OAUTH_SETUP_TOKEN
        v
  Google authorization-code flow
        | HMAC-signed expiring state
        v
  /oauth/google/callback
        '--> operator moves refresh token to Secret Manager

Shared per-process infrastructure
  |--> URL and ID normalization
  |--> JSON3/WebVTT transcript parsing
  |--> timestamp citation URLs
  |--> transcript search and context windows
  '--> in-memory TTL cache with in-flight request coalescing
```

## Layer responsibilities

### `src/server.ts`

- Owns public MCP names and Zod input schemas.
- Describes prerequisites and pagination to the model.
- Marks all current tools read-only and idempotent.
- Converts domain errors into MCP `isError` results.
- Does not contain YouTube request logic.

### `src/youtube-service.ts`

- Resolves IDs and URLs.
- Chooses official, no-key, or unofficial paths according to configuration.
- Applies caches and provider chains.
- Shapes paginated transcript/search results.
- Enforces the Data API capability boundary.

### Official Data API provider

`src/providers/youtube-data-api.ts` uses direct `fetch` rather than a large generated Google client dependency. It:

- validates and serializes query parameters;
- enforces timeouts and bounded retries;
- consumes local quota before each actual network attempt;
- normalizes videos, channels, playlists, comments, and charts;
- resolves channel handles deterministically where possible;
- uses channel uploads playlists instead of search for channel archives.

### Transcript providers

Every provider implements:

```ts
interface TranscriptProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  fetchTranscript(request: TranscriptRequest): Promise<TranscriptDocument>;
}
```

`TranscriptDocument` is provider-neutral. A tool never needs to know whether segments came from `yt-dlp`, YouTube.js, an owned-video OAuth caption track, a paid transcript service, or a future browser worker.

### YouTube.js direct caption tracks

The live test exposed a useful failure mode: YouTube.js's higher-level `getTranscript()` endpoint returned HTTP 400, while an ANDROID player response still contained caption tracks. The provider therefore tries player clients and direct tracks before relying on the higher-level endpoint.

Current order:

1. ANDROID basic player info;
2. IOS basic player info;
3. WEB basic player info;
4. full info plus `getTranscript()`;
5. direct caption track from the full info, if present.

Direct tracks prefer JSON3 and fall back to WebVTT.

## Core data contracts

### Transcript segment

```ts
interface TranscriptSegment {
  index: number;
  startSeconds: number;
  durationSeconds: number;
  endSeconds: number;
  timestamp: string;
  text: string;
  url: string;
}
```

The URL is part of the normalized record so evidence can be cited without reconstructing timestamps downstream.

### Provider provenance

Transcript documents include:

- `provider`;
- selected `language`;
- `availableLanguages`;
- whether the track appears auto-generated;
- warnings;
- total duration and segments.

Official metadata records also carry a provider/completeness marker.

### Pagination

Two pagination styles are intentionally supported:

- official APIs: opaque `nextPageToken`;
- local transcript arrays: numeric `nextOffset`.

Clients must treat both as opaque continuation values returned by the previous call.

## Failure model

Domain failures use `YouTubeMcpError` with a stable machine-readable code, human message, and optional details.

Examples:

- `INVALID_VIDEO_REFERENCE`
- `YOUTUBE_API_KEY_REQUIRED`
- `LOCAL_QUOTA_GUARD`
- `VIDEO_NOT_FOUND`
- `TRANSCRIPT_UNAVAILABLE`
- `CAPTION_TRACK_REQUEST_FAILED`

The MCP layer returns these as `isError: true` JSON rather than throwing across the transport.

Transcript-provider attempts are aggregated. This allows a client or operator to distinguish:

- executable missing;
- video has no captions;
- endpoint/parser changed;
- region/network failure;
- every provider failed.

## Cache model

The v0.2 cache is process-local and TTL-based.

Properties:

- default TTL: 15 minutes;
- separate keys for video metadata and transcript language;
- concurrent identical loads share one in-flight promise;
- no data survives process restart;
- no account or OAuth data is stored.

The future persistent cache/corpus layer must add source timestamps, policy classes, refresh deadlines, and deletion paths.

## Quota model

`QuotaLedger` has two counters:

```text
ordinary Data API calls
search.list calls
```

Each real attempt, including a retry, consumes the relevant local counter before the request. This mirrors the fact that failed requests may still consume remote quota.

The ledger is a safety guard, not authoritative billing:

- it resets when the process restarts;
- it cannot see other apps using the same Google project;
- it does not currently query Google Cloud quota endpoints.

A persistent deployment should store counters in SQLite or another transactional store.

## Planned persistent corpus layer

The next major architecture addition is local SQLite with FTS5.

Proposed tables:

```text
sources
  id, source_type, youtube_id, url, provider, retrieved_at,
  refresh_after, policy_class, metadata_json

transcript_segments
  source_id, segment_index, start_ms, end_ms, language,
  generated, text

comment_threads
  source_id, thread_id, parent_comment_id, author_channel_id,
  published_at, updated_at, like_count, text

collection_jobs
  id, kind, input_json, cursor_json, status, created_at,
  updated_at, error_json

collections
  id, title, description, created_at

collection_sources
  collection_id, source_id
```

FTS indexes should cover transcript and comment text. Retrieval tools then become:

- create/resume/status/cancel collection job;
- search corpus;
- sample comments;
- aggregate authors, dates, sentiment labels, terms, and engagement;
- create bounded evidence packs;
- delete or refresh a source/collection.

## Authentication boundaries

v0.2 has three deliberately separate credential classes:

```text
MCP_ACCESS_TOKEN
  downstream client -> this MCP server
  protects /mcp

YOUTUBE_API_KEY
  this server -> public YouTube Data API
  enables public search, channels, comments, playlists, and charts

Google OAuth refresh token
  this server -> Google APIs on behalf of a YouTube account
  reserved for future account-scoped and Analytics tools
```

The Google OAuth bootstrap is a server-side Web Application flow. It uses a fixed HTTPS callback derived from `PUBLIC_BASE_URL`, a protected setup-start route, HMAC-signed expiring `state`, and a token exchange that never places access tokens in URLs. The callback does not persist credentials to the ephemeral container filesystem; the operator moves the refresh token into Secret Manager.

The current Google grant is configuration groundwork only. Account-scoped MCP tools and automatic refresh-token use remain future work.

Write tools should have explicit risk annotations and be disabled by default. Delete, publish, moderation, and account-scoped operations should never be mixed into generic read handlers.

## Streamable HTTP boundary

Remote mode is implemented as stateless Streamable HTTP through the MCP TypeScript SDK v2 handler and Node adapter.

Implemented controls:

- startup fails closed unless a bearer token exists or unauthenticated mode is explicitly selected;
- constant-time checked fixed bearer token on `/mcp`;
- exact Host allowlist support;
- rejection of unapproved browser `Origin` values;
- bounded JSON request bodies;
- aligned Node and Cloud Run request timeouts;
- CORS preflight only for explicit origins;
- public health and metadata endpoints that do not expose secrets;
- graceful Cloud Run termination;
- `.gcloudignore` and `.dockerignore` secret exclusions;
- API/OAuth secrets injected from Secret Manager.

The deployment remains stateless at the MCP transport layer. A shared `YouTubeService` instance preserves cache and quota state across requests within one container process, and the supplied Cloud Run profile caps maximum instances at one to avoid divergent in-memory counters.

The fixed bearer token is not a complete standards-based MCP OAuth authorization server. Clients must support a custom Authorization header. Production multi-user deployment still needs:

- MCP-native authorization-server and protected-resource metadata;
- per-user identities, scopes, rate limits, and audit logs;
- distributed quota/concurrency enforcement;
- persistent storage;
- bounded stateful sessions only where a feature requires them;
- structured telemetry without secrets.

## Non-goals for the default server

- downloading video or audio media;
- importing browser cookies silently;
- mutating watch history;
- bypassing private, members-only, paid, age, or geographic access controls;
- hiding the distinction between official and unofficial sources;
- generating summaries with an undisclosed third-party model;
- returning unlimited comments or transcripts in one response.
