import type { IncomingMessage, ServerResponse } from "node:http";

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function requestHostname(request: IncomingMessage): string | undefined {
  const host = firstHeader(request.headers.host)?.trim();
  if (!host) return undefined;

  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isHostAllowed(
  request: IncomingMessage,
  allowedHosts: readonly string[],
): boolean {
  if (allowedHosts.length === 0) return true;
  const hostname = requestHostname(request);
  return Boolean(hostname && allowedHosts.includes(hostname));
}

export function requestOrigin(request: IncomingMessage): string | undefined {
  const raw = firstHeader(request.headers.origin)?.trim();
  if (!raw) return undefined;

  try {
    return new URL(raw).origin;
  } catch {
    return "invalid";
  }
}

export function isOriginAllowed(
  request: IncomingMessage,
  allowedOrigins: readonly string[],
): boolean {
  const origin = requestOrigin(request);
  if (!origin) return true;
  if (origin === "invalid" || origin === "null") return false;
  return allowedOrigins.includes(origin);
}

export function sendForbidden(
  response: ServerResponse,
  message: string,
): void {
  const body = JSON.stringify({ error: "forbidden", message });
  response.writeHead(403, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body).toString(),
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

const ALLOWED_REQUEST_HEADERS = [
  "Authorization",
  "Content-Type",
  "Accept",
  "MCP-Protocol-Version",
  "MCP-Session-Id",
  "Last-Event-ID",
  "Mcp-Method",
  "Mcp-Name",
].join(", ");

export function sendCorsPreflight(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: readonly string[],
): void {
  const origin = requestOrigin(request);
  if (!origin || origin === "invalid" || !allowedOrigins.includes(origin)) {
    sendForbidden(response, "The request Origin is not allowed.");
    return;
  }

  response.writeHead(204, {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": ALLOWED_REQUEST_HEADERS,
    "Access-Control-Expose-Headers": "MCP-Session-Id",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    Vary: "Origin",
  });
  response.end();
}

export function withCors(response: Response, origin: string | undefined): Response {
  if (!origin || origin === "invalid" || origin === "null") return response;

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Expose-Headers", "MCP-Session-Id");
  headers.append("Vary", "Origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
