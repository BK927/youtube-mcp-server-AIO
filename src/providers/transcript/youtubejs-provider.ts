import { Innertube } from "youtubei.js";
import { YouTubeMcpError, errorMessage } from "../../errors.js";
import { SERVER_NAME, SERVER_VERSION } from "../../meta.js";
import type { TranscriptDocument, TranscriptSegment } from "../../types.js";
import {
  makeTranscriptSegment,
  parseJson3Transcript,
  parseVttTranscript,
} from "../../utils/transcript.js";
import type {
  TranscriptProvider,
  TranscriptRequest,
} from "./types.js";

type InnertubeClient = Awaited<ReturnType<typeof Innertube.create>>;
type VideoInfo = Awaited<ReturnType<InnertubeClient["getInfo"]>>;

interface RawTranscriptSegment {
  start_ms?: unknown;
  end_ms?: unknown;
  snippet?: unknown;
}

interface CaptionTrack {
  base_url: string;
  language_code: string;
  name: unknown;
  kind?: "asr" | "frc";
  is_translatable: boolean;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "toString" in value) {
    return String(value);
  }
  return "";
}

function normalizeLanguage(value: string): string {
  return value.trim().toLocaleLowerCase().replaceAll("_", "-");
}

function languageMatches(track: CaptionTrack, wanted: string): boolean {
  const normalizedWanted = normalizeLanguage(wanted);
  const code = normalizeLanguage(track.language_code);
  const name = normalizeLanguage(textValue(track.name));
  return (
    code === normalizedWanted ||
    code.startsWith(`${normalizedWanted}-`) ||
    normalizedWanted.startsWith(`${code}-`) ||
    name === normalizedWanted
  );
}

function selectCaptionTrack(
  tracks: CaptionTrack[],
  requestedLanguage: string | undefined,
  defaultLanguage: string,
): { track: CaptionTrack; translateTo: string | undefined } | undefined {
  if (requestedLanguage) {
    const exactRequested = tracks.find((track) =>
      languageMatches(track, requestedLanguage),
    );
    if (exactRequested) {
      return { track: exactRequested, translateTo: undefined };
    }

    const translationBase =
      tracks.find((track) => languageMatches(track, defaultLanguage)) ??
      tracks.find((track) => track.kind !== "asr") ??
      tracks[0];
    if (translationBase?.is_translatable) {
      return { track: translationBase, translateTo: requestedLanguage };
    }
  }

  for (const wanted of [defaultLanguage, "en"]) {
    const exact = tracks.find((track) => languageMatches(track, wanted));
    if (exact) return { track: exact, translateTo: undefined };
  }

  const preferred =
    tracks.find((track) => track.kind !== "asr") ?? tracks[0];
  return preferred
    ? { track: preferred, translateTo: undefined }
    : undefined;
}

export class YouTubeJsTranscriptProvider implements TranscriptProvider {
  readonly name = "youtubejs";
  private clientPromise: Promise<InnertubeClient> | undefined;

  constructor(
    private readonly defaultLanguage: string,
    private readonly timeoutMs: number,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private getClient(): Promise<InnertubeClient> {
    this.clientPromise ??= Innertube.create({
      lang: this.defaultLanguage,
      retrieve_player: false,
      generate_session_locally: true,
    });
    return this.clientPromise;
  }

  private async fetchTranscriptEndpoint(
    info: VideoInfo,
    request: TranscriptRequest,
  ): Promise<TranscriptDocument> {
    let transcriptInfo = await info.getTranscript();
    const availableLanguages = [...transcriptInfo.languages];
    const warnings = [
      "Transcript was retrieved through YouTube's unofficial InnerTube interface; availability can change without notice.",
    ];

    if (request.language) {
      const wanted = normalizeLanguage(request.language);
      const selected = availableLanguages.find((language) => {
        const normalized = normalizeLanguage(language);
        return (
          normalized === wanted ||
          normalized.startsWith(`${wanted}-`) ||
          wanted.startsWith(`${normalized}-`)
        );
      });

      if (selected) {
        transcriptInfo = await transcriptInfo.selectLanguage(selected);
      } else {
        warnings.push(
          `Requested language '${request.language}' was unavailable; returned '${transcriptInfo.selectedLanguage}'.`,
        );
      }
    }

    const rawSegments =
      transcriptInfo.transcript.content?.body?.initial_segments ?? [];
    const segments: TranscriptSegment[] = [];

    for (const rawValue of rawSegments) {
      const raw = rawValue as unknown as RawTranscriptSegment;
      const startMs = Number(raw.start_ms);
      const endMs = Number(raw.end_ms);
      const text = textValue(raw.snippet);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !text.trim()) {
        continue;
      }
      segments.push(
        makeTranscriptSegment(
          request.videoId,
          segments.length,
          startMs / 1_000,
          endMs / 1_000,
          text,
        ),
      );
    }

    if (segments.length === 0) {
      throw new YouTubeMcpError(
        "EMPTY_TRANSCRIPT",
        "YouTube.js returned a transcript container but no usable segments.",
        { videoId: request.videoId },
      );
    }

    return {
      videoId: request.videoId,
      provider: this.name,
      language: transcriptInfo.selectedLanguage || request.language,
      availableLanguages,
      generated: undefined,
      segments,
      durationSeconds: segments.at(-1)?.endSeconds ?? 0,
      warnings,
    };
  }

