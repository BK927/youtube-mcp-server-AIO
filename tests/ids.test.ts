import { describe, expect, it } from "vitest";
import {
  extractChannelReference,
  extractPlaylistId,
  extractVideoId,
  videoUrl,
} from "../src/utils/ids.js";

describe("YouTube reference parsing", () => {
  it.each([
    "dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42",
    "https://youtu.be/dQw4w9WgXcQ?si=test",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  ])("extracts video ID from %s", (input) => {
    expect(extractVideoId(input)).toBe("dQw4w9WgXcQ");
  });

  it("rejects non-YouTube video references", () => {
    expect(() => extractVideoId("https://example.com/dQw4w9WgXcQ")).toThrow();
  });

  it("extracts playlist IDs", () => {
    expect(
      extractPlaylistId(
        "https://www.youtube.com/playlist?list=PL1234567890abcdef",
      ),
    ).toBe("PL1234567890abcdef");
  });

  it("parses channel handles and IDs", () => {
    expect(extractChannelReference("@YouTube")).toEqual({
      kind: "handle",
      value: "YouTube",
    });
    expect(
      extractChannelReference("UC_x5XG1OV2P6uZZ5FSM9Ttw"),
    ).toEqual({ kind: "id", value: "UC_x5XG1OV2P6uZZ5FSM9Ttw" });
  });

  it("creates citation-ready timestamp URLs", () => {
    expect(videoUrl("dQw4w9WgXcQ", 65)).toContain("t=65s");
  });
});
