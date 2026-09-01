import { TtlCache } from "./cache/ttl-cache.js";
import { YouTubeMcpError, errorMessage } from "./errors.js";
import { SERVER_NAME, SERVER_VERSION } from "./meta.js";
import { OEmbedClient } from "./providers/oembed-client.js";
import { TranscriptProviderChain } from "./providers/transcript/provider-chain.js";
import type { TranscriptProvider } from "./providers/transcript/types.js";
import { YouTubeJsTranscriptProvider } from "./providers/transcript/youtubejs-provider.js";
import { YtDlpTranscriptProvider } from "./providers/transcript/ytdlp-provider.js";
import {
  YouTubeDataApiClient,
  type SearchVideosOptions,
} from "./providers/youtube-data-api.js";
import { QuotaLedger } from "./quota/quota-ledger.js";
import type {
  AppConfig,
  TranscriptDocument,
  TranscriptPage,
} from "./types.js";
import {
  extractChannelReference,
  extractPlaylistId,
  extractVideoId,
} from "./utils/ids.js";
import { parseTimeInput } from "./utils/time.js";
import {
  renderTranscriptText,
  searchTranscriptSegments,
} from "./utils/transcript.js";

export interface TranscriptPageOptions {
  language: string | undefined;
  offset: number;
  limit: number;
  includeText: boolean;
  includeTimestamps: boolean;
}

export interface TranscriptSearchServiceOptions {
  language: string | undefined;
  matchMode: "substring" | "word";
  caseSensitive: boolean;
  contextSegments: number;
  from: string | number | undefined;
  to: string | number | undefined;
  offset: number;
  limit: number;
}

export interface ServiceRuntimeInfo {
  transport: "stdio" | "streamable-http";
  endpoint: string | undefined;
  authentication: "local-process" | "static-bearer" | "none";
  googleOAuth: {
    enabled: boolean;
    redirectUri: string | undefined;
    scopes: string[];
    refreshTokenConfigured: boolean;
  };
}

const DEFAULT_RUNTIME_INFO: ServiceRuntimeInfo = {
  transport: "stdio",
  endpoint: undefined,
  authentication: "local-process",
  googleOAuth: {
    enabled: false,
    redirectUri: undefined,
    scopes: [],
    refreshTokenConfigured: false,
  },
};

export class YouTubeService {
  private readonly quota: QuotaLedger;
  private readonly dataApi: YouTubeDataApiClient | undefined;
  private readonly oEmbed: OEmbedClient;
  private readonly transcriptChain: TranscriptProviderChain;
  private readonly videoCache: TtlCache<Record<string, unknown>>;
  private readonly transcriptCache: TtlCache<TranscriptDocument>;

  constructor(readonly config: AppConfig) {
    this.quota = new QuotaLedger(
      config.apiDailyBudget,
      config.searchDailyBudget,
    );
    this.dataApi =
      config.apiKey && config.providerMode !== "unofficial"
        ? new YouTubeDataApiClient(
            config.apiKey,
            config.requestTimeoutMs,
            this.quota,
          )
        : undefined;
    this.oEmbed = new OEmbedClient(config.requestTimeoutMs);

    const transcriptProviders: TranscriptProvider[] = config.transcriptProviders.map(
      (provider) => {
        if (provider === "yt-dlp") {
          return new YtDlpTranscriptProvider(
            config.ytDlpPath,
            config.defaultLanguage,
            config.requestTimeoutMs,
          );
        }
        return new YouTubeJsTranscriptProvider(
          config.defaultLanguage,
          config.requestTimeoutMs,
        );
      },
    );
    this.transcriptChain = new TranscriptProviderChain(transcriptProviders);
    this.videoCache = new TtlCache(config.cacheTtlMs);
    this.transcriptCache = new TtlCache(config.cacheTtlMs);
  }

