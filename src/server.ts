import {
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { loadConfig } from "./config.js";
import { CursorCodec } from "./cursor.js";
import { YouTubeMcpError } from "./errors.js";
import { SERVER_NAME, SERVER_VERSION } from "./meta.js";
import { runTool, type ToolPayload } from "./mcp-response.js";
import type { AppConfig } from "./types.js";
import {
  extractPlaylistId,
  extractVideoId,
} from "./utils/ids.js";
import {
  YouTubeService,
  type ServiceRuntimeInfo,
} from "./youtube-service.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const oauthMeta = {
  securitySchemes: [{ type: "oauth2", scopes: ["youtube.read"] }],
};

const cursorSchema = z.string().min(1).optional();
const limitSchema = z.number().int().min(1).max(100).default(10);
const filtersSchema = z.record(z.string(), z.unknown()).default({});

const TOOL_SCHEMAS: Record<string, unknown> = {
  youtube_video_get: {
    required: ["video"],
    fields: {
      video: "YouTube video ID or URL",
      view: ["metadata", "transcript", "comments"],
      options: {
        transcript: ["language", "include_text", "include_timestamps"],
        comments: ["order", "include_replies"],
      },
      cursor: "opaque signed cursor",
      limit: "1..100",
      max_chars: "256..12000",
      locale: "preferred language code",
    },
  },
  youtube_search: {
    fields: {
      scope: ["global", "channel", "transcript", "trending"],
      query: "required for global/transcript; optional for channel",
      within: "channel for channel scope; video for transcript scope",
      filters: "scope-specific filter object",
      cursor: "opaque signed cursor",
      limit: "1..100",
      locale: "preferred language code",
    },
  },
  youtube_channel_get: {
    required: ["channel"],
    fields: {
      channel: "channel ID, @handle, URL, username, or name",
      select: ["profile", "statistics", "branding", "uploads_playlist"],
    },
  },
  youtube_playlist_get: {
    required: ["playlist"],
    fields: {
      playlist: "playlist ID or URL",
      include_items: "include one signed item page",
      cursor: "opaque signed cursor",
      limit: "1..100",
    },
  },
  error: {
    fields: ["code", "message", "retryable", "schema_uri", "details"],
  },
};

export interface CreateYoutubeMcpServerOptions {
  service?: YouTubeService;
  runtime?: ServiceRuntimeInfo;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireArgument(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized) return normalized;
  throw new YouTubeMcpError(
    "INVALID_ARGUMENT",
    `${name} is required for this operation.`,
    { name },
  );
}

function assertNoArgument(value: string, name: string): void {
  if (!value.trim()) return;
  throw new YouTubeMcpError(
    "INVALID_ARGUMENT",
    `${name} is not accepted for this scope.`,
    { name },
  );
}

function checkedFilters(
  filters: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> {
  const unexpected = Object.keys(filters).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new YouTubeMcpError(
      "INVALID_ARGUMENT",
      "One or more filters are not supported for this view or scope.",
      { unexpected, allowed },
    );
  }
  return filters;
}

function stringFilter(
  filters: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = filters[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new YouTubeMcpError("INVALID_ARGUMENT", `${key} must be a string.`);
  }
  return value.trim() || undefined;
}

function booleanFilter(
  filters: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = filters[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new YouTubeMcpError("INVALID_ARGUMENT", `${key} must be a boolean.`);
  }
  return value;
}

function integerFilter(
  filters: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = filters[key];
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new YouTubeMcpError(
      "INVALID_ARGUMENT",
      `${key} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function enumFilter<const T extends string>(
  filters: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = filters[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new YouTubeMcpError(
      "INVALID_ARGUMENT",
      `${key} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value as T;
}

function timeFilter(
  filters: Record<string, unknown>,
  key: string,
): string | number | undefined {
  const value = filters[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new YouTubeMcpError(
      "INVALID_ARGUMENT",
      `${key} must be a timestamp string or seconds.`,
    );
  }
  return value;
}

function pageToken(
  codec: CursorCodec,
  cursor: string | undefined,
  operation: string,
  filters: Record<string, unknown>,
): string | undefined {
  if (!cursor) return undefined;
  const value = codec.decode(cursor, operation, filters).pageToken;
  if (typeof value !== "string" || !value) {
    throw new YouTubeMcpError("CURSOR_MISMATCH", "The cursor state is invalid.");
  }
  return value;
}

function offset(
  codec: CursorCodec,
  cursor: string | undefined,
  operation: string,
  filters: Record<string, unknown>,
): number {
  if (!cursor) return 0;
  const value = codec.decode(cursor, operation, filters).offset;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new YouTubeMcpError("CURSOR_MISMATCH", "The cursor state is invalid.");
  }
  return value;
}

