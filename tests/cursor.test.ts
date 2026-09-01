import { describe, expect, it } from "vitest";
import { CursorCodec } from "../src/cursor.js";
import { YouTubeMcpError } from "../src/errors.js";

const SECRET = "cursor-secret-".repeat(4);

function expectCursorMismatch(action: () => unknown): void {
  try {
    action();
    throw new Error("Expected cursor mismatch");
  } catch (error) {
    expect(error).toBeInstanceOf(YouTubeMcpError);
    expect((error as YouTubeMcpError).code).toBe("CURSOR_MISMATCH");
  }
}

describe("HMAC cursor", () => {
  it("round-trips state while storing only a filter hash", () => {
    const codec = new CursorCodec(SECRET, 1_000, () => 10_000);
    const cursor = codec.encode(
      "youtube_search",
      { query: "private query", scope: "global" },
      { pageToken: "upstream-token" },
    );
    const encoded = cursor.split(".")[0]!;
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(payload.filterHash).toEqual(expect.any(String));
    expect(JSON.stringify(payload)).not.toContain("private query");
    expect(
      codec.decode(cursor, "youtube_search", {
        scope: "global",
        query: "private query",
      }),
    ).toEqual({ pageToken: "upstream-token" });
  });

  it("maps tampering, expiry, and filter changes to CURSOR_MISMATCH", () => {
    let now = 1_000;
    const codec = new CursorCodec(SECRET, 100, () => now);
    const filters = { scope: "global", query: "cats" };
    const cursor = codec.encode("youtube_search", filters, { pageToken: "next" });
    expectCursorMismatch(() =>
      codec.decode(`${cursor}x`, "youtube_search", filters),
    );
    expectCursorMismatch(() =>
      codec.decode(cursor, "youtube_search", { ...filters, query: "dogs" }),
    );
    now = 1_101;
    expectCursorMismatch(() => codec.decode(cursor, "youtube_search", filters));
  });
});
