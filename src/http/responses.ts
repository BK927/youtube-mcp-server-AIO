import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "http_error",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "Cache-Control": status >= 400 ? "no-store" : "no-cache",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body).toString(),
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

export function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html).toString(),
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  response.end(html);
}

export function sendRedirect(response: ServerResponse, location: string, status = 303): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    Location: location,
    "Content-Length": "0",
    "Referrer-Policy": "no-referrer",
  });
  response.end();
}

export function sendMethodNotAllowed(response: ServerResponse, allowedMethods: readonly string[]): void {
  sendJson(response, 405, {
    error: "method_not_allowed",
    message: `Allowed methods: ${allowedMethods.join(", ")}`,
  }, { Allow: allowedMethods.join(", ") });
}

export function sendNotFound(response: ServerResponse): void {
  sendJson(response, 404, {
    error: "not_found",
    message: "The requested endpoint does not exist.",
  });
}

export async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string") {
    const declared = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new HttpError(413, "Request body is too large.", "payload_too_large");
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) {
      throw new HttpError(413, "Request body is too large.", "payload_too_large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
