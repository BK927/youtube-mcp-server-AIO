import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { YouTubeMcpError } from "./errors.js";

interface CursorPayload {
  v: 1;
  operation: string;
  filterHash: string;
  state: Record<string, unknown>;
  expiresAt: number;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function filterHash(filters: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalJson(filters))
    .digest("base64url");
}

function signature(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

function invalidCursor(): YouTubeMcpError {
  return new YouTubeMcpError(
    "CURSOR_MISMATCH",
    "The cursor is invalid, expired, or does not match this request.",
  );
}

export class CursorCodec {
  constructor(
    private readonly secret: string,
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (secret.length < 32) {
      throw new Error("Cursor HMAC secret must contain at least 32 characters.");
    }
  }

  encode(
    operation: string,
    filters: Record<string, unknown>,
    state: Record<string, unknown>,
    expiresAt = this.now() + this.ttlMs,
  ): string {
    const payload: CursorPayload = {
      v: 1,
      operation,
      filterHash: filterHash(filters),
      state,
      expiresAt,
    };
    const encoded = Buffer.from(canonicalJson(payload)).toString("base64url");
    return `${encoded}.${signature(this.secret, encoded).toString("base64url")}`;
  }

  decode(
    cursor: string,
    operation: string,
    filters: Record<string, unknown>,
  ): Record<string, unknown> {
    const [encoded, encodedSignature, extra] = cursor.split(".");
    if (!encoded || !encodedSignature || extra !== undefined) {
      throw invalidCursor();
    }
    let suppliedSignature: Buffer;
    try {
      suppliedSignature = Buffer.from(encodedSignature, "base64url");
    } catch {
      throw invalidCursor();
    }
    const expectedSignature = signature(this.secret, encoded);
    if (
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw invalidCursor();
    }

    let payload: CursorPayload;
    try {
      payload = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as CursorPayload;
    } catch {
      throw invalidCursor();
    }
    if (
      payload.v !== 1 ||
      payload.operation !== operation ||
      typeof payload.filterHash !== "string" ||
      !Number.isSafeInteger(payload.expiresAt) ||
      !payload.state ||
      typeof payload.state !== "object"
    ) {
      throw invalidCursor();
    }
    if (payload.expiresAt <= this.now()) {
      throw invalidCursor();
    }
    if (payload.filterHash !== filterHash(filters)) {
      throw invalidCursor();
    }
    return payload.state;
  }
}