function nextCursor(
  codec: CursorCodec,
  operation: string,
  filters: Record<string, unknown>,
  state: Record<string, unknown> | undefined,
): string | null {
  return state ? codec.encode(operation, filters, state) : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function provider(value: Record<string, unknown>): string | null {
  return typeof value.provider === "string" ? value.provider : null;
}

function without(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

function capPayloadText(
  data: unknown,
  items: unknown[],
  maxChars: number,
): { data: unknown; items: unknown[] } {
  let remaining = maxChars;
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") {
      if (remaining <= 0) return "";
      const capped = item.slice(0, remaining);
      remaining -= capped.length;
      return capped.length < item.length && capped.length >= 3
        ? `${capped.slice(0, -3)}...`
        : capped;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).map(([key, child]) => [
        key,
        visit(child),
      ]),
    );
  };
  return {
    data: visit(data),
    items: visit(items) as unknown[],
  };
}

type ChannelSelection =
  | "profile"
  | "statistics"
  | "branding"
  | "uploads_playlist";

function selectChannel(
  channel: Record<string, unknown>,
  select: ChannelSelection[],
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (select.includes("profile")) {
    for (const key of [
      "id",
      "url",
      "title",
      "description",
      "customUrl",
      "publishedAt",
      "country",
      "defaultLanguage",
      "thumbnails",
      "provider",
      "resolution",
    ]) {
      if (key in channel) output[key] = channel[key];
    }
  }
  if (select.includes("statistics")) output.statistics = channel.statistics ?? {};
  if (select.includes("branding")) {
    output.brandingSettings = channel.brandingSettings ?? {};
  }
  if (select.includes("uploads_playlist")) {
    output.uploadsPlaylistId = channel.uploadsPlaylistId ?? null;
  }
  return output;
}

function freshUntil(config: AppConfig): string {
  return new Date(Date.now() + config.cacheTtlMs).toISOString();
}

function payload(
  kind: ToolPayload["kind"],
  data: unknown,
  items: unknown[],
  cursor: string | null,
  canonicalUri: string | null,
  sourceRecord: Record<string, unknown>,
  quotaCost: { data: number; search: number },
  untrustedFields: string[],
  config: AppConfig,
  maxChars?: number,
): ToolPayload {
  const capped =
    maxChars === undefined
      ? { data, items }
      : capPayloadText(data, items, maxChars);
  return {
    kind,
    data: capped.data,
    items: capped.items,
    page: {
      returned: items.length,
      has_more: Boolean(cursor),
      next_cursor: cursor,
    },
    meta: {
      canonical_uri: canonicalUri,
      source: "youtube",
      provider: provider(sourceRecord) ?? "unknown",
      fresh_until: freshUntil(config),
      quota_cost: quotaCost,
      warnings: stringArray(sourceRecord.warnings),
      untrusted_fields: untrustedFields,
    },
  };
}

function templateVariable(
  variables: Record<string, string | string[]>,
  name: string,
): string {
  const value = variables[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function jsonResource(uri: URL, value: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(value),
      },
    ],
  };
}

