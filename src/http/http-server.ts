import {
  createServer,
  type IncomingMessage,
  type Server as NodeServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { errorMessage } from "../errors.js";
import { SERVER_NAME, SERVER_VERSION } from "../meta.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { createYoutubeMcpServer } from "../server.js";
import type { AppConfig } from "../types.js";
import { YouTubeService, type ServiceRuntimeInfo } from "../youtube-service.js";
import { authenticateMcpRequest, sendUnauthorized } from "./auth.js";
import { PersonalOAuthServer } from "./oauth.js";
import {
  HttpError,
  readRequestBody,
  sendJson,
  sendMethodNotAllowed,
  sendNotFound,
} from "./responses.js";
import {
  isHostAllowed,
  isOriginAllowed,
  sendCorsPreflight,
  sendForbidden,
  withCors,
} from "./security.js";

type AuthenticatedIncomingMessage = IncomingMessage & { auth?: AuthInfo };

export interface HttpServerHandle {
  server: NodeServer;
  localUrl: string;
  close(): Promise<void>;
}

function normalizedRequestPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
}

function publicEndpoint(
  runtime: RuntimeConfig,
  path: string,
): string | undefined {
  return runtime.http.publicBaseUrl
    ? `${runtime.http.publicBaseUrl}${path}`
    : undefined;
}

function createRuntimeInfo(runtime: RuntimeConfig): ServiceRuntimeInfo {
  return {
    transport: "streamable-http",
    endpoint: publicEndpoint(runtime, runtime.http.mcpPath),
    authentication: runtime.http.oauth
      ? "oauth2+static-bearer"
      : runtime.http.accessToken
        ? "static-bearer"
        : "none",
  };
}

function rootDocument(runtime: RuntimeConfig): Record<string, unknown> {
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    transport: "streamable-http",
    endpoints: {
      mcp: publicEndpoint(runtime, runtime.http.mcpPath) ?? runtime.http.mcpPath,
      health:
        publicEndpoint(runtime, runtime.http.healthPath) ?? runtime.http.healthPath,
    },
    mcpAuthentication: runtime.http.oauth
      ? "OAuth 2.1 (static bearer remains supported)"
      : runtime.http.accessToken
        ? "Authorization: Bearer <MCP_ACCESS_TOKEN>"
        : "none",
  };
}

function contentTypeIsJson(request: IncomingMessage): boolean {
  const raw = request.headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return Boolean(
    value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json",
  );
}

async function handleMcpRoute(
  request: AuthenticatedIncomingMessage,
  response: ServerResponse,
  runtime: RuntimeConfig,
  nodeMcpHandler: ReturnType<typeof toNodeHandler>,
  oauth: PersonalOAuthServer | undefined,
): Promise<void> {
  if (!isHostAllowed(request, runtime.http.allowedHosts)) {
    sendForbidden(response, "The request Host is not allowed.");
    return;
  }
  if (!isOriginAllowed(request, runtime.http.allowedOrigins)) {
    sendForbidden(response, "The request Origin is not allowed.");
    return;
  }
  if (request.method === "OPTIONS") {
    sendCorsPreflight(request, response, runtime.http.allowedOrigins);
    return;
  }

  const authentication = authenticateMcpRequest(
    request,
    runtime.http.accessToken,
    runtime.http.allowUnauthenticated,
    oauth,
  );
  if (!authentication.ok) {
    sendUnauthorized(response, oauth);
    return;
  }
  if (authentication.authInfo) request.auth = authentication.authInfo;
  else delete request.auth;

  const adapterRequest = request as unknown as Parameters<typeof nodeMcpHandler>[0];
  if (request.method === "POST") {
    if (!contentTypeIsJson(request)) {
      sendJson(response, 415, {
        jsonrpc: "2.0",
        error: { code: -32600, message: "Content-Type must be application/json" },
        id: null,
      });
      return;
    }
    const body = await readRequestBody(request, runtime.http.maxBodyBytes);
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      sendJson(response, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      });
      return;
    }
    await nodeMcpHandler(adapterRequest, response, parsedBody);
    return;
  }
  await nodeMcpHandler(adapterRequest, response);
}

function localListenUrl(server: NodeServer, configuredHost: string): string {
  const address = server.address() as AddressInfo | null;
  if (!address) return "http://127.0.0.1";
  const host = ["0.0.0.0", "::"].includes(configuredHost)
    ? "127.0.0.1"
    : configuredHost;
  return `http://${host}:${address.port}`;
}

export async function startHttpServer(
  appConfig: AppConfig,
  runtime: RuntimeConfig,
): Promise<HttpServerHandle> {
  const service = new YouTubeService(appConfig);
  const oauth = runtime.http.oauth
    ? new PersonalOAuthServer(runtime.http.oauth)
    : undefined;
  const serviceRuntime = createRuntimeInfo(runtime);
  const mcpHandler = createMcpHandler(
    () =>
      createYoutubeMcpServer(appConfig, {
        service,
        runtime: serviceRuntime,
      }),
    {
      legacy: "stateless",
      responseMode: "auto",
      keepAliveMs: 15_000,
      onerror: (error) => {
        console.error(`[${SERVER_NAME}] MCP handler: ${errorMessage(error)}`);
      },
    },
  );

  const corsAwareHandler = {
    fetch: async (
      request: Request,
      options?: Parameters<typeof mcpHandler.fetch>[1],
    ): Promise<Response> => {
      const response = await mcpHandler.fetch(request, options);
      return withCors(response, request.headers.get("origin") || undefined);
    },
  };
  const nodeMcpHandler = toNodeHandler(corsAwareHandler, {
    onerror: (error) => {
      console.error(`[${SERVER_NAME}] Node HTTP adapter: ${errorMessage(error)}`);
    },
  });

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || "/", "http://localhost");
      const path = normalizedRequestPath(url.pathname);

      if (oauth) {
        if (!isHostAllowed(request, runtime.http.allowedHosts)) {
          sendForbidden(response, "The request Host is not allowed.");
          return;
        }
        if (await oauth.handle(request, response, path, url)) return;
      }

      if (path === runtime.http.healthPath) {
        if (request.method !== "GET") {
          sendMethodNotAllowed(response, ["GET"]);
          return;
        }
        sendJson(response, 200, {
          ok: true,
          service: SERVER_NAME,
          version: SERVER_VERSION,
          uptimeSeconds: Math.floor(process.uptime()),
        });
        return;
      }

      if (path === "/") {
        if (request.method !== "GET") {
          sendMethodNotAllowed(response, ["GET"]);
          return;
        }
        sendJson(response, 200, rootDocument(runtime));
        return;
      }

      if (path === runtime.http.mcpPath) {
        await handleMcpRoute(
          request as AuthenticatedIncomingMessage,
          response,
          runtime,
          nodeMcpHandler,
          oauth,
        );
        return;
      }

      sendNotFound(response);
    })().catch((error: unknown) => {
      console.error(`[${SERVER_NAME}] HTTP request failed: ${errorMessage(error)}`);
      if (response.writableEnded) return;
      if (error instanceof HttpError) {
        sendJson(response, error.status, {
          error: error.code,
          message: error.message,
        });
        return;
      }
      sendJson(response, 500, {
        error: "internal_server_error",
        message: "The server could not complete the request.",
      });
    });
  });

  server.requestTimeout = runtime.http.requestTimeoutMs;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(runtime.http.port, runtime.http.host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      server.closeIdleConnections();
      await mcpHandler.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    })();
    return closePromise;
  };

  return {
    server,
    localUrl: localListenUrl(server, runtime.http.host),
    close,
  };
}
