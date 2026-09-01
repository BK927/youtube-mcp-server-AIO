import type { TranscriptDocument } from "../../types.js";

export interface TranscriptRequest {
  videoId: string;
  language: string | undefined;
}

export interface TranscriptProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  fetchTranscript(request: TranscriptRequest): Promise<TranscriptDocument>;
}

export interface TranscriptProviderAttempt {
  provider: string;
  available: boolean;
  error: string | undefined;
}