export function createYoutubeMcpServer(
  config: AppConfig = loadConfig(),
  options: CreateYoutubeMcpServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read-only YouTube research. Use catalog resources for capabilities and schemas.",
    },
  );
  const service = options.service ?? new YouTubeService(config);
  const codec = new CursorCodec(config.cursorSecret, config.cursorTtlMs);

  server.registerTool(
    "youtube_video_get",
    {
      description: "Get one video's metadata, transcript page, or comments page.",
      inputSchema: z.object({
        video: z.string().min(1),
        view: z.enum(["metadata", "transcript", "comments"]).default("metadata"),
        options: filtersSchema,
        cursor: cursorSchema,
        limit: limitSchema,
        max_chars: z.number().int().min(256).max(12_000).default(4_000),
        locale: z.string().default(""),
      }),
      annotations: readOnlyAnnotations,
      _meta: oauthMeta,
    },
    async ({ video, view, options, cursor, limit, max_chars: maxChars, locale }) =>
      runTool("youtube_video_get", async () => {
        const videoId = extractVideoId(video);
        const canonicalUri = `youtube://entity/video/${videoId}`;
        if (view === "metadata") {
          checkedFilters(options, []);
          if (cursor) {
            throw new YouTubeMcpError(
              "INVALID_ARGUMENT",
              "metadata view does not use a cursor.",
            );
          }
          const result = await service.getVideo(videoId);
          return payload(
            "entity",
            without(result, ["warnings"]),
            [],
            null,
            canonicalUri,
            result,
            { data: provider(result) === "youtube-data-api-v3" ? 1 : 0, search: 0 },
            ["data.title", "data.description", "data.tags"],
            config,
            maxChars,
          );
        }

        if (view === "transcript") {
          const normalized = checkedFilters(options, [
            "language",
            "include_text",
            "include_timestamps",
          ]);
          const language =
            (stringFilter(normalized, "language") ?? locale.trim()) || undefined;
          const includeText = booleanFilter(normalized, "include_text", false);
          const includeTimestamps = booleanFilter(
            normalized,
            "include_timestamps",
            true,
          );
          const cursorFilters = {
            videoId,
            view,
            language: language ?? null,
            includeText,
            includeTimestamps,
          };
          const result = await service.getTranscript(videoId, {
            language,
            offset: offset(codec, cursor, "youtube_video_get", cursorFilters),
            limit,
            includeText,
            includeTimestamps,
          });
          const resultRecord = record(result);
          const next =
            result.nextOffset === undefined
              ? null
              : nextCursor(codec, "youtube_video_get", cursorFilters, {
                  offset: result.nextOffset,
                });
          return payload(
            "collection",
            without(resultRecord, ["segments", "nextOffset", "warnings"]),
            result.segments,
            next,
            canonicalUri,
            resultRecord,
            { data: 0, search: 0 },
            ["items[].text", "data.text"],
            config,
            maxChars,
          );
        }

        const normalized = checkedFilters(options, ["order", "include_replies"]);
        const order = enumFilter(normalized, "order", ["relevance", "time"], "relevance");
        const includeReplies = booleanFilter(normalized, "include_replies", true);
        const cursorFilters = { videoId, view, order, includeReplies };
        const result = await service.listComments(
          videoId,
          limit,
          pageToken(codec, cursor, "youtube_video_get", cursorFilters),
          order,
          includeReplies,
        );
        const items = Array.isArray(result.items) ? result.items : [];
        const next =
          typeof result.nextPageToken === "string"
            ? nextCursor(codec, "youtube_video_get", cursorFilters, {
                pageToken: result.nextPageToken,
              })
            : null;
        return payload(
          "collection",
          without(result, ["items", "nextPageToken", "prevPageToken", "warnings"]),
          items,
          next,
          canonicalUri,
          result,
          { data: 1, search: 0 },
          ["items[].author.name", "items[].topLevelComment.text", "items[].replies[].text"],
          config,
          maxChars,
        );
      }, config.maxResultBytes),
  );

  server.registerTool(
    "youtube_search",
    {
      description: "Search globally, within a channel or transcript, or get trending videos.",
      inputSchema: z.object({
        scope: z.enum(["global", "channel", "transcript", "trending"]).default("global"),
        query: z.string().default(""),
        within: z.string().default(""),
        filters: filtersSchema,
        cursor: cursorSchema,
        limit: limitSchema,
        locale: z.string().default(""),
      }),
      annotations: readOnlyAnnotations,
      _meta: oauthMeta,
    },
    async ({ scope, query, within, filters, cursor, limit, locale }) =>
      runTool("youtube_search", async () => {
        if (scope === "global") {
          const normalized = checkedFilters(filters, [
            "order",
            "channel_id",
            "published_after",
            "published_before",
            "region",
            "relevance_language",
            "safe_search",
            "video_duration",
          ]);
          const normalizedQuery = requireArgument(query, "query");
          assertNoArgument(within, "within");
          const searchFilters = {
            scope,
            query: normalizedQuery,
            order: enumFilter(
              normalized,
              "order",
              ["date", "rating", "relevance", "title", "videoCount", "viewCount"],
              "relevance",
            ),
            channelId: stringFilter(normalized, "channel_id"),
            publishedAfter: stringFilter(normalized, "published_after"),
            publishedBefore: stringFilter(normalized, "published_before"),
            regionCode: stringFilter(normalized, "region"),
            relevanceLanguage:
              stringFilter(normalized, "relevance_language") || locale.trim() || undefined,
            safeSearch: enumFilter(
              normalized,
              "safe_search",
              ["moderate", "none", "strict"],
              "moderate",
            ),
            videoDuration: enumFilter(
              normalized,
              "video_duration",
              ["any", "long", "medium", "short"],
              "any",
            ),
          };
          const result = await service.searchVideos(normalizedQuery, {
            maxResults: Math.min(limit, 50),
            pageToken: pageToken(codec, cursor, "youtube_search", searchFilters),
            ...searchFilters,
          });
          const items = Array.isArray(result.items) ? result.items : [];
          const next =
            typeof result.nextPageToken === "string"
              ? nextCursor(codec, "youtube_search", searchFilters, {
                  pageToken: result.nextPageToken,
                })
              : null;
          return payload(
            "collection",
            without(result, ["items", "nextPageToken", "prevPageToken", "warnings"]),
            items,
            next,
            null,
            result,
            { data: 0, search: 1 },
            ["items[].title", "items[].description", "items[].channelTitle"],
            config,
          );
        }

        if (scope === "channel") {
          checkedFilters(filters, []);
          const channel = requireArgument(within, "within");
          const normalizedQuery = query.trim();
          const searchFilters = { scope, channel, query: normalizedQuery };
          const result = await service.listChannelVideos(
            channel,
            Math.min(limit, 50),
            pageToken(codec, cursor, "youtube_search", searchFilters),
          );
          const rawItems = Array.isArray(result.items) ? result.items : [];
          const needle = normalizedQuery.toLocaleLowerCase();
          const items = needle
            ? rawItems.filter((item) => {
                const value = record(item);
                return `${String(value.title ?? "")} ${String(value.description ?? "")}`
                  .toLocaleLowerCase()
                  .includes(needle);
              })
            : rawItems;
          const next =
            typeof result.nextPageToken === "string"
              ? nextCursor(codec, "youtube_search", searchFilters, {
                  pageToken: result.nextPageToken,
                })
              : null;
          const channelRecord = record(result.channel);
          const channelId =
            typeof channelRecord.id === "string" ? channelRecord.id : channel;
          return payload(
            "collection",
            without(result, ["items", "nextPageToken", "prevPageToken", "warnings"]),
            items,
            next,
            `youtube://entity/channel/${channelId}`,
            result,
            { data: 2, search: 0 },
            ["data.channel.title", "data.channel.description", "items[].title", "items[].description"],
            config,
          );
        }

        if (scope === "transcript") {
          const normalized = checkedFilters(filters, [
            "language",
            "match_mode",
            "case_sensitive",
            "context_segments",
            "from",
            "to",
          ]);
          const videoId = extractVideoId(requireArgument(within, "within"));
          const normalizedQuery = requireArgument(query, "query");
          const transcriptFilters = {
            scope,
            videoId,
            query: normalizedQuery,
            language: stringFilter(normalized, "language") || locale.trim() || undefined,
            matchMode: enumFilter(
              normalized,
              "match_mode",
              ["substring", "word"],
              "substring",
            ),
            caseSensitive: booleanFilter(normalized, "case_sensitive", false),
            contextSegments: integerFilter(
              normalized,
              "context_segments",
              1,
              0,
              10,
            ),
            from: timeFilter(normalized, "from"),
            to: timeFilter(normalized, "to"),
          };
          const result = await service.searchTranscript(videoId, normalizedQuery, {
            ...transcriptFilters,
            offset: offset(codec, cursor, "youtube_search", transcriptFilters),
            limit,
          });
          const items = Array.isArray(result.matches) ? result.matches : [];
          const next =
            typeof result.nextOffset === "number"
              ? nextCursor(codec, "youtube_search", transcriptFilters, {
                  offset: result.nextOffset,
                })
              : null;
          return payload(
            "collection",
            without(result, ["matches", "nextOffset", "warnings"]),
            items,
            next,
            `youtube://entity/video/${videoId}`,
            result,
            { data: 0, search: 0 },
            ["items[].text", "items[].context[].text"],
            config,
          );
        }

        assertNoArgument(query, "query");
        assertNoArgument(within, "within");
        const normalized = checkedFilters(filters, ["region", "category_id"]);
        const trendingFilters = {
          scope,
          regionCode: stringFilter(normalized, "region") ?? config.defaultRegion,
          categoryId: stringFilter(normalized, "category_id"),
        };
        const result = await service.trending(
          trendingFilters.regionCode,
          trendingFilters.categoryId,
          Math.min(limit, 50),
          pageToken(codec, cursor, "youtube_search", trendingFilters),
        );
        const items = Array.isArray(result.items) ? result.items : [];
        const next =
          typeof result.nextPageToken === "string"
            ? nextCursor(codec, "youtube_search", trendingFilters, {
                pageToken: result.nextPageToken,
              })
            : null;
        return payload(
          "collection",
          without(result, ["items", "nextPageToken", "prevPageToken", "warnings"]),
          items,
          next,
          null,
          result,
          { data: 1, search: 0 },
          ["items[].title", "items[].description", "items[].tags"],
          config,
        );
      }, config.maxResultBytes),
  );

  server.registerTool(
    "youtube_channel_get",
    {
      description: "Resolve and get one YouTube channel profile.",
      inputSchema: z.object({
        channel: z.string().min(1),
        select: z
          .array(z.enum(["profile", "statistics", "branding", "uploads_playlist"]))
          .min(1)
          .default(["profile", "statistics", "branding", "uploads_playlist"]),
      }),
      annotations: readOnlyAnnotations,
      _meta: oauthMeta,
    },
    async ({ channel, select }) =>
      runTool("youtube_channel_get", async () => {
        const result = await service.getChannel(channel);
        const channelId = typeof result.id === "string" ? result.id : channel;
        return payload(
          "entity",
          selectChannel(without(result, ["warnings"]), select),
          [],
          null,
          `youtube://entity/channel/${channelId}`,
          result,
          { data: 1, search: 0 },
          ["data.title", "data.description", "data.brandingSettings"],
          config,
        );
      }, config.maxResultBytes),
  );

  server.registerTool(
    "youtube_playlist_get",
    {
      description: "Get playlist metadata or one signed page of playlist items.",
      inputSchema: z.object({
        playlist: z.string().min(1),
        include_items: z.boolean().default(true),
        cursor: cursorSchema,
        limit: limitSchema,
      }),
      annotations: readOnlyAnnotations,
      _meta: oauthMeta,
    },
    async ({ playlist, include_items: includeItems, cursor, limit }) =>
      runTool("youtube_playlist_get", async () => {
        const playlistId = extractPlaylistId(playlist);
        const cursorFilters = { playlistId, includeItems };
        if (!includeItems && cursor) {
          throw new YouTubeMcpError(
            "INVALID_ARGUMENT",
            "include_items=false does not use a cursor.",
          );
        }
        const result = await service.getPlaylist(
          playlistId,
          Math.min(limit, 50),
          includeItems
            ? pageToken(codec, cursor, "youtube_playlist_get", cursorFilters)
            : undefined,
          includeItems,
        );
        const page = record(result.page);
        const items = Array.isArray(page.items) ? page.items : [];
        const next =
          typeof page.nextPageToken === "string"
            ? nextCursor(codec, "youtube_playlist_get", cursorFilters, {
                pageToken: page.nextPageToken,
              })
            : null;
        return payload(
          includeItems ? "collection" : "entity",
          includeItems
            ? {
                playlist: result.playlist ?? null,
                page: without(page, ["items", "nextPageToken", "prevPageToken"]),
              }
            : result.playlist ?? null,
          items,
          next,
          `youtube://entity/playlist/${playlistId}`,
          record(result.playlist),
          { data: includeItems ? 2 : 1, search: 0 },
          ["data.playlist.title", "data.playlist.description", "items[].title", "items[].description"],
          config,
        );
      }, config.maxResultBytes),
  );

  server.registerResource(
    "catalog",
    new ResourceTemplate("youtube://catalog", { list: undefined }),
    {
      description: "Capabilities, limits, provider state, and quota status.",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri, await service.catalog(options.runtime)),
  );

  server.registerResource(
    "schema",
    new ResourceTemplate("youtube://schema/{operation}", { list: undefined }),
    {
      description: "Compact input or error schema by operation name.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const operation = templateVariable(variables, "operation");
      const schema = TOOL_SCHEMAS[operation];
      if (!schema) throw new ResourceNotFoundError(uri.href);
      return jsonResource(uri, {
        schema_version: "1",
        operation,
        schema,
      });
    },
  );

  server.registerResource(
    "entity",
    new ResourceTemplate("youtube://entity/{kind}/{id}", { list: undefined }),
    {
      description: "Canonical video, channel, or playlist metadata.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const kind = templateVariable(variables, "kind");
      const id = templateVariable(variables, "id");
      let entity: Record<string, unknown>;
      if (kind === "video") entity = await service.getVideo(id);
      else if (kind === "channel") entity = await service.getChannel(id);
      else if (kind === "playlist") {
        const result = await service.getPlaylist(id, 1, undefined, false);
        entity = record(result.playlist);
      } else {
        throw new ResourceNotFoundError(uri.href);
      }
      return jsonResource(uri, entity);
    },
  );

  return server;
}
