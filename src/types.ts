export type ProviderMode = "hybrid" | "official" | "unofficial";
export type TranscriptProviderName = "yt-dlp" | "youtubejs";

export interface AppConfig {
  apiKey: string | undefined;
  providerMode: ProviderMode;
  transcriptProviders: TranscriptProviderName[];
  ytDlpPath: string;
  defaultRegion: string;
  defaultLanguage: string;
  requestTimeoutMs: number;
  cacheTtlMs: number;
  apiDailyBudget: number;
  searchDailyBudget: number;
  enableWriteTools: boolean;
}

export interface TranscriptSegment {
  index: number;
  startSeconds: number;
  durationSeconds: number;
  endSeconds: number;
  timestamp: string;
  text: string;
  url: string;
}

export interface TranscriptDocument {
  videoId: string;
  provider: string;
  language: string | undefined;
  availableLanguages: string[];
  generated: boolean | undefined;
  segments: TranscriptSegment[];
  durationSeconds: number;
  warnings: string[];
}

export interface TranscriptPage {
  videoId: string;
  provider: string;
  language: string | undefined;
  availableLanguages: string[];
  generated: boolean | undefined;
  totalSegments: number;
  durationSeconds: number;
  offset: number;
  limit: number;
  nextOffset: number | undefined;
  segments: TranscriptSegment[];
  text: string | undefined;
  warnings: string[];
}

export interface TranscriptSearchMatch {
  matchIndex: number;
  segmentIndex: number;
  startSeconds: number;
  timestamp: string;
  url: string;
  text: string;
  context: TranscriptSegment[];
}

export interface QuotaStatus {
  day: string;
  timeZone: "America/Los_Angeles";
  data: {
    used: number;
    budget: number;
    remaining: number;
  };
  search: {
    used: number;
    budget: number;
    remaining: number;
  };
}

export type JsonObject = Record<string, unknown>;
