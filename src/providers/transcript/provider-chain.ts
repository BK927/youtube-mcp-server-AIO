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
        attempts.push({
          provider: provider.name,
          available: true,
          error: errorMessage(error),
        });
      }
    }

    throw new YouTubeMcpError(
      "TRANSCRIPT_UNAVAILABLE",
      "Every configured transcript provider failed.",
      { videoId: request.videoId, attempts },
    );
  }
}
