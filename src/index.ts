#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { startHttpServer } from "./http/http-server.js";
import { SERVER_NAME } from "./meta.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { createYoutubeMcpServer } from "./server.js";
import { installGracefulShutdown } from "./shutdown.js";
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

  installGracefulShutdown(handle, process, (message) => console.error(message), SERVER_NAME);
}

main().catch((error: unknown) => {
  console.error(`[${SERVER_NAME}] ${errorMessage(error)}`);
  process.exitCode = 1;
});
