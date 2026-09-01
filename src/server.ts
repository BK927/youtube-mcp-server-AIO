import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { loadConfig } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "./meta.js";
import { runTool } from "./mcp-response.js";
import type { AppConfig } from "./types.js";
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

const pageToken = z
  .string()
  .min(1)
  .optional()
  .describe("Opaque nextPageToken returned by a previous call.");

export interface CreateYoutubeMcpServerOptions {
  service?: YouTubeService;
  runtime?: ServiceRuntimeInfo;
}

export function createYoutubeMcpServer(
  config: AppConfig = loadConfig(),
  options: CreateYoutubeMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  const service = options.service ?? new YouTubeService(config);

  server.registerTool(
    "youtube_capabilities",
    {
      title: "YouTube MCP capabilities",
      description:
        "Inspect configured YouTube providers, API-key status, transcript fallbacks, safeguards, and currently available tool groups. Call this first when provider availability is uncertain.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => runTool(() => service.capabilities(options.runtime)),
  );

  server.registerTool(
    "youtube_video_get",
    {
      title: "Get YouTube video metadata",
      description:
        "Get normalized metadata for one video ID or URL. Uses the official Data API when configured, otherwise returns limited no-key oEmbed metadata.",
      inputSchema: z.object({
        video: z
          .string()
          .min(1)
          .describe("YouTube video ID or watch, short, live, embed, or youtu.be URL."),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ video }) => runTool(() => service.getVideo(video)),
  );

  server.registerTool(
    "youtube_transcript_get",
    {
      title: "Get a paginated YouTube transcript",
      description:
        "Retrieve timestamped transcript segments with direct citation links. Results are paginated to prevent context flooding. Public-video transcripts use the configured unofficial provider chain.",
      inputSchema: z.object({
        video: z.string().min(1).describe("YouTube video ID or URL."),
        language: z
          .string()
          .min(1)
          .optional()
          .describe("Preferred language code or provider language label."),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Zero-based transcript segment offset."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .default(200)
          .describe("Maximum transcript segments returned in this page."),
        includeText: z
          .boolean()
          .default(false)
          .describe("Also render the returned page as one newline-delimited text block."),
        includeTimestamps: z
          .boolean()
          .default(true)
          .describe("Prefix lines in the optional text block with timestamps."),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({
      video,
      language,
      offset,
      limit,
      includeText,
      includeTimestamps,
    }) =>
      runTool(() =>
        service.getTranscript(video, {
          language,
          offset,
          limit,
          includeText,
          includeTimestamps,
        }),
      ),
  );

  server.registerTool(
    "youtube_transcript_search",
    {
      title: "Search inside a YouTube transcript",
      description:
        "Find exact evidence inside a video's transcript. Returns timestamp links and surrounding segments, with optional time-window and paginated match controls.",
      inputSchema: z.object({
        video: z.string().min(1).describe("YouTube video ID or URL."),
        query: z.string().min(1).describe("Text to find in transcript segments."),
        language: z.string().min(1).optional(),
        matchMode: z.enum(["substring", "word"]).default("substring"),
        caseSensitive: z.boolean().default(false),
        contextSegments: z
          .number()
          .int()
          .min(0)
          .max(10)
          .default(1)
          .describe("Segments included before and after each matching segment."),
        from: z
          .union([z.string(), z.number().nonnegative()])
          .optional()
          .describe("Start of search window: seconds, MM:SS, HH:MM:SS, or 1h2m3s."),
        to: z
          .union([z.string(), z.number().nonnegative()])
          .optional()
          .describe("End of search window in the same formats as from."),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({
      video,
      query,
      language,
      matchMode,
      caseSensitive,
      contextSegments,
      from,
      to,
      offset,
      limit,
    }) =>
      runTool(() =>
        service.searchTranscript(video, query, {
          language,
          matchMode,
          caseSensitive,
          contextSegments,
          from,
          to,
          offset,
          limit,
        }),
      ),
  );

  server.registerTool(
    "youtube_search",
    {
      title: "Search YouTube videos",
      description:
        "Search public videos with the official YouTube Data API. Requires YOUTUBE_API_KEY and spends one call from the separately guarded search.list bucket per page.",
      inputSchema: z.object({
        query: z.string().min(1),
        maxResults: z.number().int().min(1).max(50).default(10),
        pageToken,
        order: z
          .enum(["date", "rating", "relevance", "title", "viewCount"])
          .default("relevance"),
        channelId: z.string().min(1).optional(),
        publishedAfter: z
          .string()
          .optional()
          .describe("RFC 3339 timestamp, for example 2026-01-01T00:00:00Z."),
        publishedBefore: z.string().optional().describe("RFC 3339 timestamp."),
        regionCode: z.string().length(2).optional(),
        relevanceLanguage: z.string().min(2).optional(),
        safeSearch: z.enum(["moderate", "none", "strict"]).default("moderate"),
        videoDuration: z
          .enum(["any", "long", "medium", "short"])
          .default("any"),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({
      query,
      maxResults,
      pageToken: token,
      order,
      channelId,
      publishedAfter,
      publishedBefore,
      regionCode,
      relevanceLanguage,
      safeSearch,
      videoDuration,
    }) =>
      runTool(() =>
        service.searchVideos(query, {
          maxResults,
          pageToken: token,
          order,
          channelId,
          publishedAfter,
          publishedBefore,
          regionCode,
          relevanceLanguage,
          safeSearch,
          videoDuration,
        }),
      ),
  );

  server.registerTool(
    "youtube_channel_get",
    {
      title: "Get a YouTube channel",
      description:
        "Resolve and retrieve an official channel profile, statistics, branding, and uploads playlist. Accepts a channel ID, @handle, URL, legacy username, or search query. Requires YOUTUBE_API_KEY.",
      inputSchema: z.object({
        channel: z.string().min(1).describe("Channel ID, @handle, URL, username, or name."),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ channel }) => runTool(() => service.getChannel(channel)),
  );

  server.registerTool(
    "youtube_channel_videos",
    {
      title: "List a channel's uploaded videos",
      description:
        "List uploads through the channel's uploads playlist instead of search, preserving the limited search bucket. Requires YOUTUBE_API_KEY.",
      inputSchema: z.object({
        channel: z.string().min(1),
        maxResults: z.number().int().min(1).max(50).default(25),
        pageToken,
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ channel, maxResults, pageToken: token }) =>
      runTool(() => service.listChannelVideos(channel, maxResults, token)),
  );

  server.registerTool(
    "youtube_playlist_get",
    {
      title: "Get a YouTube playlist",
      description:
        "Get official playlist metadata and optionally one paginated page of items. Requires YOUTUBE_API_KEY.",
      inputSchema: z.object({
        playlist: z.string().min(1).describe("Playlist ID or URL."),
        includeItems: z.boolean().default(true),
        maxResults: z.number().int().min(1).max(50).default(25),
        pageToken,
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ playlist, includeItems, maxResults, pageToken: token }) =>
      runTool(() =>
        service.getPlaylist(
          playlist,
          maxResults,
          token,
          includeItems,
        ),
      ),
  );

  server.registerTool(
    "youtube_comments_get",
    {
      title: "Get YouTube comment threads",
      description:
        "Get one paginated page of public comment threads with plain text and optional embedded replies. Requires YOUTUBE_API_KEY; large-scale corpus collection is a later milestone.",
      inputSchema: z.object({
        video: z.string().min(1).describe("YouTube video ID or URL."),
        maxResults: z.number().int().min(1).max(100).default(50),
        pageToken,
        order: z.enum(["relevance", "time"]).default("relevance"),
        includeReplies: z.boolean().default(true),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ video, maxResults, pageToken: token, order, includeReplies }) =>
      runTool(() =>
        service.listComments(
          video,
          maxResults,
          token,
          order,
          includeReplies,
        ),
      ),
  );

  server.registerTool(
    "youtube_trending",
    {
      title: "Get YouTube most-popular videos",
      description:
        "Get the official videos.list mostPopular chart for a region and optional category. Requires YOUTUBE_API_KEY.",
      inputSchema: z.object({
        regionCode: z
          .string()
          .length(2)
          .optional()
          .describe("ISO 3166-1 alpha-2 country code; defaults to server config."),
        categoryId: z.string().min(1).optional(),
        maxResults: z.number().int().min(1).max(50).default(25),
        pageToken,
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ regionCode, categoryId, maxResults, pageToken: token }) =>
      runTool(() =>
        service.trending(regionCode, categoryId, maxResults, token),
      ),
  );

  server.registerTool(
    "youtube_quota_status",
    {
      title: "Inspect local YouTube API quota guards",
      description:
        "Show this process's ordinary Data API and search.list usage estimates and configured daily guards. This cannot see calls made by other applications sharing the same Google project.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => runTool(() => service.quotaStatus()),
  );

  return server;
}
