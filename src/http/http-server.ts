import { createServer, type IncomingMessage, type Server as NodeServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { AppConfig } from "../types.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { googleOAuthRedirectUri } from "../runtime-config.js";
import { SERVER_NAME, SERVER_VERSION } from "../meta.js";
import { createYoutubeMcpServer } from "../server.js";
import { YouTubeService, type ServiceRuntimeInfo } from "../youtube-service.js";
import { errorMessage } from "../errors.js";
import { GoogleOAuthError, GoogleOAuthManager, type GoogleOAuthGrant } from "../oauth/google-oauth.js";
import { authenticateMcpRequest, secretsMatch, sendUnauthorized } from "./auth.js";
import { renderPage } from "./html.js";
import {
  HttpError,
  escapeHtml,
  readRequestBody,
  sendHtml,
  sendJson,
  sendMethodNotAllowed,
  sendNotFound,
  sendRedirect,
} from "./responses.js";
import {
  isHostAllowed,
  isOriginAllowed,
  requestOrigin,
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

function parseRequestUrl(request: IncomingMessage): URL {
  return new URL(request.url || "/", "http://localhost");
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
    authentication: runtime.http.accessToken ? "static-bearer" : "none",
    googleOAuth: {
      enabled: runtime.googleOAuth.enabled,
      redirectUri: googleOAuthRedirectUri(runtime),
      scopes: runtime.googleOAuth.scopes,
      refreshTokenConfigured: runtime.googleOAuth.refreshTokenConfigured,
    },
  };
}

function createGoogleOAuthManager(
  appConfig: AppConfig,
  runtime: RuntimeConfig,
): GoogleOAuthManager | undefined {
  if (!runtime.googleOAuth.enabled) return undefined;

  const redirectUri = googleOAuthRedirectUri(runtime);
  const { clientId, clientSecret, stateSecret } = runtime.googleOAuth;
  if (!redirectUri || !clientId || !clientSecret || !stateSecret) {
    throw new Error("Google OAuth is enabled but its runtime configuration is incomplete.");
  }

  return new GoogleOAuthManager({
    clientId,
    clientSecret,
    stateSecret,
    redirectUri,
    scopes: runtime.googleOAuth.scopes,
    stateTtlSeconds: runtime.googleOAuth.stateTtlSeconds,
    requestTimeoutMs: appConfig.requestTimeoutMs,
  });
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
      googleOAuthStatus:
        publicEndpoint(runtime, runtime.googleOAuth.statusPath) ??
        runtime.googleOAuth.statusPath,
      googleOAuthSetup:
        publicEndpoint(runtime, runtime.googleOAuth.setupPath) ??
        runtime.googleOAuth.setupPath,
      googleOAuthRedirectUri: googleOAuthRedirectUri(runtime) ?? null,
    },
    mcpAuthentication: runtime.http.accessToken
      ? "Authorization: Bearer <MCP_ACCESS_TOKEN>"
      : "none",
    googleOAuthPurpose:
      "Optional upstream authorization for owned-channel and future Analytics tools. It is separate from MCP client authentication.",
  };
}

function oauthStatus(runtime: RuntimeConfig): Record<string, unknown> {
  return {
    enabled: runtime.googleOAuth.enabled,
    configured: Boolean(
      runtime.googleOAuth.clientId &&
        runtime.googleOAuth.clientSecret &&
        runtime.googleOAuth.stateSecret &&
        runtime.googleOAuth.setupToken &&
        googleOAuthRedirectUri(runtime),
    ),
    redirectUri: googleOAuthRedirectUri(runtime) ?? null,
    authorizedJavaScriptOriginsRequired: false,
    scopes: runtime.googleOAuth.scopes,
    refreshTokenConfigured: runtime.googleOAuth.refreshTokenConfigured,
    note:
      "This Google OAuth connection authorizes access to YouTube user data; it does not authorize MCP clients to call /mcp.",
  };
}

function oauthSetupPage(runtime: RuntimeConfig): string {
  const redirectUri = googleOAuthRedirectUri(runtime);
  if (!runtime.googleOAuth.enabled || !redirectUri) {
    return renderPage(
      "Google OAuth is disabled",
      `<h1>Google OAuth is disabled</h1>
<p>Set <code>GOOGLE_OAUTH_ENABLED=true</code> together with the required client and secret settings, then deploy a new Cloud Run revision.</p>`,
    );
  }

  return renderPage(
    "Connect Google OAuth",
    `<h1>Connect a YouTube account</h1>
<p>This setup is for future owned-channel and Analytics features. Public YouTube search and comments only need <code>YOUTUBE_API_KEY</code>.</p>
<p><strong>Authorized redirect URI:</strong><br><code>${escapeHtml(redirectUri)}</code></p>
<p><strong>Authorized JavaScript origins:</strong> leave empty.</p>
<form method="post" action="${escapeHtml(runtime.googleOAuth.startPath)}">
  <label for="setup-token">OAuth setup token</label>
  <input id="setup-token" name="setup_token" type="password" autocomplete="one-time-code" required>
  <button type="submit">Continue to Google</button>
</form>
<p class="muted">The setup token is <code>GOOGLE_OAUTH_SETUP_TOKEN</code>, not the MCP access token.</p>`,
  );
}

