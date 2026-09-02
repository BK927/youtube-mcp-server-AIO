import { TtlCache, type AsyncCache } from "./cache/ttl-cache.js";
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
import { createQuotaStore, type QuotaStore } from "./quota/quota-store.js";
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

const VIDEO_CACHE_CAPACITY = 256;
const TRANSCRIPT_CACHE_CAPACITY = 32;

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
  authentication:
    | "local-process"
    | "oauth2+static-bearer"
    | "static-bearer"
    | "none";
}

export interface YouTubeServiceDependencies {
  quota?: QuotaStore;
  videoCache?: AsyncCache<Record<string, unknown>>;
  transcriptCache?: AsyncCache<TranscriptDocument>;
}

const DEFAULT_RUNTIME_INFO: ServiceRuntimeInfo = {
  transport: "stdio",
  endpoint: undefined,
  authentication: "local-process",
};

export class YouTubeService {
  private readonly quota: QuotaStore;
  private readonly dataApi: YouTubeDataApiClient | undefined;
  private readonly oEmbed: OEmbedClient;
  private readonly transcriptChain: TranscriptProviderChain;
  private readonly videoCache: AsyncCache<Record<string, unknown>>;
  private readonly transcriptCache: AsyncCache<TranscriptDocument>;

  constructor(
    readonly config: AppConfig,
    dependencies: YouTubeServiceDependencies = {},
  ) {
    this.quota = dependencies.quota ?? createQuotaStore(config);
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
            config.ytDlpPotProviderEnabled,
          );
        }
        return new YouTubeJsTranscriptProvider(
          config.defaultLanguage,
          config.requestTimeoutMs,
        );
      },
    );
    this.transcriptChain = new TranscriptProviderChain(transcriptProviders);
    this.videoCache =
      dependencies.videoCache ??
      new TtlCache(config.cacheTtlMs, VIDEO_CACHE_CAPACITY);
    this.transcriptCache =
      dependencies.transcriptCache ??
      new TtlCache(config.cacheTtlMs, TRANSCRIPT_CACHE_CAPACITY);
  }

  private requireDataApi(): YouTubeDataApiClient {
    if (this.dataApi) return this.dataApi;
    throw new YouTubeMcpError(
      "YOUTUBE_API_KEY_REQUIRED",
      this.config.providerMode === "unofficial"
        ? "This operation is unavailable in unofficial mode."
        : "This operation requires YOUTUBE_API_KEY.",
      { providerMode: this.config.providerMode },
    );
  }

  async catalog(
    runtime: ServiceRuntimeInfo = DEFAULT_RUNTIME_INFO,
  ): Promise<Record<string, unknown>> {
    const [transcriptAvailability, quota] = await Promise.all([
      this.transcriptChain.availability(),
      this.quota.status(),
    ]);
    return {
      server: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        transport: runtime.transport,
        endpoint: runtime.endpoint ?? null,
        authentication: runtime.authentication,
        readOnly: true,
      },
      tools: [
        "youtube_video_get",
        "youtube_search",
        "youtube_channel_get",
        "youtube_playlist_get",
      ],
      views: {
        youtube_video_get: ["metadata", "transcript", "comments"],
        youtube_search: ["global", "channel", "transcript", "trending"],
      },
      providers: {
        mode: this.config.providerMode,
        officialDataApi: Boolean(this.dataApi),
        transcriptOrder: this.transcriptChain.names,
        transcriptAvailability,
        ytDlpPotProviderEnabled: this.config.ytDlpPotProviderEnabled,
        defaultLanguage: this.config.defaultLanguage,
        defaultRegion: this.config.defaultRegion,
      },
      limits: {
        maxResultBytes: this.config.maxResultBytes,
        cursorTtlSeconds: Math.floor(this.config.cursorTtlMs / 1_000),
        videoCacheEntries: VIDEO_CACHE_CAPACITY,
        transcriptCacheEntries: TRANSCRIPT_CACHE_CAPACITY,
        cursorSecretSource: this.config.cursorSecretSource,
      },
      quota: {
        store: this.config.quotaStoreMode,
        ...quota,
      },
      warnings:
        this.config.cursorSecretSource === "ephemeral"
          ? [
              "Cursor signatures are process-local; set YOUTUBE_CURSOR_SECRET for restart and multi-instance continuity.",
            ]
          : [],
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
            `Official lookup failed; limited oEmbed metadata returned: ${errorMessage(error)}`,
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
    const document = await this.getTranscriptDocument(reference, options.language);
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
    const document = await this.getTranscriptDocument(reference, options.language);
    const fromSeconds = parseTimeInput(options.from);
    const toSeconds = parseTimeInput(options.to);
    if (
      fromSeconds !== undefined &&
      toSeconds !== undefined &&
      fromSeconds > toSeconds
    ) {
      throw new YouTubeMcpError(
        "INVALID_TIME_RANGE",
        "The transcript search start must not be after its end.",
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
    return this.requireDataApi().getChannel(extractChannelReference(reference));
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
    replyLimit: number,
  ): Promise<Record<string, unknown>> {
    return this.requireDataApi().listComments(
      extractVideoId(reference),
      maxResults,
      pageToken,
      order,
      includeReplies,
      replyLimit,
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
}
