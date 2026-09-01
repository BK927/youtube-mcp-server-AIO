#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { startHttpServer } from "./http/http-server.js";
import { SERVER_NAME } from "./meta.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { createYoutubeMcpServer } from "./server.js";
import { YouTubeService } from "./youtube-service.js";

loadDotenv({
  path: new URL("../.env", import.meta.url),
  quiet: true,
});

async function main(): Promise<void> {
  const appConfig = loadConfig();
  const runtime = loadRuntimeConfig();

  if (runtime.transport === "stdio") {
    const service = new YouTubeService(appConfig);
    serveStdio(() => createYoutubeMcpServer(appConfig, { service }), {
      onerror: (error) => {
        console.error(`[${SERVER_NAME}] stdio transport: ${errorMessage(error)}`);
      },
    });
    return;
  }

  const handle = await startHttpServer(appConfig, runtime);
  const advertisedUrl = runtime.http.publicBaseUrl || handle.localUrl;
  console.error(
    `[${SERVER_NAME}] Streamable HTTP listening at ${advertisedUrl}${runtime.http.mcpPath}`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[${SERVER_NAME}] received ${signal}; shutting down`);
    void handle
      .close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        console.error(`[${SERVER_NAME}] shutdown failed: ${errorMessage(error)}`);
        process.exitCode = 1;
      });
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error(`[${SERVER_NAME}] ${errorMessage(error)}`);
  process.exitCode = 1;
});
