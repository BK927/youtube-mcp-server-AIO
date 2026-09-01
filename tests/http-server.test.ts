import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  startHttpServer,
  type HttpServerHandle,
} from "../src/http/http-server.js";
import { createYoutubeMcpServer } from "../src/server.js";
import {
  TEST_ACCESS_TOKEN,
  testAppConfig,
  testRuntimeConfig,
} from "./helpers.js";

let handle: HttpServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("Streamable HTTP server", () => {
  it("preserves health/auth and serves the same registry as stdio", async () => {
    const appConfig = testAppConfig();
    handle = await startHttpServer(appConfig, testRuntimeConfig());

    const health = await fetch(`${handle.localUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      service: "youtube-mcp-aio",
      version: "1.1.0",
    });

    const unauthorized = await fetch(`${handle.localUrl}/mcp`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("Bearer");

    const httpClient = new Client({ name: "http-test", version: "1.0.0" });
    const httpTransport = new StreamableHTTPClientTransport(
      new URL(`${handle.localUrl}/mcp`),
      { authProvider: { token: async () => TEST_ACCESS_TOKEN } },
    );
    const stdioServer = createYoutubeMcpServer(appConfig);
    const stdioClient = new Client({ name: "stdio-test", version: "1.0.0" });
    const [stdioClientTransport, stdioServerTransport] =
      InMemoryTransport.createLinkedPair();
    await stdioServer.connect(stdioServerTransport);
    await Promise.all([
      httpClient.connect(httpTransport),
      stdioClient.connect(stdioClientTransport),
    ]);

    try {
      expect(await httpClient.listTools()).toEqual(await stdioClient.listTools());
      expect(await httpClient.listResources()).toEqual(
        await stdioClient.listResources(),
      );
      expect(await httpClient.listResourceTemplates()).toEqual(
        await stdioClient.listResourceTemplates(),
      );

      const catalog = await httpClient.readResource({ uri: "youtube://catalog" });
      const catalogContent = catalog.contents[0];
      const catalogText =
        catalogContent && "text" in catalogContent ? catalogContent.text : "";
      expect(catalogText).toContain(
        '"transport":"streamable-http"',
      );
      expect(catalogText).toContain(
        '"authentication":"static-bearer"',
      );
    } finally {
      await Promise.all([
        httpClient.close(),
        stdioClient.close(),
        stdioServer.close(),
      ]);
    }
  });

  it("enforces Origin and body-size guards before dispatch", async () => {
    handle = await startHttpServer(
      testAppConfig(),
      testRuntimeConfig({
        allowedOrigins: ["https://allowed.example"],
        maxBodyBytes: 1_024,
      }),
    );

    const badOrigin = await fetch(`${handle.localUrl}/mcp`, {
      headers: { Origin: "https://blocked.example" },
    });
    expect(badOrigin.status).toBe(403);

    const oversized = await fetch(`${handle.localUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ payload: "x".repeat(2_000) }),
    });
    expect(oversized.status).toBe(413);
  });

  it("rejects an unapproved Host before authentication", async () => {
    handle = await startHttpServer(
      testAppConfig(),
      testRuntimeConfig({ allowedHosts: ["allowed.example"] }),
    );
    const response = await fetch(`${handle.localUrl}/mcp`, {
      headers: { Host: "blocked.example" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden" });
  });
});
