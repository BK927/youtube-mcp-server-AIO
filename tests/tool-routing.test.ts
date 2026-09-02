import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createYoutubeMcpServer } from "../src/server.js";
import type { YouTubeService } from "../src/youtube-service.js";
import { testAppConfig } from "./helpers.js";

const VIDEO_ID = "dQw4w9WgXcQ";
const CHANNEL_ID = "UC1234567890123456789012";
const PLAYLIST_ID = "PL12345678901234567890123456789012";

async function connectedClient(service: Partial<YouTubeService>) {
  const server = createYoutubeMcpServer(testAppConfig(), {
    service: service as YouTubeService,
  });
  const client = new Client({ name: "routing-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function selectedOutput(result: Awaited<ReturnType<Client["callTool"]>>) {
  const envelope = result.structuredContent as {
    kind: string;
    data: unknown;
    items: unknown[];
    page: { returned: number; has_more: boolean; next_cursor: string | null };
    meta: { canonical_uri: string | null; provider: string };
  };
  return {
    kind: envelope.kind,
    data: envelope.data,
    items: envelope.items,
    page: envelope.page,
    canonical_uri: envelope.meta.canonical_uri,
    provider: envelope.meta.provider,
  };
}

describe("public tool routing", () => {
  it("routes every youtube_video_get view and selects its golden output", async () => {
    const getVideo = vi.fn(async () => ({
      id: VIDEO_ID,
      title: "Metadata title",
      description: "Metadata description",
      provider: "metadata-provider",
      warnings: ["metadata warning"],
    }));
    const getTranscript = vi.fn(async () => ({
      videoId: VIDEO_ID,
      provider: "transcript-provider",
      language: "ko",
      availableLanguages: ["ko"],
      generated: false,
      totalSegments: 1,
      durationSeconds: 2,
      offset: 0,
      limit: 7,
      nextOffset: undefined,
      text: undefined,
      segments: [
        {
          index: 0,
          startSeconds: 0,
          durationSeconds: 2,
          endSeconds: 2,
          timestamp: "00:00",
          text: "transcript text",
          url: `https://youtu.be/${VIDEO_ID}?t=0`,
        },
      ],
      warnings: [],
    }));
    const listComments = vi.fn(async () => ({
      videoId: VIDEO_ID,
      provider: "comments-provider",
      items: [
        {
          threadId: "thread-1",
          totalReplyCount: 0,
          topLevelComment: { id: "comment-1", text: "comment text" },
          replies: [],
          repliesReturned: 0,
          repliesIncluded: false,
          repliesComplete: null,
        },
      ],
      warnings: [],
    }));
    const { client, server } = await connectedClient({
      getVideo,
      getTranscript,
      listComments,
    });
    const cases = [
      {
        arguments: { video: VIDEO_ID, view: "metadata" },
        assertCall: () => expect(getVideo).toHaveBeenCalledWith(VIDEO_ID),
        expected: {
          kind: "entity",
          data: {
            id: VIDEO_ID,
            title: "Metadata title",
            description: "Metadata description",
            provider: "metadata-provider",
          },
          items: [],
          page: { returned: 0, has_more: false, next_cursor: null },
          canonical_uri: `youtube://entity/video/${VIDEO_ID}`,
          provider: "metadata-provider",
        },
      },
      {
        arguments: {
          video: VIDEO_ID,
          view: "transcript",
          options: {
            language: "ko",
            include_text: true,
            include_timestamps: false,
          },
          limit: 7,
          locale: "en",
        },
        assertCall: () =>
          expect(getTranscript).toHaveBeenCalledWith(VIDEO_ID, {
            language: "ko",
            offset: 0,
            limit: 7,
            includeText: true,
            includeTimestamps: false,
          }),
        expected: {
          kind: "collection",
          data: {
            videoId: VIDEO_ID,
            provider: "transcript-provider",
            language: "ko",
            availableLanguages: ["ko"],
            generated: false,
            totalSegments: 1,
            durationSeconds: 2,
            offset: 0,
            limit: 7,
          },
          items: [
            {
              index: 0,
              startSeconds: 0,
              durationSeconds: 2,
              endSeconds: 2,
              timestamp: "00:00",
              text: "transcript text",
              url: `https://youtu.be/${VIDEO_ID}?t=0`,
            },
          ],
          page: { returned: 1, has_more: false, next_cursor: null },
          canonical_uri: `youtube://entity/video/${VIDEO_ID}`,
          provider: "transcript-provider",
        },
      },
      {
        arguments: {
          video: VIDEO_ID,
          view: "comments",
          options: { order: "time", include_replies: false },
          limit: 9,
        },
        assertCall: () =>
          expect(listComments).toHaveBeenCalledWith(
            VIDEO_ID,
            9,
            undefined,
            "time",
            false,
            0,
          ),
        expected: {
          kind: "collection",
          data: { videoId: VIDEO_ID, provider: "comments-provider" },
          items: [
            {
              threadId: "thread-1",
              totalReplyCount: 0,
              topLevelComment: { id: "comment-1", text: "comment text" },
              replies: [],
              repliesReturned: 0,
              repliesIncluded: false,
              repliesComplete: null,
            },
          ],
          page: { returned: 1, has_more: false, next_cursor: null },
          canonical_uri: `youtube://entity/video/${VIDEO_ID}`,
          provider: "comments-provider",
        },
      },
    ] as const;

    try {
      for (const route of cases) {
        const result = await client.callTool({
          name: "youtube_video_get",
          arguments: route.arguments,
        });
        expect(result.isError).not.toBe(true);
        route.assertCall();
        expect(selectedOutput(result)).toEqual(route.expected);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps comment identity fields intact while bounding optional replies", async () => {
    const listComments = vi.fn(
      async (
        _videoId: string,
        _limit: number,
        _pageToken: string | undefined,
        _order: "relevance" | "time",
        includeReplies: boolean,
        replyLimit: number,
      ) => ({
        videoId: VIDEO_ID,
        provider: "comments-provider",
        items: Array.from({ length: 5 }, (_, index) => ({
          threadId: `thread-${index}`,
          totalReplyCount: 3,
          topLevelComment: {
            id: `comment-${index}`,
            author: { name: `author-${index}` },
            text: `top-${index}-${"x".repeat(500)}`,
            publishedAt: "2026-09-02T00:00:00Z",
          },
          replies: includeReplies
            ? Array.from({ length: 3 }, (_, replyIndex) => ({
                id: `reply-${index}-${replyIndex}`,
                author: { name: `reply-author-${replyIndex}` },
                text: `reply-${replyIndex}-${"y".repeat(300)}`,
                publishedAt: "2026-09-02T00:00:00Z",
              })).slice(0, replyLimit)
            : [],
          repliesReturned: includeReplies ? Math.min(3, replyLimit) : 0,
          repliesIncluded: includeReplies && replyLimit > 0,
          repliesComplete:
            includeReplies && replyLimit > 0 ? replyLimit >= 3 : null,
        })),
        warnings: [],
      }),
    );
    const { client, server } = await connectedClient({ listComments });
    try {
      const defaultResult = await client.callTool({
        name: "youtube_video_get",
        arguments: {
          video: VIDEO_ID,
          view: "comments",
          limit: 5,
          max_chars: 256,
        },
      });
      expect(listComments).toHaveBeenLastCalledWith(
        VIDEO_ID,
        5,
        undefined,
        "relevance",
        false,
        0,
      );
      const defaultEnvelope = defaultResult.structuredContent as {
        data: { truncation?: { truncated: boolean } };
        items: Array<{
          threadId: string;
          topLevelComment: { id: string; text: string; publishedAt: string };
          replies: unknown[];
        }>;
        page: { returned: number };
      };
      expect(defaultEnvelope.items).toHaveLength(5);
      expect(defaultEnvelope.page.returned).toBe(defaultEnvelope.items.length);
      expect(
        defaultEnvelope.items.every(
          (item) =>
            item.threadId &&
            item.topLevelComment.id &&
            item.topLevelComment.text &&
            item.topLevelComment.publishedAt &&
            item.replies.length === 0,
        ),
      ).toBe(true);
      expect(defaultEnvelope.data.truncation?.truncated).toBe(true);

      const repliesResult = await client.callTool({
        name: "youtube_video_get",
        arguments: {
          video: VIDEO_ID,
          view: "comments",
          options: { include_replies: true, reply_limit: 2 },
          limit: 5,
          max_chars: 512,
        },
      });
      expect(listComments).toHaveBeenLastCalledWith(
        VIDEO_ID,
        5,
        undefined,
        "relevance",
        true,
        2,
      );
      const repliesEnvelope = repliesResult.structuredContent as {
        items: Array<{
          topLevelComment: { id: string; text: string };
          replies: Array<{ id: string; text: string }>;
        }>;
        page: { returned: number };
        meta: { untrusted_fields: string[] };
      };
      expect(repliesEnvelope.page.returned).toBe(repliesEnvelope.items.length);
      expect(
        repliesEnvelope.items.every(
          (item) =>
            item.topLevelComment.id &&
            item.topLevelComment.text &&
            item.replies.length <= 2 &&
            item.replies.every((reply) => reply.id && reply.text),
        ),
      ).toBe(true);
      expect(repliesEnvelope.meta.untrusted_fields).toContain(
        "items[].topLevelComment.text",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("routes every youtube_search scope and selects its golden output", async () => {
    const searchVideos = vi.fn(async () => ({
      provider: "global-provider",
      totalResults: 1,
      items: [{ id: "global-video", title: "Global" }],
    }));
    const listChannelVideos = vi.fn(async () => ({
      provider: "channel-provider",
      channel: { id: CHANNEL_ID, title: "Channel" },
      items: [{ id: "channel-video", title: "Channel upload" }],
    }));
    const searchChannelVideos = vi.fn(async () => ({
      provider: "channel-search-provider",
      channel: { id: CHANNEL_ID, title: "Channel" },
      items: [{ id: "matched-video", title: "Godot tutorial" }],
    }));
    const searchTranscript = vi.fn(async () => ({
      videoId: VIDEO_ID,
      provider: "transcript-provider",
      query: "needle",
      totalMatches: 1,
      matches: [{ index: 2, text: "needle match" }],
    }));
    const trending = vi.fn(async () => ({
      provider: "trending-provider",
      regionCode: "KR",
      items: [{ id: "trending-video", title: "Trending" }],
    }));
    const { client, server } = await connectedClient({
      searchVideos,
      listChannelVideos,
      searchChannelVideos,
      searchTranscript,
      trending,
    });
    const cases = [
      {
        arguments: {
          scope: "global",
          query: "cats",
          filters: { order: "date", channel_id: CHANNEL_ID },
          limit: 12,
          locale: "ko",
        },
        assertCall: () =>
          expect(searchVideos).toHaveBeenCalledWith("cats", {
            maxResults: 12,
            pageToken: undefined,
            scope: "global",
            query: "cats",
            order: "date",
            channelId: CHANNEL_ID,
            publishedAfter: undefined,
            publishedBefore: undefined,
            regionCode: undefined,
            relevanceLanguage: "ko",
            safeSearch: "moderate",
            videoDuration: "any",
          }),
        expected: {
          kind: "collection",
          data: { provider: "global-provider", totalResults: 1 },
          items: [{ id: "global-video", title: "Global" }],
          page: { returned: 1, has_more: false, next_cursor: null },
          canonical_uri: null,
          provider: "global-provider",
        },
      },
      {
        arguments: {
          scope: "channel",
          query: "Godot",
          within: CHANNEL_ID,
          filters: { strategy: "auto" },
          limit: 3,
        },
        assertCall: () =>
          expect(searchChannelVideos).toHaveBeenCalledWith(
            CHANNEL_ID,
            "Godot",
            3,
            undefined,
          ),
        expected: {
          kind: "collection",
          data: {
            provider: "channel-search-provider",
            channel: { id: CHANNEL_ID, title: "Channel" },
          },
          items: [{ id: "matched-video", title: "Godot tutorial" }],
          page: { returned: 1, has_more: false, next_cursor: null },
          canonical_uri: `youtube://entity/channel/${CHANNEL_ID}`,
          provider: "channel-search-provider",
        },
      },
      {
        arguments: {
          scope: "channel",
          within: CHANNEL_ID,
          limit: 11,
        },
        assertCall: () =>
          expect(listChannelVideos).toHaveBeenCalledWith(
            CHANNEL_ID,
            11,
            undefined,
          ),
        expected: {
          kind: "collection",
          data: {
            provider: "channel-provider",
            channel: { id: CHANNEL_ID, title: "Channel" },
          },
          items: [{ id: "channel-video", title: "Channel upload" }],
          page: { returned: 1, has_more: false, next_cursor: null },
          canonical_uri: `youtube://entity/channel/${CHANNEL_ID}`,
          provider: "channel-provider",
        },
      },
      {
        arguments: {
          scope: "transcript",
          query: "needle",
          within: VIDEO_ID,
          filters: {
            language: "en",
            match_mode: "word",
            case_sensitive: true,
            context_segments: 2,
            from: 5,
            to: "00:30",
          },
          limit: 6,
        },
        assertCall: () =>
          expect(searchTranscript).toHaveBeenCalledWith(VIDEO_ID, "needle", {
            scope: "transcript",
            videoId: VIDEO_ID,
            query: "needle",
            language: "en",
            matchMode: "word",
            caseSensitive: true,
            contextSegments: 2,
            from: 5,
            to: "00:30",
            offset: 0,
            limit: 6,
          }),
        expected: {
          kind: "collection",
          data: {
            videoId: VIDEO_ID,
            provider: "transcript-provider",
            query: "needle",
            totalMatches: 1,
          },
          items: [{ index: 2, text: "needle match" }],
          page: { returned: 1, has_more: false, next_cursor: null },
          canonical_uri: `youtube://entity/video/${VIDEO_ID}`,
          provider: "transcript-provider",
        },
      },
      {
        arguments: {
          scope: "trending",
          filters: { region: "KR", category_id: "10" },
          limit: 14,
        },
        assertCall: () =>
          expect(trending).toHaveBeenCalledWith("KR", "10", 14, undefined),
        expected: {
          kind: "collection",
          data: { provider: "trending-provider", regionCode: "KR" },
          items: [{ id: "trending-video", title: "Trending" }],
          page: { returned: 1, has_more: false, next_cursor: null },
          canonical_uri: null,
          provider: "trending-provider",
        },
      },
    ] as const;

    try {
      for (const route of cases) {
        const result = await client.callTool({
          name: "youtube_search",
          arguments: route.arguments,
        });
        expect(result.isError).not.toBe(true);
        route.assertCall();
        expect(selectedOutput(result)).toEqual(route.expected);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("infers a trending region only from an explicit locale region", async () => {
    const trending = vi.fn(async (regionCode: string) => ({
      provider: "trending-provider",
      regionCode,
      items: [],
    }));
    const { client, server } = await connectedClient({ trending });
    try {
      const inferred = await client.callTool({
        name: "youtube_search",
        arguments: { scope: "trending", locale: "ko-KR" },
      });
      expect(inferred.isError).not.toBe(true);
      expect(trending).toHaveBeenLastCalledWith("KR", undefined, 10, undefined);

      await client.callTool({
        name: "youtube_search",
        arguments: {
          scope: "trending",
          locale: "ko-KR",
          filters: { region: "JP" },
        },
      });
      expect(trending).toHaveBeenLastCalledWith("JP", undefined, 10, undefined);

      const invalid = await client.callTool({
        name: "youtube_search",
        arguments: { scope: "trending", filters: { region: "KOR" } },
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("selects each youtube_channel_get projection exactly", async () => {
    const channel = {
      id: CHANNEL_ID,
      url: `https://www.youtube.com/channel/${CHANNEL_ID}`,
      title: "Channel title",
      description: "Channel description",
      customUrl: "@channel",
      publishedAt: "2020-01-01T00:00:00Z",
      country: "KR",
      defaultLanguage: "ko",
      thumbnails: { default: { url: "https://example.test/channel.jpg" } },
      provider: "channel-provider",
      resolution: "id",
      statistics: { subscriberCount: "123" },
      brandingSettings: { channel: { keywords: "test" } },
      uploadsPlaylistId: "UU1234567890123456789012",
      ignored: "must not leak",
    };
    const getChannel = vi.fn(async () => channel);
    const { client, server } = await connectedClient({ getChannel });
    const cases = [
      {
        select: "profile",
        data: {
          id: CHANNEL_ID,
          url: `https://www.youtube.com/channel/${CHANNEL_ID}`,
          title: "Channel title",
          description: "Channel description",
          customUrl: "@channel",
          publishedAt: "2020-01-01T00:00:00Z",
          country: "KR",
          defaultLanguage: "ko",
          thumbnails: { default: { url: "https://example.test/channel.jpg" } },
          provider: "channel-provider",
          resolution: "id",
        },
      },
      {
        select: "statistics",
        data: { statistics: { subscriberCount: "123" } },
      },
      {
        select: "branding",
        data: { brandingSettings: { channel: { keywords: "test" } } },
      },
      {
        select: "uploads_playlist",
        data: { uploadsPlaylistId: "UU1234567890123456789012" },
      },
    ] as const;

    try {
      for (const route of cases) {
        const result = await client.callTool({
          name: "youtube_channel_get",
          arguments: { channel: CHANNEL_ID, select: [route.select] },
        });
        expect(result.isError).not.toBe(true);
        expect(selectedOutput(result)).toEqual({
          kind: "entity",
          data: route.data,
          items: [],
          page: { returned: 0, has_more: false, next_cursor: null },
          canonical_uri: `youtube://entity/channel/${CHANNEL_ID}`,
          provider: "channel-provider",
        });
      }
      expect(getChannel).toHaveBeenCalledTimes(cases.length);
      expect(getChannel).toHaveBeenCalledWith(CHANNEL_ID);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("routes playlist metadata and item modes with distinct golden outputs", async () => {
    const playlist = {
      id: PLAYLIST_ID,
      title: "Playlist title",
      provider: "playlist-provider",
    };
    const getPlaylist = vi.fn(
      async (
        _playlist: string,
        _limit: number,
        _pageToken: string | undefined,
        includeItems: boolean,
      ) =>
        includeItems
          ? {
              playlist,
              page: {
                totalResults: 1,
                items: [{ id: "playlist-item", title: "Playlist item" }],
              },
            }
          : { playlist },
    );
    const { client, server } = await connectedClient({ getPlaylist });
    const cases = [
      {
        include_items: true,
        expected: {
          kind: "collection",
          data: { playlist, page: { totalResults: 1 } },
          items: [{ id: "playlist-item", title: "Playlist item" }],
          page: { returned: 1, has_more: false, next_cursor: null },
          canonical_uri: `youtube://entity/playlist/${PLAYLIST_ID}`,
          provider: "playlist-provider",
        },
      },
      {
        include_items: false,
        expected: {
          kind: "entity",
          data: playlist,
          items: [],
          page: { returned: 0, has_more: false, next_cursor: null },
          canonical_uri: `youtube://entity/playlist/${PLAYLIST_ID}`,
          provider: "playlist-provider",
        },
      },
    ] as const;

    try {
      for (const route of cases) {
        const result = await client.callTool({
          name: "youtube_playlist_get",
          arguments: {
            playlist: PLAYLIST_ID,
            include_items: route.include_items,
            limit: 8,
          },
        });
        expect(result.isError).not.toBe(true);
        expect(selectedOutput(result)).toEqual(route.expected);
      }
      expect(getPlaylist.mock.calls).toEqual([
        [PLAYLIST_ID, 8, undefined, true],
        [PLAYLIST_ID, 8, undefined, false],
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
