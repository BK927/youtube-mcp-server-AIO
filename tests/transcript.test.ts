import { describe, expect, it } from "vitest";
import {
  makeTranscriptSegment,
  parseJson3Transcript,
  parseVttTranscript,
  searchTranscriptSegments,
} from "../src/utils/transcript.js";

const videoId = "dQw4w9WgXcQ";

describe("transcript parsing and search", () => {
  it("parses JSON3 caption events", () => {
    const segments = parseJson3Transcript(
      {
        events: [
          {
            tStartMs: 1_000,
            dDurationMs: 2_500,
            segs: [{ utf8: "Hello " }, { utf8: "world" }],
          },
        ],
      },
      videoId,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      startSeconds: 1,
      endSeconds: 3.5,
      text: "Hello world",
      timestamp: "0:01",
    });
  });

  it("parses WebVTT cues", () => {
    const segments = parseVttTranscript(
      `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<c>Hello &amp; welcome</c>\n`,
      videoId,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe("Hello & welcome");
  });

  it("returns paginated matches with context and citation URLs", () => {
    const segments = [
      makeTranscriptSegment(videoId, 0, 0, 2, "alpha introduction"),
      makeTranscriptSegment(videoId, 1, 2, 4, "beta alpha evidence"),
      makeTranscriptSegment(videoId, 2, 4, 6, "closing alpha"),
    ];

    const result = searchTranscriptSegments(segments, "alpha", {
      matchMode: "word",
      caseSensitive: false,
      contextSegments: 1,
      fromSeconds: undefined,
      toSeconds: undefined,
      offset: 1,
      limit: 1,
    });

    expect(result.totalMatches).toBe(3);
    expect(result.nextOffset).toBe(2);
    expect(result.matches[0]?.segmentIndex).toBe(1);
    expect(result.matches[0]?.context).toHaveLength(3);
    expect(result.matches[0]?.url).toContain("t=2s");
  });
});
