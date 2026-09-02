export const PUBLIC_ERROR_CODES = [
  "INVALID_ARGUMENT",
  "AMBIGUOUS_REFERENCE",
  "NOT_FOUND",
  "AUTH_REQUIRED",
  "PROVIDER_UNAVAILABLE",
  "CURSOR_MISMATCH",
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "TIMEOUT",
  "JOB_NOT_READY",
  "JOB_EXPIRED",
] as const;

export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

const PUBLIC_ERROR_CODE_SET = new Set<string>(PUBLIC_ERROR_CODES);

export class YouTubeMcpError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly retryable: boolean | undefined;

  constructor(
    code: string,
    message: string,
    details?: unknown,
    retryable?: boolean,
  ) {
    super(message);
    this.name = "YouTubeMcpError";
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

function mappedCode(error: unknown): PublicErrorCode {
  if (error instanceof YouTubeMcpError) {
    if (PUBLIC_ERROR_CODE_SET.has(error.code)) {
      return error.code as PublicErrorCode;
    }
    if (error.code === "YOUTUBE_API_KEY_REQUIRED") return "AUTH_REQUIRED";
    if (error.code.endsWith("_NOT_FOUND")) return "NOT_FOUND";
    if (error.code.startsWith("INVALID_")) return "INVALID_ARGUMENT";
    if (error.code.includes("QUOTA") || error.code.includes("RATE")) {
      return "RATE_LIMITED";
    }
    if (error.code.includes("TRANSCRIPT_PROVIDER")) {
      return "PROVIDER_UNAVAILABLE";
    }
    if (error.code.includes("TIMEOUT")) return "TIMEOUT";
  }
  if (error instanceof Error && error.name === "AbortError") return "TIMEOUT";
  return "UPSTREAM_ERROR";
}

export function errorPayload(
  error: unknown,
  schemaUri = "youtube://schema/error",
): Record<string, unknown> {
  const code = mappedCode(error);
  const known = error instanceof YouTubeMcpError;
  const defaultRetryable = [
    "PROVIDER_UNAVAILABLE",
    "RATE_LIMITED",
    "UPSTREAM_ERROR",
    "TIMEOUT",
    "JOB_NOT_READY",
  ].includes(code);
  return {
    code,
    message: known ? error.message : "The upstream operation could not be completed.",
    retryable: known ? error.retryable ?? defaultRetryable : defaultRetryable,
    schema_uri: schemaUri,
    details: known ? error.details ?? {} : {},
  };
}
