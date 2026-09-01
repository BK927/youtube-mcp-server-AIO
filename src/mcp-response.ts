import { errorPayload } from "./errors.js";

const SCHEMA_VERSION = "1";
export type ResultKind = "entity" | "collection" | "job";

export interface ToolPage {
  returned: number;
  has_more: boolean;
  next_cursor: string | null;
}

export interface ToolMeta {
  canonical_uri: string | null;
  source: string;
  provider: string;
  retrieved_at: string;
  fresh_until: string | null;
  quota_cost: { data: number; search: number } | null;
  warnings: string[];
  untrusted_fields: string[];
}

export interface ToolPayload {
  kind: ResultKind;
  data?: unknown;
  items?: unknown[];
  job?: unknown;
  page?: ToolPage;
  meta?: Partial<ToolMeta>;
}

function jsonString(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = JSON.parse(jsonString(value)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { value: parsed };
  }
  return parsed as Record<string, unknown>;
}

export function resultByteLength(value: unknown): number {
  return Buffer.byteLength(jsonString(value), "utf8");
}

function compactValue(value: unknown, depth = 0): unknown {
  if (depth >= 5) return "[depth capped]";
  if (typeof value === "string") {
    return value.length > 1_024 ? `${value.slice(0, 1_021)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => compactValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 40)
      .map(([key, item]) => [key, compactValue(item, depth + 1)]),
  );
}

function page(items: unknown[], nextCursor: string | null): ToolPage {
  return {
    returned: items.length,
    has_more: Boolean(nextCursor),
    next_cursor: nextCursor,
  };
}

function createEnvelope(payload: ToolPayload): Record<string, unknown> {
  const now = new Date().toISOString();
  const items = payload.items ?? [];
  const nextCursor = payload.page?.next_cursor ?? null;
  return jsonObject({
    schema_version: SCHEMA_VERSION,
    kind: payload.kind,
    data: payload.data ?? {},
    items,
    job: payload.job ?? {},
    page: page(items, nextCursor),
    meta: {
      canonical_uri: payload.meta?.canonical_uri ?? null,
      source: payload.meta?.source ?? "youtube",
      provider: payload.meta?.provider ?? "unknown",
      retrieved_at: payload.meta?.retrieved_at ?? now,
      fresh_until: payload.meta?.fresh_until ?? null,
      quota_cost: payload.meta?.quota_cost ?? null,
      warnings: payload.meta?.warnings ?? [],
      untrusted_fields: payload.meta?.untrusted_fields ?? [],
    },
  });
}

function withCapWarning(
  payload: ToolPayload,
  ...warnings: string[]
): Partial<ToolMeta> {
  return {
    ...payload.meta,
    warnings: [...new Set([...(payload.meta?.warnings ?? []), ...warnings])],
  };
}

function withTruncationMarker(
  data: unknown,
  originalItems: number,
  returnedItems: number,
  contentOmitted = false,
): Record<string, unknown> {
  const compacted = compactValue(data);
  const base =
    compacted && typeof compacted === "object" && !Array.isArray(compacted)
      ? (compacted as Record<string, unknown>)
      : { value: compacted };
  return {
    ...base,
    truncation: {
      truncated: true,
      reason: "max_result_bytes",
      fields_compacted: true,
      content_omitted: contentOmitted,
      original_items: originalItems,
      returned_items: returnedItems,
      omitted_items: originalItems - returnedItems,
    },
  };
}

function fitEnvelope(
  payload: ToolPayload,
  maxBytes: number,
): Record<string, unknown> {
  let envelope = createEnvelope(payload);
  if (resultByteLength(envelope) <= maxBytes) return envelope;

  const originalItems = payload.items ?? [];
  const items = originalItems.map((item) => compactValue(item));
  envelope = createEnvelope({
    ...payload,
    data: withTruncationMarker(payload.data, originalItems.length, items.length),
    items,
    meta: withCapWarning(
      payload,
      "Response fields were compacted to the configured byte cap.",
    ),
  });
  if (resultByteLength(envelope) <= maxBytes) return envelope;

  while (items.length > 0) {
    items.pop();
    envelope = createEnvelope({
      ...payload,
      data: withTruncationMarker(payload.data, originalItems.length, items.length),
      items,
      meta: withCapWarning(
        payload,
        "Response fields were compacted to the configured byte cap.",
        "Response items were shortened to the configured byte cap.",
      ),
    });
    if (resultByteLength(envelope) <= maxBytes) return envelope;
  }

  envelope = createEnvelope({
    ...payload,
    data: withTruncationMarker(payload.data, originalItems.length, 0),
    items: [],
    meta: withCapWarning(
      payload,
      "Response fields were compacted to the configured byte cap.",
    ),
  });
  if (resultByteLength(envelope) <= maxBytes) return envelope;

  return createEnvelope({
    kind: payload.kind,
    data: withTruncationMarker({}, originalItems.length, 0, true),
    page: page([], payload.page?.next_cursor ?? null),
    meta: {
      canonical_uri: payload.meta?.canonical_uri ?? null,
      provider: payload.meta?.provider ?? "unknown",
      warnings: ["Response content was omitted at the configured byte cap."],
    },
  });
}

export function successResult(payload: ToolPayload, maxBytes: number) {
  const envelope = fitEnvelope(payload, maxBytes);
  const resultPage = envelope.page as ToolPage;
  return {
    content: [
      {
        type: "text" as const,
        text: `${payload.kind} completed; returned=${resultPage.returned}; more=${resultPage.has_more ? "yes" : "no"}.`,
      },
    ],
    structuredContent: envelope,
  };
}

export function errorResult(operation: string, error: unknown) {
  const envelope = errorPayload(error, `youtube://schema/${operation}`);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `${String(envelope.code)} — ${String(envelope.message)}`,
      },
    ],
    structuredContent: envelope,
  };
}

export async function runTool(
  operation: string,
  action: () => Promise<ToolPayload> | ToolPayload,
  maxBytes: number,
) {
  try {
    return successResult(await action(), maxBytes);
  } catch (error) {
    return errorResult(operation, error);
  }
}
