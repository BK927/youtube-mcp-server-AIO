import type {
  AppConfig,
  ProviderMode,
  TranscriptProviderName,
} from "./types.js";

const PROVIDER_MODES = new Set<ProviderMode>([
  "hybrid",
  "official",
  "unofficial",
]);
const TRANSCRIPT_PROVIDERS = new Set<TranscriptProviderName>([
  "yt-dlp",
  "youtubejs",
]);

function readPositiveInteger(
  name: string,
  fallback: number,
  minimum = 1,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return parsed;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false.`);
}

function readProviderMode(): ProviderMode {
  const raw = (process.env.YOUTUBE_PROVIDER_MODE ?? "hybrid")
    .trim()
    .toLowerCase() as ProviderMode;
  if (!PROVIDER_MODES.has(raw)) {
    throw new Error(
      "YOUTUBE_PROVIDER_MODE must be hybrid, official, or unofficial.",
    );
  }
  return raw;
}

function readTranscriptProviders(): TranscriptProviderName[] {
  const raw = process.env.YOUTUBE_TRANSCRIPT_PROVIDERS ?? "yt-dlp,youtubejs";
  const providers = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  const unique: TranscriptProviderName[] = [];
  for (const provider of providers) {
    if (!TRANSCRIPT_PROVIDERS.has(provider as TranscriptProviderName)) {
      throw new Error(
        `Unsupported transcript provider '${provider}'. Supported values: yt-dlp, youtubejs.`,
      );
    }
    if (!unique.includes(provider as TranscriptProviderName)) {
      unique.push(provider as TranscriptProviderName);
    }
  }
  return unique;
}

export function loadConfig(): AppConfig {
  const apiKey = process.env.YOUTUBE_API_KEY?.trim() || undefined;
  const providerMode = readProviderMode();

  return {
    apiKey,
    providerMode,
    transcriptProviders:
      providerMode === "official" ? [] : readTranscriptProviders(),
    ytDlpPath: process.env.YT_DLP_PATH?.trim() || "yt-dlp",
    defaultRegion:
      process.env.YOUTUBE_DEFAULT_REGION?.trim().toUpperCase() || "US",
    defaultLanguage:
      process.env.YOUTUBE_DEFAULT_LANGUAGE?.trim().toLowerCase() || "en",
    requestTimeoutMs: readPositiveInteger(
      "YOUTUBE_REQUEST_TIMEOUT_MS",
      15_000,
      1_000,
    ),
    cacheTtlMs:
      readPositiveInteger("YOUTUBE_CACHE_TTL_SECONDS", 900, 1) * 1_000,
    apiDailyBudget: readPositiveInteger(
      "YOUTUBE_API_DAILY_BUDGET",
      9_000,
      1,
    ),
    searchDailyBudget: readPositiveInteger(
      "YOUTUBE_SEARCH_DAILY_BUDGET",
      90,
      1,
    ),
    enableWriteTools: readBoolean("YOUTUBE_ENABLE_WRITE_TOOLS", false),
  };
}
