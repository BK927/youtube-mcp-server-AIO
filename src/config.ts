import type {
  AppConfig,
  ProviderMode,
  QuotaStoreMode,
  TranscriptProviderName,
} from "./types.js";
import { randomBytes } from "node:crypto";

const PROVIDER_MODES = new Set<ProviderMode>([
  "hybrid",
  "official",
  "unofficial",
]);
const TRANSCRIPT_PROVIDERS = new Set<TranscriptProviderName>([
  "yt-dlp",
  "youtubejs",
]);
const QUOTA_STORE_MODES = new Set<QuotaStoreMode>(["memory", "firestore"]);

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
  throw new Error(`${name} must be a boolean.`);
}

function readIntegerRange(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = readPositiveInteger(name, fallback, minimum);
  if (value > maximum) {
    throw new Error(`${name} must not exceed ${maximum}.`);
  }
  return value;
}

function readProviderMode(): ProviderMode {
  const raw = (process.env.YOUTUBE_PROVIDER_MODE?.trim() || "hybrid")
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

function readQuotaStoreMode(): QuotaStoreMode {
  const raw = (process.env.YOUTUBE_QUOTA_STORE?.trim() || "memory")
    .toLowerCase() as QuotaStoreMode;
  if (!QUOTA_STORE_MODES.has(raw)) {
    throw new Error("YOUTUBE_QUOTA_STORE must be memory or firestore.");
  }
  return raw;
}

export function loadConfig(): AppConfig {
  const apiKey = process.env.YOUTUBE_API_KEY?.trim() || undefined;
  const providerMode = readProviderMode();
  const explicitCursorSecret = process.env.YOUTUBE_CURSOR_SECRET?.trim();
  const mcpAccessToken = process.env.MCP_ACCESS_TOKEN?.trim();
  const cursorSecret =
    explicitCursorSecret || mcpAccessToken || randomBytes(32).toString("base64url");
  if (cursorSecret.length < 32) {
    throw new Error("YOUTUBE_CURSOR_SECRET must be at least 32 characters.");
  }

  return {
    apiKey,
    providerMode,
    transcriptProviders:
      providerMode === "official" ? [] : readTranscriptProviders(),
    ytDlpPath: process.env.YT_DLP_PATH?.trim() || "yt-dlp",
    ytDlpPotProviderEnabled: readBoolean(
      "YT_DLP_POT_PROVIDER_ENABLED",
      false,
    ),
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
    cursorSecret,
    cursorSecretSource: explicitCursorSecret
      ? "explicit"
      : mcpAccessToken
        ? "mcp-access-token"
        : "ephemeral",
    cursorTtlMs:
      readIntegerRange("YOUTUBE_CURSOR_TTL_SECONDS", 86_400, 30, 604_800) *
      1_000,
    maxResultBytes: readIntegerRange(
      "YOUTUBE_MAX_RESULT_BYTES",
      12 * 1_024,
      4 * 1_024,
      32 * 1_024,
    ),
    quotaStoreMode: readQuotaStoreMode(),
    firestoreProjectId:
      process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
      process.env.GCLOUD_PROJECT?.trim() ||
      undefined,
  };
}
