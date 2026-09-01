import { YouTubeMcpError } from "../errors.js";
import type {
  TranscriptSearchMatch,
  TranscriptSegment,
} from "../types.js";
import { videoUrl } from "./ids.js";
import { formatTimestamp } from "./time.js";

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match)
    .replace(/&#(\d+);/g, (_, value: string) =>
      String.fromCodePoint(Number.parseInt(value, 10)),
    )
    .replace(/&#x([\da-f]+);/gi, (_, value: string) =>
      String.fromCodePoint(Number.parseInt(value, 16)),
    );
}

export function cleanTranscriptText(value: string): string {
  return decodeEntities(value)
    .replace(/<[^>]*>/g, "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function makeTranscriptSegment(
  videoId: string,
  index: number,
  startSeconds: number,
  endSeconds: number,
  text: string,
): TranscriptSegment {
  const roundedStart = Math.round(Math.max(0, startSeconds) * 1_000) / 1_000;
  const roundedEnd =
    Math.round(Math.max(roundedStart, endSeconds) * 1_000) / 1_000;
  return {
    index,
    startSeconds: roundedStart,
    durationSeconds:
      Math.round((roundedEnd - roundedStart) * 1_000) / 1_000,
    endSeconds: roundedEnd,
    timestamp: formatTimestamp(roundedStart),
    text: cleanTranscriptText(text),
    url: videoUrl(videoId, roundedStart),
  };
}

interface Json3Segment {
  utf8?: unknown;
}

interface Json3Event {
  tStartMs?: unknown;
  dDurationMs?: unknown;
  segs?: unknown;
}

export function parseJson3Transcript(
  input: unknown,
  videoId: string,
): TranscriptSegment[] {
  const root = input as { events?: unknown };
  if (!Array.isArray(root?.events)) return [];

  const segments: TranscriptSegment[] = [];
  for (const eventValue of root.events) {
    const event = eventValue as Json3Event;
    if (!Array.isArray(event.segs)) continue;

    const text = event.segs
      .map((segmentValue) => {
        const segment = segmentValue as Json3Segment;
        return typeof segment.utf8 === "string" ? segment.utf8 : "";
      })
      .join("");
    const cleaned = cleanTranscriptText(text);
    if (!cleaned) continue;

    const startMs = Number(event.tStartMs ?? 0);
    const durationMs = Number(event.dDurationMs ?? 0);
    if (!Number.isFinite(startMs) || !Number.isFinite(durationMs)) continue;

    segments.push(
      makeTranscriptSegment(
        videoId,
        segments.length,
        startMs / 1_000,
        (startMs + Math.max(0, durationMs)) / 1_000,
        cleaned,
      ),
    );
  }
  return segments;
}

function parseVttTimestamp(value: string): number | undefined {
  const match = value.trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/);
  if (!match) return undefined;
  return (
    Number(match[1] ?? 0) * 3_600 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0) +
    Number(match[4] ?? 0) / 1_000
  );
}

export function parseVttTranscript(
  input: string,
  videoId: string,
): TranscriptSegment[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const segments: TranscriptSegment[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const timingLine = lines[index]?.trim() ?? "";
    const timing = timingLine.match(
      /^([^\s]+)\s+-->\s+([^\s]+)(?:\s+.*)?$/,
    );
    if (!timing) continue;

    const start = parseVttTimestamp(timing[1] ?? "");
    const end = parseVttTimestamp(timing[2] ?? "");
    if (start === undefined || end === undefined) continue;

    const textLines: string[] = [];
    index += 1;
    while (index < lines.length && (lines[index]?.trim() ?? "") !== "") {
      textLines.push(lines[index] ?? "");
      index += 1;
    }

    const text = cleanTranscriptText(
      textLines
        .join(" ")
        .replace(/<\d{2}:\d{2}(?::\d{2})?[.,]\d{3}>/g, ""),
    );
    if (!text) continue;

    const previous = segments.at(-1);
    if (
      previous &&
      previous.text === text &&
      Math.abs(previous.endSeconds - end) < 0.01
    ) {
      continue;
    }

    segments.push(
      makeTranscriptSegment(videoId, segments.length, start, end, text),
    );
  }

  return segments;
}

export function renderTranscriptText(
  segments: TranscriptSegment[],
  includeTimestamps = true,
): string {
  return segments
    .map((segment) =>
      includeTimestamps
        ? `[${segment.timestamp}] ${segment.text}`
        : segment.text,
    )
    .join("\n");
}

export interface TranscriptSearchOptions {
  matchMode: "substring" | "word";
  caseSensitive: boolean;
  contextSegments: number;
  fromSeconds: number | undefined;
  toSeconds: number | undefined;
  offset: number;
  limit: number;
}

export interface TranscriptSearchResult {
  totalMatches: number;
  offset: number;
  limit: number;
  nextOffset: number | undefined;
  matches: TranscriptSearchMatch[];
}

function createMatcher(
  query: string,
  mode: "substring" | "word",
  caseSensitive: boolean,
): (text: string) => boolean {
  if (mode === "substring") {
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    return (text) =>
      (caseSensitive ? text : text.toLocaleLowerCase()).includes(needle);
  }

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flags = caseSensitive ? "u" : "iu";
  const expression = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
    flags,
  );
  return (text) => expression.test(text);
}

export function searchTranscriptSegments(
  segments: TranscriptSegment[],
  query: string,
  options: TranscriptSearchOptions,
): TranscriptSearchResult {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new YouTubeMcpError(
      "EMPTY_TRANSCRIPT_QUERY",
      "Transcript search query cannot be empty.",
    );
  }

  const matcher = createMatcher(
    trimmedQuery,
    options.matchMode,
    options.caseSensitive,
  );
  const matchedSegmentIndexes: number[] = [];

  for (const segment of segments) {
    if (
      options.fromSeconds !== undefined &&
      segment.endSeconds < options.fromSeconds
    ) {
      continue;
    }
    if (
      options.toSeconds !== undefined &&
      segment.startSeconds > options.toSeconds
    ) {
      continue;
    }
    if (matcher(segment.text)) matchedSegmentIndexes.push(segment.index);
  }

  const pageIndexes = matchedSegmentIndexes.slice(
    options.offset,
    options.offset + options.limit,
  );
  const matches = pageIndexes.map((segmentIndex, pageIndex) => {
    const segment = segments[segmentIndex];
    if (!segment) {
      throw new YouTubeMcpError(
        "TRANSCRIPT_INDEX_ERROR",
        "Transcript segment index became inconsistent.",
        { segmentIndex },
      );
    }

    const contextStart = Math.max(0, segmentIndex - options.contextSegments);
    const contextEnd = Math.min(
      segments.length,
      segmentIndex + options.contextSegments + 1,
    );
    return {
      matchIndex: options.offset + pageIndex,
      segmentIndex,
      startSeconds: segment.startSeconds,
      timestamp: segment.timestamp,
      url: segment.url,
      text: segment.text,
      context: segments.slice(contextStart, contextEnd),
    };
  });

  const nextOffset =
    options.offset + matches.length < matchedSegmentIndexes.length
      ? options.offset + matches.length
      : undefined;

  return {
    totalMatches: matchedSegmentIndexes.length,
    offset: options.offset,
    limit: options.limit,
    nextOffset,
    matches,
  };
}