  private requireDataApi(): YouTubeDataApiClient {
    if (this.dataApi) return this.dataApi;
    throw new YouTubeMcpError(
      "YOUTUBE_API_KEY_REQUIRED",
      this.config.providerMode === "unofficial"
        ? "This tool is disabled in unofficial mode. Switch YOUTUBE_PROVIDER_MODE to hybrid or official and provide YOUTUBE_API_KEY."
        : "This tool requires YOUTUBE_API_KEY. Transcript and limited video metadata remain available without it.",
    );
  }

  async capabilities(
    runtime: ServiceRuntimeInfo = DEFAULT_RUNTIME_INFO,
  ): Promise<Record<string, unknown>> {
    const transcriptAvailability = await this.transcriptChain.availability();
    return {
      server: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        transport: runtime.transport,
        endpoint: runtime.endpoint ?? null,
        authentication: runtime.authentication,
        readOnly: true,
      },
      googleOAuth: {
        purpose: "Optional upstream authorization for future owned-channel and Analytics tools; it does not authenticate MCP clients.",
        enabled: runtime.googleOAuth.enabled,
        redirectUri: runtime.googleOAuth.redirectUri ?? null,
        scopes: runtime.googleOAuth.scopes,
        refreshTokenConfigured: runtime.googleOAuth.refreshTokenConfigured,
      },
      mode: this.config.providerMode,
      officialDataApi: {
        enabled: Boolean(this.dataApi),
        apiKeyConfigured: Boolean(this.config.apiKey),
        availableTools: this.dataApi
          ? [
              "youtube_search",
              "youtube_channel_get",
              "youtube_channel_videos",
              "youtube_playlist_get",
              "youtube_comments_get",
              "youtube_trending",
            ]
          : [],
      },
      noKeyTools: [
        "youtube_capabilities",
        "youtube_video_get (limited oEmbed metadata)",
        "youtube_transcript_get (when an unofficial provider succeeds)",
        "youtube_transcript_search (when an unofficial provider succeeds)",
        "youtube_quota_status",
      ],
      transcript: {
        configuredOrder: this.transcriptChain.names,
        availability: transcriptAvailability,
        defaultLanguage: this.config.defaultLanguage,
        caveat:
          "Public transcripts require unofficial YouTube interfaces unless OAuth access to an owned video's captions is added later.",
      },
      safeguards: {
        writeToolsEnabled: this.config.enableWriteTools,
        writeToolsImplemented: false,
        localQuotaGuard: true,
        paginatedTranscriptResponses: true,
        apiDataCacheTtlSeconds: Math.floor(this.config.cacheTtlMs / 1_000),
      },
      quota: this.quota.status(),
    };
  }

  async getVideo(reference: string): Promise<Record<string, unknown>> {
    const videoId = extractVideoId(reference);
    return this.videoCache.getOrLoad(`video:${videoId}`, async () => {
      if (!this.dataApi) return this.oEmbed.getVideo(videoId);

      try {
        return await this.dataApi.getVideo(videoId);
      } catch (error) {
        if (this.config.providerMode !== "hybrid") throw error;
        const fallback = await this.oEmbed.getVideo(videoId);
        return {
          ...fallback,
          warnings: [
            `Official Data API lookup failed, so limited oEmbed metadata was returned: ${errorMessage(error)}`,
          ],
        };
      }
    });
  }

  private getTranscriptDocument(
    reference: string,
    language: string | undefined,
  ): Promise<TranscriptDocument> {
    const videoId = extractVideoId(reference);
    const normalizedLanguage = language?.trim().toLocaleLowerCase() || "auto";
    return this.transcriptCache.getOrLoad(
      `transcript:${videoId}:${normalizedLanguage}`,
      () =>
        this.transcriptChain.fetchTranscript({
          videoId,
          language: language?.trim() || undefined,
        }),
    );
  }

  async getTranscript(
    reference: string,
    options: TranscriptPageOptions,
  ): Promise<TranscriptPage> {
    const document = await this.getTranscriptDocument(
      reference,
      options.language,
    );
    const offset = Math.min(options.offset, document.segments.length);
    const segments = document.segments.slice(offset, offset + options.limit);
    const nextOffset =
      offset + segments.length < document.segments.length
        ? offset + segments.length
        : undefined;

    return {
      videoId: document.videoId,
      provider: document.provider,
      language: document.language,
      availableLanguages: document.availableLanguages,
      generated: document.generated,
      totalSegments: document.segments.length,
      durationSeconds: document.durationSeconds,
      offset,
      limit: options.limit,
      nextOffset,
      segments,
      text: options.includeText
        ? renderTranscriptText(segments, options.includeTimestamps)
        : undefined,
      warnings: document.warnings,
    };
  }

  async searchTranscript(
    reference: string,
    query: string,
    options: TranscriptSearchServiceOptions,
  ): Promise<Record<string, unknown>> {
    const document = await this.getTranscriptDocument(
      reference,
      options.language,
    );
    const fromSeconds = parseTimeInput(options.from);
    const toSeconds = parseTimeInput(options.to);
    if (
      fromSeconds !== undefined &&
      toSeconds !== undefined &&
      fromSeconds > toSeconds
    ) {
      throw new YouTubeMcpError(
        "INVALID_TIME_RANGE",
        "The transcript search start time must not be after the end time.",
        { fromSeconds, toSeconds },
      );
    }

    return {
      videoId: document.videoId,
      provider: document.provider,
      language: document.language,
      generated: document.generated,
      query,
      range: {
        fromSeconds: fromSeconds ?? null,
        toSeconds: toSeconds ?? null,
      },
      ...searchTranscriptSegments(document.segments, query, {
        matchMode: options.matchMode,
        caseSensitive: options.caseSensitive,
        contextSegments: options.contextSegments,
        fromSeconds,
        toSeconds,
        offset: options.offset,
        limit: options.limit,
      }),
      warnings: document.warnings,
    };
  }

  searchVideos(
    query: string,
    options: SearchVideosOptions,
  ): Promise<Record<string, unknown>> {
    return this.requireDataApi().searchVideos(query, options);
  }

  getChannel(reference: string): Promise<Record<string, unknown>> {
    return this.requireDataApi().getChannel(
      extractChannelReference(reference),
    );
  }

  listChannelVideos(
    reference: string,
    maxResults: number,
    pageToken: string | undefined,
  ): Promise<Record<string, unknown>> {
    return this.requireDataApi().listChannelVideos(
      extractChannelReference(reference),
      maxResults,
      pageToken,
    );
  }

  getPlaylist(
    reference: string,
    maxResults: number,
    pageToken: string | undefined,
    includeItems: boolean,
  ): Promise<Record<string, unknown>> {
    return this.requireDataApi().getPlaylist(
      extractPlaylistId(reference),
      maxResults,
      pageToken,
      includeItems,
    );
  }

  listComments(
    reference: string,
    maxResults: number,
    pageToken: string | undefined,
    order: "relevance" | "time",
    includeReplies: boolean,
  ): Promise<Record<string, unknown>> {
    return this.requireDataApi().listComments(
      extractVideoId(reference),
      maxResults,
      pageToken,
      order,
      includeReplies,
    );
  }

  trending(
    regionCode: string | undefined,
    categoryId: string | undefined,
    maxResults: number,
    pageToken: string | undefined,
  ): Promise<Record<string, unknown>> {
    return this.requireDataApi().trending(
      regionCode?.trim().toUpperCase() || this.config.defaultRegion,
      categoryId?.trim() || undefined,
      maxResults,
      pageToken,
    );
  }

  quotaStatus(): Record<string, unknown> {
    return {
      ...this.quota.status(),
      model:
        "Local guard for the current YouTube quota model: ordinary Data API operations and search.list calls are tracked in separate configured budgets.",
      caveat:
        "This process-local ledger cannot observe calls made by other apps sharing the same Google project.",
    };
  }
}
