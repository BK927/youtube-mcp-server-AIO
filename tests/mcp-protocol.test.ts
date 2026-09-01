import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { createYoutubeMcpServer } from "../src/server.js";
import type { AppConfig } from "../src/types.js";

const testConfig: AppConfig = {
  apiKey: undefined,
  providerMode: "official",
  transcriptProviders: [],
  ytDlpPath: "yt-dlp",
  defaultRegion: "US",
  defaultLanguage: "en",
  requestTimeoutMs: 5_000,
  cacheTtlMs: 60_000,
  apiDailyBudget: 100,
  searchDailyBudget: 10,
  enableWriteTools: false,
};

describe("MCP protocol surface", () => {
  it("negotiates, lists tools, and calls a no-network tool", async () => {
    const server = createYoutubeMcpServer(testConfig);
    const client = new Client({ name: "youtube-aio-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toHaveLength(11);
      expect(names).toContain("youtube_transcript_search");
      expect(names).toContain("youtube_channel_videos");
      expect(names).toContain("youtube_quota_status");

      const result = await client.callTool({
        name: "youtube_quota_status",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(result.content[0]).toMatchObject({ type: "text" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
