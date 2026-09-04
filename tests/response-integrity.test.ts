import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createYoutubeMcpServer } from "../src/server.js";
import { CursorCodec } from "../src/cursor.js";
import { ResponsePager, type PageSnapshot, type PageSnapshotStore } from "../src/response-pager.js";
import type { ToolPayload } from "../src/mcp-response.js";
import type { YouTubeService } from "../src/youtube-service.js";
import { testAppConfig } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

async function connect(service: object, maxResultBytes = 4096) {
  const server = createYoutubeMcpServer(testAppConfig({ maxResultBytes }), { service: service as YouTubeService });
  const client = new Client({ name: "integrity-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await client.connect(left);
  return { client, server };
}

const rows = (start: number, end: number) => Array.from({ length: end - start }, (_, index) => ({
  id: `video-${start + index}`, title: "제목".repeat(30), description: "설명".repeat(250),
  channelId: "UC1234567890123456789012", publishedAt: "2026-09-01T00:00:00Z",
}));

describe("response integrity", () => {
  it("resumes buffered pages on another server through the shared snapshot store", async () => {
    const snapshots = new Map<string, PageSnapshot>();
    const store: PageSnapshotStore = { get: async (id) => snapshots.get(id), put: async (id, value) => { snapshots.set(id, value); } };
    const codec = new CursorCodec("s".repeat(32), 60_000);
    const firstServer = new ResponsePager(codec, 60_000, 4096, store);
    const otherServer = new ResponsePager(codec, 60_000, 4096, store);
    const action = vi.fn(async (): Promise<ToolPayload> => ({ kind: "collection", items: rows(0, 10) }));
    const first = await firstServer.run("search", {}, undefined, 10, action);
    let page = first.structuredContent as unknown as ToolPayload;
    const ids = (page.items as Array<{ id: string }>).map((item) => item.id);
    for (let i = 0; i < 10 && page.page?.next_cursor; i++) {
      const result = await otherServer.run("search", {}, page.page.next_cursor, 10, action);
      expect(result).not.toHaveProperty("isError");
      page = result.structuredContent as unknown as ToolPayload;
      ids.push(...(page.items as Array<{ id: string }>).map((item) => item.id));
    }
    expect(ids).toEqual(Array.from({ length: 10 }, (_, i) => `video-${i}`));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it.each(["global", "channel", "trending", "playlist"])("preserves every %s item across byte-limited pages", async (scope) => {
    const provider = vi.fn()
      .mockResolvedValueOnce({ provider: "test", items: rows(0, 10), nextPageToken: "upstream-10", ...(scope === "channel" ? { channel: { id: "UC1234567890123456789012", title: "Channel", brandingSettings: { large: "x".repeat(20_000) } } } : {}) })
      .mockResolvedValueOnce({ provider: "test", items: rows(10, 15), nextPageToken: null, channel: { id: "UC1234567890123456789012", title: "Channel" } });
    const service = {
      searchVideos: provider, searchChannelVideos: provider, trending: provider,
      getPlaylist: async () => ({ playlist: { id: "PL1234567890", title: "Playlist" }, page: await provider() }),
    };
    const { client, server } = await connect(service);
    const name = scope === "playlist" ? "youtube_playlist_get" : "youtube_search";
    const args = scope === "playlist" ? { playlist: "PL1234567890" } : {
      scope, ...(scope === "global" || scope === "channel" ? { query: "test" } : {}),
      ...(scope === "channel" ? { within: "UC1234567890123456789012" } : {}),
    };
    const ids: string[] = [];
    let cursor: string | undefined;
    try {
      for (let pageIndex = 0; pageIndex < 30; pageIndex++) {
        const result = await client.callTool({ name, arguments: { ...args, limit: 10, ...(cursor ? { cursor } : {}) } });
        expect(result.isError).not.toBe(true);
        const page = result.structuredContent as unknown as ToolPayload;
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096);
        expect(page.items?.length).toBeGreaterThan(0);
        ids.push(...(page.items as Array<{ id: string }>).map((item) => item.id));
        if (scope === "channel") expect((page.data as { channel: object }).channel).toEqual({ id: "UC1234567890123456789012", title: "Channel" });
        if (!page.page?.has_more) break;
        cursor = page.page.next_cursor!;
        if (cursor.startsWith("buffer:")) {
          expect((page.data as { truncation: object }).truncation).toMatchObject({ content_omitted: true });
          const calls = provider.mock.calls.length;
          const mismatch = await client.callTool({ name, arguments: { ...args, limit: 10, cursor, ...(scope === "playlist" ? { playlist: "PL9999999999" } : { locale: "ko" }) } });
          expect(mismatch.structuredContent).toMatchObject({ code: "CURSOR_MISMATCH" });
          expect(provider).toHaveBeenCalledTimes(calls);
        }
      }
      expect(ids).toEqual(Array.from({ length: 15 }, (_, i) => `video-${i}`));
      expect(provider).toHaveBeenCalledTimes(2);
    } finally {
      await client.close(); await server.close();
    }
  });

  it("preserves structured metadata for ID and URL inputs with a small text budget", async () => {
    const metadata = { id: "dQw4w9WgXcQ", title: "Video", description: "x".repeat(6000), channelId: "UC123", channelTitle: "Channel", publishedAt: "2026-01-01T00:00:00Z", duration: "PT3M34S", durationSeconds: 214, statistics: { viewCount: "123456" }, thumbnails: { high: { url: "https://example.test/image.jpg" } }, tags: ["one", "two"], provider: "youtube-data-api-v3", completeness: "official" };
    const { client, server } = await connect({ getVideo: async () => metadata }, 12288);
    try {
      for (const video of [metadata.id, `https://youtu.be/${metadata.id}?t=1`]) {
        const response = await client.callTool({ name: "youtube_video_get", arguments: { video, max_chars: 1000 } });
        expect(response.isError).not.toBe(true);
        const payload = response.structuredContent as unknown as ToolPayload;
        const data = payload.data as Record<string, unknown>;
        const { description: _description, ...structural } = metadata;
        expect(data).toMatchObject(structural);
        expect((data.description as string).length).toBeLessThanOrEqual(1000);
        expect(data.truncation).toMatchObject({ reason: "max_chars", content_omitted: true });
        expect(payload.meta?.warnings?.length).toBeGreaterThan(0);
        expect(metadata.description).toHaveLength(6000);
      }
    } finally { await client.close(); await server.close(); }
  });

  it("makes buffered cursors replayable and rejects missing, expired or cross-operation pages", async () => {
    const codec = new CursorCodec("x".repeat(32), 1000);
    const pager = new ResponsePager(codec, 1000, 4096);
    const action = vi.fn(async (): Promise<ToolPayload> => ({ kind: "collection", items: rows(0, 10) }));
    const first = await pager.run("search", { region: "KR" }, undefined, 10, action);
    const cursor = (first.structuredContent.page as { next_cursor: string }).next_cursor;
    expect(cursor).toMatch(/^buffer:/);
    const replay = () => pager.run("search", { region: "KR" }, cursor, 2, action);
    const one = await replay(), two = await replay();
    expect(one.structuredContent.items).toEqual(two.structuredContent.items);
    expect(one.structuredContent.meta).toMatchObject({ quota_cost: { data: 0, search: 0 } });
    expect(action).toHaveBeenCalledTimes(1);
    expect((await pager.run("other", { region: "KR" }, cursor, 10, action)).structuredContent).toMatchObject({ code: "CURSOR_MISMATCH" });
    const emptyPager = new ResponsePager(codec, 1000, 4096);
    expect((await emptyPager.run("search", { region: "KR" }, cursor, 10, action)).structuredContent).toMatchObject({ code: "CURSOR_MISMATCH" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    expect((await replay()).structuredContent).toMatchObject({ code: "CURSOR_MISMATCH" });
    expect(action).toHaveBeenCalledTimes(1);
  });
});
