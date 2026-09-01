import { execFile } from "node:child_process";
import { YouTubeMcpError, errorMessage } from "../../errors.js";
import { SERVER_NAME, SERVER_VERSION } from "../../meta.js";
import type { TranscriptDocument } from "../../types.js";
import {
  parseJson3Transcript,
  parseVttTranscript,
} from "../../utils/transcript.js";
import type {
  TranscriptProvider,
  TranscriptRequest,
} from "./types.js";

interface ProcessResult {
  stdout: string;
  stderr: string;
}

interface SubtitleFormat {
  ext?: unknown;
  url?: unknown;
  name?: unknown;
}

interface YtDlpMetadata {
  subtitles?: Record<string, SubtitleFormat[]>;
  automatic_captions?: Record<string, SubtitleFormat[]>;
}

interface SelectedTrack {
  language: string;
  generated: boolean;
  format: "json3" | "vtt";
  url: string;
}

function runProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new YouTubeMcpError(
              "YT_DLP_FAILED",
              `yt-dlp failed: ${error.message}`,
              { stderr: stderr.trim().slice(0, 2_000) },
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function normalizeLanguage(value: string): string {
  return value.trim().toLocaleLowerCase().replaceAll("_", "-");
}

function findLanguage(
  tracks: Record<string, SubtitleFormat[]> | undefined,
  wanted: string,
): string | undefined {
  if (!tracks) return undefined;
  const normalizedWanted = normalizeLanguage(wanted);
  const keys = Object.keys(tracks);
  return keys.find((key) => {
    const normalized = normalizeLanguage(key);
    return (
      normalized === normalizedWanted ||
      normalized.startsWith(`${normalizedWanted}-`) ||
      normalizedWanted.startsWith(`${normalized}-`)
    );
  });
}

function selectFormat(
  formats: SubtitleFormat[] | undefined,
): { format: "json3" | "vtt"; url: string } | undefined {
  if (!formats) return undefined;
  for (const preferred of ["json3", "vtt"] as const) {
    const match = formats.find(
      (format) => format.ext === preferred && typeof format.url === "string",
    );
    if (match && typeof match.url === "string") {
      return { format: preferred, url: match.url };
    }
  }
  return undefined;
}

function chooseTrack(
  metadata: YtDlpMetadata,
  requestedLanguage: string | undefined,
  defaultLanguage: string,
): SelectedTrack | undefined {
  const manual = metadata.subtitles;
  const automatic = metadata.automatic_captions;
  const wantedLanguages = [requestedLanguage, defaultLanguage, "en"].filter(
    (value, index, values): value is string =>
      Boolean(value) && values.indexOf(value) === index,
  );

  for (const wanted of wantedLanguages) {
    for (const [source, generated] of [
      [manual, false],
      [automatic, true],
    ] as const) {
      const language = findLanguage(source, wanted);
      const selected = language ? selectFormat(source?.[language]) : undefined;
      if (language && selected) return { language, generated, ...selected };
    }
  }

  for (const [source, generated] of [
    [manual, false],
    [automatic, true],
  ] as const) {
    for (const language of Object.keys(source ?? {})) {
      const selected = selectFormat(source?.[language]);
      if (selected) return { language, generated, ...selected };
    }
  }
  return undefined;
}

async function fetchText(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": `${SERVER_NAME}/${SERVER_VERSION}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new YouTubeMcpError(
        "SUBTITLE_DOWNLOAD_FAILED",
        `Subtitle endpoint returned HTTP ${response.status}.`,
        { status: response.status },
      );
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export class YtDlpTranscriptProvider implements TranscriptProvider {
  readonly name = "yt-dlp";
  private availability: Promise<boolean> | undefined;

  constructor(
    private readonly executable: string,
    private readonly defaultLanguage: string,
    private readonly timeoutMs: number,
  ) {}

  isAvailable(): Promise<boolean> {
    this.availability ??= runProcess(
      this.executable,
      ["--version"],
      Math.min(this.timeoutMs, 5_000),
    )
      .then(() => true)
      .catch(() => false);
    return this.availability;
  }

  async fetchTranscript(
    request: TranscriptRequest,
  ): Promise<TranscriptDocument> {
    if (!(await this.isAvailable())) {
      throw new YouTubeMcpError(
        "YT_DLP_UNAVAILABLE",
        `yt-dlp was not found at '${this.executable}'.`,
      );
    }

    const videoUrl = `https://www.youtube.com/watch?v=${request.videoId}`;
    const { stdout } = await runProcess(
      this.executable,
      [
        "--dump-single-json",
        "--skip-download",
        "--no-warnings",
        "--no-playlist",
        videoUrl,
      ],
      Math.max(this.timeoutMs, 30_000),
    );

    let metadata: YtDlpMetadata;
    try {
      metadata = JSON.parse(stdout) as YtDlpMetadata;
    } catch (error) {
      throw new YouTubeMcpError(
        "YT_DLP_INVALID_JSON",
        `Could not parse yt-dlp metadata: ${errorMessage(error)}`,
      );
    }

    const selected = chooseTrack(
      metadata,
      request.language,
      this.defaultLanguage,
    );
    if (!selected) {
      throw new YouTubeMcpError(
        "TRANSCRIPT_NOT_FOUND",
        "yt-dlp found no manual or automatic subtitle track in JSON3 or VTT format.",
        { videoId: request.videoId },
      );
    }

    const response = await fetchText(selected.url, this.timeoutMs);
    let segments;
    if (selected.format === "json3") {
      const payload = (await response.json()) as unknown;
      segments = parseJson3Transcript(payload, request.videoId);
    } else {
      segments = parseVttTranscript(await response.text(), request.videoId);
    }

    if (segments.length === 0) {
      throw new YouTubeMcpError(
        "EMPTY_TRANSCRIPT",
        "The selected yt-dlp subtitle track contained no usable segments.",
        { videoId: request.videoId, language: selected.language },
      );
    }

    const availableLanguages = Array.from(
      new Set([
        ...Object.keys(metadata.subtitles ?? {}),
        ...Object.keys(metadata.automatic_captions ?? {}),
      ]),
    );

    return {
      videoId: request.videoId,
      provider: this.name,
      language: selected.language,
      availableLanguages,
      generated: selected.generated,
      segments,
      durationSeconds: segments.at(-1)?.endSeconds ?? 0,
      warnings: [
        "Transcript was retrieved through yt-dlp and YouTube's unofficial interfaces; availability can change without notice.",
      ],
    };
  }
}
