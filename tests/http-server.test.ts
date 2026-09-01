import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { startHttpServer, type HttpServerHandle } from "../src/http/http-server.js";
import type { RuntimeConfig } from "../src/runtime-config.js";
import type { AppConfig } from "../src/types.js";

const ACCESS_TOKEN = "test-access-token-".repeat(4);

const appConfig: AppConfig = {
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

function runtimeConfig(): RuntimeConfig {
  return {
    transport: "http",
    http: {
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: undefined,
      mcpPath: "/mcp",
      healthPath: "/healthz",
      accessToken: ACCESS_TOKEN,
      allowUnauthenticated: false,
      allowedOrigins: [],
      allowedHosts: [],
      maxBodyBytes: 2 * 1024 * 1024,
      requestTimeoutMs: 300_000,
    },
    googleOAuth: {
      enabled: false,
      clientId: undefined,
      clientSecret: undefined,
      stateSecret: undefined,
      setupToken: undefined,
      refreshTokenConfigured: false,
      redirectPath: "/oauth/google/callback",
      setupPath: "/oauth/google/setup",
      startPath: "/oauth/google/start",
      statusPath: "/oauth/google/status",
      scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
      stateTtlSeconds: 600,
    },
  };
}

let handle: HttpServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("Streamable HTTP server", () => {
  it("serves health, protects MCP, and completes a real MCP exchange", async () => {
    handle = await startHttpServer(appConfig, runtimeConfig());

    const health = await fetch(`${handle.localUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      service: "youtube-mcp-server-aio",
      version: "0.2.0",
    });

    const unauthorized = await fetch(`${handle.localUrl}/mcp`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("Bearer");

    const client = new Client({ name: "http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${handle.localUrl}/mcp`),
      {
        authProvider: {
          token: async () => ACCESS_TOKEN,
        },
      },
    );

    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(11);
      expect(tools.map((tool) => tool.name)).toContain("youtube_capabilities");

      const result = await client.callTool({
        name: "youtube_capabilities",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      const text = result.content.find((content) => content.type === "text");
      expect(text?.type).toBe("text");
      if (text?.type === "text") {
        const capabilities = JSON.parse(text.text) as {
          server: { transport: string; authentication: string };
        };
        expect(capabilities.server.transport).toBe("streamable-http");
        expect(capabilities.server.authentication).toBe("static-bearer");
      }
    } finally {
      await client.close();
    }
  });
});
