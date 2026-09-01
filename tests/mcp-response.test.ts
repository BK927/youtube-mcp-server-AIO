import { describe, expect, it } from "vitest";
import { YouTubeMcpError } from "../src/errors.js";
import {
  errorResult,
  resultByteLength,
  successResult,
} from "../src/mcp-response.js";

describe("MCP result envelope", () => {
  it("enforces the configured UTF-8 byte cap and exact page shape", () => {
    const result = successResult(
      {
        kind: "collection",
        data: { description: "x".repeat(20_000) },
        items: Array.from({ length: 50 }, (_, index) => ({
          index,
          text: "y".repeat(500),
        })),
        page: { returned: 50, has_more: true, next_cursor: "signed-cursor" },
        meta: { provider: "test" },
      },
      4_096,
    );
    expect(resultByteLength(result.structuredContent)).toBeLessThanOrEqual(4_096);
    expect(Object.keys(result.structuredContent.page as object).sort()).toEqual([
      "has_more",
      "next_cursor",
      "returned",
    ]);
    expect(result.structuredContent.job).toEqual({});
    expect(result.content[0]?.text).not.toContain("xxxxx");
    const page = result.structuredContent.page as {
      returned: number;
      has_more: boolean;
      next_cursor: string | null;
    };
    expect(page.returned).toBe(
      (result.structuredContent.items as unknown[]).length,
    );
    expect(page.has_more).toBe(Boolean(page.next_cursor));
  });

  it("marks exact item loss when the byte cap has no continuation cursor", () => {
    const originalItems = Array.from({ length: 100 }, (_, index) => ({
      index,
      text: `${index}:`.padEnd(2_000, "x"),
    }));
    const result = successResult(
      {
        kind: "collection",
        data: { source: "test" },
        items: originalItems,
      },
      4_096,
    );
    const envelope = result.structuredContent as {
      data: {
        truncation: {
          truncated: boolean;
          reason: string;
          original_items: number;
          returned_items: number;
          omitted_items: number;
        };
      };
      items: unknown[];
      page: { returned: number; has_more: boolean; next_cursor: string | null };
      meta: { warnings: string[] };
    };
    expect(envelope.items.length).toBeLessThan(originalItems.length);
    expect(envelope.data.truncation).toMatchObject({
      truncated: true,
      reason: "max_result_bytes",
      original_items: originalItems.length,
      returned_items: envelope.items.length,
      omitted_items: originalItems.length - envelope.items.length,
    });
    expect(envelope.meta.warnings).toContain(
      "Response items were shortened to the configured byte cap.",
    );
    expect(envelope.page).toEqual({
      returned: envelope.items.length,
      has_more: false,
      next_cursor: null,
    });
    expect(resultByteLength(envelope)).toBeLessThanOrEqual(4_096);
  });

  it("compacts every item before dropping any item", () => {
    const result = successResult(
      {
        kind: "collection",
        items: [
          { id: "first", text: "a".repeat(4_000) },
          { id: "second", text: "b".repeat(4_000) },
        ],
      },
      4_096,
    );
    const envelope = result.structuredContent as {
      data: { truncation: { original_items: number; omitted_items: number } };
      items: Array<{ id: string; text: string }>;
      page: { returned: number };
    };
    expect(envelope.items).toHaveLength(2);
    expect(envelope.items.every((item) => item.text.endsWith("..."))).toBe(true);
    expect(envelope.data.truncation).toMatchObject({
      original_items: 2,
      omitted_items: 0,
    });
    expect(envelope.page.returned).toBe(2);
  });

  it("stays below both default and hard envelope caps", () => {
    const payload = {
      kind: "collection" as const,
      data: { description: "가".repeat(20_000) },
      items: Array.from({ length: 100 }, () => ({ text: "나".repeat(500) })),
    };
    const defaultResult = successResult(payload, 12_288);
    const hardResult = successResult(payload, 32_768);
    expect(resultByteLength(defaultResult.structuredContent)).toBeLessThanOrEqual(
      12_288,
    );
    expect(resultByteLength(hardResult.structuredContent)).toBeLessThanOrEqual(
      32_768,
    );
  });

  it("emits only fixed top-level error fields for the calling operation", () => {
    const result = errorResult(
      "youtube_playlist_get",
      new YouTubeMcpError("PLAYLIST_NOT_FOUND", "Missing playlist"),
    );
    expect(result.structuredContent).toEqual({
      code: "NOT_FOUND",
      message: "Missing playlist",
      retryable: false,
      schema_uri: "youtube://schema/youtube_playlist_get",
      details: {},
    });
  });
});
