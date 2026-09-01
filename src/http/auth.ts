import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthInfo } from "@modelcontextprotocol/server";

export interface AuthenticationResult {
  ok: boolean;
  authInfo: AuthInfo | undefined;
}

function hashSecret(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function secretsMatch(
  candidate: string | undefined,
  expected: string | undefined,
): boolean {
  if (!candidate || !expected) return false;
  return timingSafeEqual(hashSecret(candidate), hashSecret(expected));
}

export function readBearerToken(
  authorization: string | string[] | undefined,
): string | undefined {
  const header = Array.isArray(authorization)
    ? authorization[0]
    : authorization;
  if (!header) return undefined;

  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

export function authenticateMcpRequest(
  request: IncomingMessage,
  accessToken: string | undefined,
  allowUnauthenticated: boolean,
): AuthenticationResult {
  if (!accessToken) {
    return {
      ok: allowUnauthenticated,
      authInfo: undefined,
    };
  }

  const supplied = readBearerToken(request.headers.authorization);
  if (!supplied || !secretsMatch(supplied, accessToken)) {
    return { ok: false, authInfo: undefined };
  }

  return {
    ok: true,
    authInfo: {
      token: supplied,
      clientId: "youtube-mcp-aio-static-token",
      scopes: ["youtube:read"],
      extra: {
        authenticationMethod: "static-bearer",
      },
    },
  };
}

export function sendUnauthorized(response: ServerResponse): void {
  const body = JSON.stringify({
    error: "unauthorized",
    message: "A valid Bearer token is required for this MCP endpoint.",
  });
  response.writeHead(401, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body).toString(),
    "WWW-Authenticate": 'Bearer realm="youtube-mcp-aio"',
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}
