import { afterEach, describe, expect, it, vi } from "vitest";
import { OEmbedClient } from "../src/providers/oembed-client.js";
import { YouTubeDataApiClient } from "../src/providers/youtube-data-api.js";
import type { QuotaStore } from "../src/quota/quota-store.js";

const CHANNEL_ID = "UC1234567890123456789012";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function quotaStore() {
  const consume = vi.fn(async () => undefined);
  const quota: QuotaStore = {
    consume,
    status: async () => ({
      day: "2026-09-03",
      timeZone: "America/Los_Angeles",
      data: { used: 0, budget: 10_000, remaining: 10_000 },
      search: { used: 0, budget: 100, remaining: 100 },
    }),
  };
  return { quota, consume };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("YouTube Data API normalization", () => {
  it("resolves handles exactly and never substitutes a search hit for a missing handle", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: CHANNEL_ID }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: CHANNEL_ID, snippet: { title: "Exact channel" } }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { quota, consume } = quotaStore();
    const client = new YouTubeDataApiClient("test-key", 5000, quota);
    expect(await client.getChannel({ kind: "handle", value: "exact" })).toMatchObject({
      id: CHANNEL_ID, resolution: { inputKind: "handle", resolvedBy: "handle" },
    });
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("forHandle")).toBe("exact");
    await expect(client.getChannel({ kind: "handle", value: "missing" })).rejects.toMatchObject({ code: "CHANNEL_NOT_FOUND" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(consume).toHaveBeenCalledTimes(3);
    expect(consume).not.toHaveBeenCalledWith("search", 1, "search");
  });

  it("requests and returns a compact trending projection while metadata stays complete", async () => {
    const item = { id: "dQw4w9WgXcQ", snippet: { title: "Video", description: "full description", tags: ["tag"], thumbnails: { high: { url: "https://example.test/high.jpg" } } }, contentDetails: { duration: "PT3M34S" }, statistics: { viewCount: "123" }, status: { privacyStatus: "public" } };
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ items: [item], nextPageToken: "next" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new YouTubeDataApiClient("test-key", 5000, quotaStore().quota);
    const trending = await client.trending("KR", undefined, 10, undefined);
    expect(trending.items).toMatchObject([{ id: item.id, title: "Video", durationSeconds: 214, statistics: { viewCount: "123" }, thumbnail: "https://example.test/high.jpg" }]);
    expect((trending.items as object[])[0]).not.toHaveProperty("description");
    expect((trending.items as object[])[0]).not.toHaveProperty("tags");
    const request = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(request.searchParams.get("fields")).toContain("nextPageToken");
    expect(request.searchParams.get("part")).toBe("snippet,contentDetails,statistics");
    expect(await client.getVideo(item.id)).toMatchObject({ description: "full description", tags: ["tag"], status: { privacyStatus: "public" } });
  });

  it("decodes search display entities once and labels approximate totals", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      items: [{ id: { videoId: "dQw4w9WgXcQ" }, snippet: { title: "Q&amp;A &#39;&#x1f642; &amp;amp;" } }],
      pageInfo: { totalResults: 1_000_000 },
    })));
    const client = new YouTubeDataApiClient("test-key", 5000, quotaStore().quota);
    const result = await client.searchVideos("query", { maxResults: 1, pageToken: undefined, order: "relevance", channelId: undefined, publishedAfter: undefined, publishedBefore: undefined, regionCode: undefined, relevanceLanguage: undefined, safeSearch: "moderate", videoDuration: "any" });
    expect(result.items).toMatchObject([{ title: "Q&A '🙂 &amp;" }]);
    expect(result.pageInfo).toMatchObject({ totalResults: 1_000_000, totalResultsReliable: false });
  });

  it("uses the search index for a query within a channel", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: CHANNEL_ID,
              snippet: { title: "Channel" },
              contentDetails: { relatedPlaylists: { uploads: "UU123" } },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: { videoId: "dQw4w9WgXcQ" },
              snippet: { title: "Godot tutorial", channelId: CHANNEL_ID },
            },
          ],
          nextPageToken: "next-search-page",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { quota, consume } = quotaStore();
    const client = new YouTubeDataApiClient("test-key", 5_000, quota);

    const result = await client.searchChannelVideos(
      { kind: "id", value: CHANNEL_ID },
      "Godot",
      3,
      undefined,
    );

    expect(result).toMatchObject({
      retrievalStrategy: "search.list(q, channelId, type=video)",
      nextPageToken: "next-search-page",
      items: [{ id: "dQw4w9WgXcQ", title: "Godot tutorial" }],
    });
    const searchUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(searchUrl.pathname).toBe("/youtube/v3/search");
    expect(searchUrl.searchParams.get("q")).toBe("Godot");
    expect(searchUrl.searchParams.get("channelId")).toBe(CHANNEL_ID);
    expect(searchUrl.searchParams.get("type")).toBe("video");
    expect(consume).toHaveBeenNthCalledWith(1, "data", 1, "channels");
    expect(consume).toHaveBeenNthCalledWith(2, "search", 1, "search");
  });

  it("marks omitted replies and comment totals as incomplete estimates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: "thread-1",
              snippet: {
                totalReplyCount: 186,
                topLevelComment: {
                  id: "comment-1",
                  snippet: { textOriginal: "hello" },
                },
              },
            },
          ],
          nextPageToken: "next-comments-page",
          pageInfo: { totalResults: 3, resultsPerPage: 3 },
        }),
      ),
    );
    const { quota } = quotaStore();
    const client = new YouTubeDataApiClient("test-key", 5_000, quota);

    const result = await client.listComments(
      "dQw4w9WgXcQ",
      3,
      undefined,
      "relevance",
      false,
      0,
    );
    const item = (result.items as Array<Record<string, unknown>>)[0];
    expect(item).toMatchObject({
      totalReplyCount: 186,
      repliesIncluded: false,
      repliesReturned: 0,
      repliesComplete: null,
    });
    expect(result.pageInfo).toMatchObject({
      totalResults: null,
      estimatedTotalResults: 3,
      resultsPerPage: 3,
      totalResultsReliable: false,
    });
    expect(result.nextPageToken).toBe("next-comments-page");
  });

  it("maps deterministic oEmbed absence to NOT_FOUND", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({}, 400)),
    );
    const client = new OEmbedClient(5_000);
    await expect(client.getVideo("aaaaaaaaaaa")).rejects.toMatchObject({
      code: "VIDEO_NOT_FOUND",
      retryable: false,
    });
  });
});
