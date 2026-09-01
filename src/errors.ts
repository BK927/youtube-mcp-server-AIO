export class YouTubeMcpError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "YouTubeMcpError";
    this.code = code;
    this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

export function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof YouTubeMcpError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        details: error.details ?? null,
      },
    };
  }

  return {
    error: {
      code: "INTERNAL_ERROR",
      message: errorMessage(error),
    },
  };
}