  private async fetchCaptionTrack(
    info: VideoInfo,
    request: TranscriptRequest,
    priorError: unknown | undefined,
  ): Promise<TranscriptDocument> {
    const tracks = (info.captions?.caption_tracks ?? []) as CaptionTrack[];
    const selected = selectCaptionTrack(
      tracks,
      request.language,
      this.defaultLanguage,
    );
    if (!selected) {
      throw new YouTubeMcpError(
        "TRANSCRIPT_NOT_FOUND",
        "The video exposes neither a working transcript endpoint nor caption tracks.",
        {
          videoId: request.videoId,
          priorError: priorError ? errorMessage(priorError) : null,
        },
      );
    }

    const fetchFormat = async (format: "json3" | "vtt"): Promise<Response> => {
      const url = new URL(selected.track.base_url);
      url.searchParams.set("fmt", format);
      if (selected.translateTo) {
        url.searchParams.set("tlang", selected.translateTo);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          headers: { "user-agent": `${SERVER_NAME}/${SERVER_VERSION}` },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new YouTubeMcpError(
            "CAPTION_TRACK_REQUEST_FAILED",
            `Caption track returned HTTP ${response.status}.`,
            { status: response.status, format },
          );
        }
        return response;
      } finally {
        clearTimeout(timer);
      }
    };

    let segments: TranscriptSegment[] = [];
    let json3Error: unknown;
    try {
      const response = await fetchFormat("json3");
      segments = parseJson3Transcript(
        (await response.json()) as unknown,
        request.videoId,
      );
    } catch (error) {
      json3Error = error;
    }

    if (segments.length === 0) {
      try {
        const response = await fetchFormat("vtt");
        segments = parseVttTranscript(await response.text(), request.videoId);
      } catch (vttError) {
        throw new YouTubeMcpError(
          "CAPTION_TRACK_REQUEST_FAILED",
          "Both JSON3 and WebVTT caption-track fallbacks failed.",
          {
            json3Error: errorMessage(json3Error),
            vttError: errorMessage(vttError),
          },
        );
      }
    }

    if (segments.length === 0) {
      throw new YouTubeMcpError(
        "EMPTY_TRANSCRIPT",
        "Caption-track fallbacks returned no usable segments.",
        { videoId: request.videoId },
      );
    }

    return {
      videoId: request.videoId,
      provider: "youtubejs-caption-track",
      language:
        selected.translateTo ?? selected.track.language_code ?? request.language,
      availableLanguages: tracks.map((track) => track.language_code),
      generated: selected.track.kind === "asr",
      segments,
      durationSeconds: segments.at(-1)?.endSeconds ?? 0,
      warnings: [
        priorError
          ? `A previous YouTube.js transcript path failed before the direct caption track succeeded: ${errorMessage(priorError)}`
          : "Transcript was read directly from a YouTube player caption track.",
        "Caption tracks use YouTube's unofficial interfaces and can change without notice.",
      ],
    };
  }

  async fetchTranscript(
    request: TranscriptRequest,
  ): Promise<TranscriptDocument> {
    const client = await this.getClient();
    const clientErrors: string[] = [];

    for (const clientType of ["ANDROID", "IOS", "WEB"] as const) {
      try {
        const info = await client.getBasicInfo(request.videoId, {
          client: clientType,
        });
        if ((info.captions?.caption_tracks?.length ?? 0) > 0) {
          return await this.fetchCaptionTrack(info, request, undefined);
        }
      } catch (error) {
        clientErrors.push(`${clientType}: ${errorMessage(error)}`);
      }
    }

    try {
      const info = await client.getInfo(request.videoId);
      try {
        return await this.fetchTranscriptEndpoint(info, request);
      } catch (error) {
        return await this.fetchCaptionTrack(info, request, error);
      }
    } catch (error) {
      throw new YouTubeMcpError(
        "TRANSCRIPT_NOT_FOUND",
        "YouTube.js could not obtain a transcript or caption track from the tested player clients.",
        {
          videoId: request.videoId,
          playerClientErrors: clientErrors,
          finalError: errorMessage(error),
        },
      );
    }
  }
}
