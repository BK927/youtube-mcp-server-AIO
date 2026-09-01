# Roadmap

The target is an all-in-one YouTube research and creator MCP, staged so authentication, policy, persistence, and response-size risks do not become one tangled release.

## v0.1 — Read-only provider foundation

Status: **implemented**

- [x] TypeScript, Node.js 24+, MCP SDK v2
- [x] stdio transport
- [x] capability discovery tool
- [x] video URL/ID normalization
- [x] limited no-key oEmbed metadata
- [x] official Data API video metadata and search
- [x] channel resolution and upload-playlist retrieval
- [x] playlist metadata and items
- [x] public comment threads
- [x] regional most-popular chart
- [x] configurable process-local quota guards
- [x] transcript provider interface and ordered fallback chain
- [x] optional `yt-dlp` provider
- [x] YouTube.js multi-client direct caption-track provider
- [x] JSON3 and WebVTT parsing
- [x] transcript pagination and evidence search
- [x] in-memory TTL cache and in-flight request coalescing
- [x] official/unofficial/hybrid mode separation
- [x] MCP client handshake and tool-call tests
- [x] live English and Korean caption-track checks

Remaining release hygiene:

- [ ] Initialize Git repository and add remote metadata
- [ ] Add CI on supported Node versions
- [ ] Add lint/format configuration
- [ ] Test Japanese, translated-only, auto-generated, live, and no-caption videos
- [ ] Live-test API-key tools against a dedicated Google Cloud project
- [ ] Decide package publishing name and `repository` metadata

## v0.2 — Remote Cloud Run foundation

Status: **implemented, deployment not yet executed from this workstation**

- [x] retain local stdio mode
- [x] stateless Streamable HTTP `/mcp` endpoint
- [x] MCP SDK v2 fetch handler and Node adapter
- [x] fixed bearer-token authentication for private remote use
- [x] fail-closed startup when HTTP authentication is absent
- [x] Origin validation and exact Host allowlist support
- [x] CORS preflight and response headers
- [x] request-body and request-time limits
- [x] health and service-information endpoints
- [x] graceful SIGTERM/SIGINT shutdown
- [x] shared per-process service cache and quota ledger
- [x] Dockerfile with Node.js and isolated `yt-dlp`
- [x] `.dockerignore` and `.gcloudignore` secret exclusions
- [x] Cloud Run source-deployment PowerShell script
- [x] Secret Manager injection for API and access credentials
- [x] dedicated Cloud Run runtime service account
- [x] scale-to-zero and single-instance defaults
- [x] Google Web Application OAuth bootstrap endpoints
- [x] signed, expiring OAuth `state`
- [x] protected one-time OAuth setup route
- [x] refresh-token handoff into Secret Manager
- [x] end-to-end Streamable HTTP MCP client test
- [x] runtime, bearer, and OAuth unit tests
- [x] detailed Cloud Run deployment and URI guide

Known v0.2 boundaries:

- The bearer token is a pragmatic private-server mechanism, not a complete MCP OAuth authorization server.
- A remote client must support a fixed `Authorization: Bearer ...` header.
- Google OAuth currently prepares an upstream account grant; existing public-data tools do not consume the refresh token.
- The quota ledger, cache, and OAuth capability state are process-local; the supplied Cloud Run profile therefore caps instances at one.
- The Dockerfile and deployment scripts have passed TypeScript/tests and PowerShell parsing, but need a real Cloud Build/Cloud Run execution on an authenticated machine.

## v0.3 — Persistent research corpora

Goal: retrieve arbitrarily large datasets without overflowing MCP context.

- SQLite via Node's built-in `node:sqlite`
- FTS5 transcript and comment indexes
- source provenance and retrieval timestamps
- collection create/resume/status/cancel/delete tools
- channel transcript collection
- playlist transcript collection
- resumable comment collection
- dedicated reply pagination
- corpus search with filters and timestamp citations
- deterministic sampling by date, likes, replies, and author
- term frequency and n-gram statistics
- duplicate and near-duplicate comment detection
- bounded evidence-pack output
- refresh/deletion policy metadata
- persistent quota counters
- Cloud Run persistence adapter: Cloud SQL, object storage, or another managed store

Candidate high-level tools:

```text
youtube_collection_create
youtube_collection_status
youtube_collection_resume
youtube_collection_delete
youtube_corpus_search
youtube_corpus_sample
youtube_corpus_stats
youtube_evidence_pack
```

Do not expose one tool per SQL query. Keep the corpus contract provider-neutral.

## v0.4 — Research intelligence

Goal: reproduce the strongest ideas from evidence-first YouTube research MCPs without forcing another model API.

- semantic transcript chunks
- chapter and description timeline extraction
- cross-video claim/evidence comparison
- selected and excluded evidence records
- contradiction and disagreement candidates
- channel topic map
- upload cadence and format analysis
- performance outlier detection
- competitor/channel comparison
- comment-theme clustering substrate
- learning-path and flashcard evidence exports
- content-repurposing source packs

Default behavior should provide source material to the host LLM. Optional embedding or model adapters must be explicit, configurable, and disclose cost/provider.

## v0.5 — MCP-native authorization and creator tools

Goal: account-scoped workflows with distinct upstream-Google and downstream-MCP trust boundaries.

- standards-based MCP OAuth resource-server authorization
- authorization-server metadata and protected-resource metadata
- per-user identities, scopes, quotas, and audit records
- replace or complement the single static bearer token
- encrypted database or external secret-store token adapter
- automatic access-token refresh using stored Google refresh grants
- Google token revocation and user-data deletion
- owned playlist create/update/delete
- comment reply/moderation operations
- video metadata update
- thumbnail update
- resumable upload workflow
- owned-video caption list/download/upload/update/delete
- subscriptions and account-scoped reads where policy permits
- explicit write-enable flag
- destructive-operation confirmation strategy

Writes remain disabled by default. Account cookies are not a substitute for OAuth.

## v0.6 — YouTube Analytics and Reporting

Goal: creator/channel intelligence unavailable through public APIs.

- Analytics targeted query builder
- saved query templates
- audience retention
- traffic sources
- geography and device dimensions
- subscriber gain/loss
- revenue metrics when authorized
- Reporting API job creation and polling
- bulk report download and normalization
- persistent report tables and comparisons
- metric/dimension compatibility validation
- date-range and timezone normalization

Candidate tools:

```text
youtube_analytics_query
youtube_analytics_retention
youtube_analytics_compare
youtube_reporting_job_create
youtube_reporting_job_status
youtube_reporting_import
youtube_reporting_search
```

## v0.7 — Optional providers and production operations

Each adapter must have an explicit license, policy, cost, and failure profile.

Possible work:

- SponsorBlock segments, opt-in and separately license-documented
- most-replayed heatmaps
- browser-worker transcript fallback
- paid transcript providers
- proxy provider for environments with blocked data-center IPs
- external vector database
- external object storage for bulk reports
- optional embeddings and rerankers
- structured logs and OpenTelemetry
- distributed rate and concurrency limits
- bounded stateful/resumable MCP sessions
- deployment recipes beyond Google Cloud Run
- automated secret rotation and backup/restore drills

## Tool-surface rule

New implementation capability does not automatically justify a new MCP tool. Prefer:

1. adding a filter or mode to an existing coherent tool;
2. putting low-level operations behind a job or collection abstraction;
3. exposing capability discovery rather than silently changing behavior;
4. returning continuation handles instead of huge payloads;
5. keeping destructive/account-scoped tools in a visibly separate namespace or process.

The target is a powerful AIO server that remains easy for an agent to select correctly—not a catalog of every underlying API endpoint.