function oauthGrantPage(grant: GoogleOAuthGrant): string {
  const refreshTokenBlock = grant.refreshToken
    ? `<p class="warning"><strong>Copy this refresh token now.</strong> Cloud Run's local filesystem and memory are not persistent. Store it in Secret Manager as <code>GOOGLE_OAUTH_REFRESH_TOKEN</code>, then deploy a new revision.</p>
<textarea readonly spellcheck="false">${escapeHtml(grant.refreshToken)}</textarea>`
    : `<p class="warning"><strong>No refresh token was returned.</strong> Re-run the setup flow. If this persists, revoke the app's existing access in your Google Account and authorize again.</p>`;

  const scopes = grant.grantedScopes.length
    ? grant.grantedScopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join("")
    : "<li>Google did not echo granted scopes.</li>";

  return renderPage(
    "Google OAuth connected",
    `<h1>Google authorization completed</h1>
${refreshTokenBlock}
<h2>Grant details</h2>
<ul>
  <li>Access token received: ${grant.accessTokenReceived ? "yes" : "no"}</li>
  <li>Expires in: ${grant.expiresInSeconds ?? "unknown"} seconds</li>
  <li>Token type: ${escapeHtml(grant.tokenType ?? "unknown")}</li>
  <li>ID token received: ${grant.idTokenReceived ? "yes" : "no"}</li>
</ul>
<h2>Granted scopes</h2><ul>${scopes}</ul>
<p class="muted">No OAuth token was written to the container filesystem or logs.</p>`,
  );
}

async function handleGoogleOAuthRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runtime: RuntimeConfig,
  manager: GoogleOAuthManager | undefined,
): Promise<boolean> {
  const path = normalizedRequestPath(url.pathname);

  if (path === runtime.googleOAuth.statusPath) {
    if (request.method !== "GET") {
      sendMethodNotAllowed(response, ["GET"]);
      return true;
    }
    sendJson(response, 200, oauthStatus(runtime));
    return true;
  }

  if (path === runtime.googleOAuth.setupPath) {
    if (request.method !== "GET") {
      sendMethodNotAllowed(response, ["GET"]);
      return true;
    }
    sendHtml(response, runtime.googleOAuth.enabled ? 200 : 503, oauthSetupPage(runtime));
    return true;
  }

  if (path === runtime.googleOAuth.startPath) {
    if (request.method !== "POST") {
      sendMethodNotAllowed(response, ["POST"]);
      return true;
    }
    if (!manager || !runtime.googleOAuth.setupToken) {
      sendJson(response, 503, {
        error: "google_oauth_disabled",
        message: "Google OAuth is not fully configured.",
      });
      return true;
    }

    const contentType = request.headers["content-type"] || "";
    if (!String(contentType).toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      sendJson(response, 415, {
        error: "unsupported_media_type",
        message: "Expected application/x-www-form-urlencoded.",
      });
      return true;
    }

    const body = await readRequestBody(request, 8 * 1024);
    const setupToken = new URLSearchParams(body).get("setup_token") || undefined;
    if (!secretsMatch(setupToken, runtime.googleOAuth.setupToken)) {
      sendForbidden(response, "The OAuth setup token is invalid.");
      return true;
    }

    sendRedirect(response, manager.createAuthorizationUrl());
    return true;
  }

  if (path === runtime.googleOAuth.redirectPath) {
    if (request.method !== "GET") {
      sendMethodNotAllowed(response, ["GET"]);
      return true;
    }
    if (!manager) {
      sendJson(response, 503, {
        error: "google_oauth_disabled",
        message: "Google OAuth is not fully configured.",
      });
      return true;
    }

    try {
      const grant = await manager.exchangeCallback(url);
      sendHtml(response, 200, oauthGrantPage(grant));
    } catch (error) {
      if (error instanceof GoogleOAuthError) {
        sendHtml(
          response,
          400,
          renderPage(
            "Google OAuth failed",
            `<h1>Google OAuth failed</h1><p><code>${escapeHtml(error.code)}</code></p><p>${escapeHtml(error.message)}</p>`,
          ),
        );
      } else {
        throw error;
      }
    }
    return true;
  }

  return false;
}

function contentTypeIsJson(request: IncomingMessage): boolean {
  const raw = request.headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return Boolean(value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json");
}

async function handleMcpRoute(
  request: AuthenticatedIncomingMessage,
  response: ServerResponse,
  runtime: RuntimeConfig,
  nodeMcpHandler: ReturnType<typeof toNodeHandler>,
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
  );
  if (!authentication.ok) {
    sendUnauthorized(response);
    return;
  }
  if (authentication.authInfo) {
    request.auth = authentication.authInfo;
  } else {
    delete request.auth;
  }
  const adapterRequest = request as unknown as Parameters<
    typeof nodeMcpHandler
  >[0];

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
  const serviceRuntime = createRuntimeInfo(runtime);
  const oauthManager = createGoogleOAuthManager(appConfig, runtime);

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
      const url = parseRequestUrl(request);
      const path = normalizedRequestPath(url.pathname);

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

      if (
        await handleGoogleOAuthRoute(
          request,
          response,
          url,
          runtime,
          oauthManager,
        )
      ) {
        return;
      }

      if (path === runtime.http.mcpPath) {
        await handleMcpRoute(
          request as AuthenticatedIncomingMessage,
          response,
          runtime,
          nodeMcpHandler,
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
