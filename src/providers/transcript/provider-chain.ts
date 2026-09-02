import { YouTubeMcpError, errorMessage } from "../../errors.js";
import type { TranscriptDocument } from "../../types.js";
import type {
  TranscriptProvider,
  TranscriptProviderAttempt,
  TranscriptRequest,
} from "./types.js";

export class TranscriptProviderChain {
  constructor(private readonly providers: TranscriptProvider[]) {}

  get names(): string[] {
    return this.providers.map((provider) => provider.name);
  }

  async availability(): Promise<Record<string, boolean>> {
    const entries = await Promise.all(
      this.providers.map(async (provider) => [
        provider.name,
        await provider.isAvailable().catch(() => false),
      ] as const),
    );
    return Object.fromEntries(entries);
  }

  async fetchTranscript(
    request: TranscriptRequest,
  ): Promise<TranscriptDocument> {
    if (this.providers.length === 0) {
      throw new YouTubeMcpError(
        "TRANSCRIPT_PROVIDERS_DISABLED",
        "No transcript provider is enabled. Use hybrid or unofficial mode and configure a transcript provider.",
      );
    }

    const attempts: TranscriptProviderAttempt[] = [];
    for (const provider of this.providers) {
      const available = await provider.isAvailable().catch(() => false);
      if (!available) {
        attempts.push({
          provider: provider.name,
          available: false,
          error: "Provider is unavailable in this environment.",
        });
        continue;
      }

      try {
        const result = await provider.fetchTranscript(request);
        if (attempts.length > 0) {
          result.warnings.push(
            `Fallback provider '${provider.name}' succeeded after ${attempts.length} earlier attempt(s) failed or were unavailable.`,
          );
        }
        return result;
      } catch (error) {
        const message = errorMessage(error);
        attempts.push({
          provider: provider.name,
          available: true,
          error: message,
          ...(error instanceof YouTubeMcpError ? { code: error.code } : {}),
          ...(/sign in to confirm you(?:’re|'re| are) not a bot/iu.test(message)
            ? { blockedBy: "youtube_bot_challenge" as const }
            : {}),
        });
      }
    }

    const blockedByYouTube = attempts.some(
      (attempt) => attempt.blockedBy === "youtube_bot_challenge",
    );
    throw new YouTubeMcpError(
      "PROVIDER_UNAVAILABLE",
      blockedByYouTube
        ? "YouTube blocked transcript retrieval from this server environment. Retrying from the same server is unlikely to help."
        : "Configured public transcript providers could not retrieve this video.",
      {
        videoId: request.videoId,
        attempts,
        ...(blockedByYouTube
          ? {
              blockedBy: "youtube_bot_challenge",
              remediation:
                "Configure a managed transcript provider or an approved rotating residential proxy.",
            }
          : {}),
      },
      blockedByYouTube ? false : undefined,
    );
  }
}
