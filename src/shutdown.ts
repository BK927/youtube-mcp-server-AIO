export interface CloseableServer {
  close(): Promise<void>;
}

export interface SignalSource {
  exitCode: string | number | null | undefined;
  once(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

export function installGracefulShutdown(
  handle: CloseableServer,
  source: SignalSource = process,
  log: (message: string) => void = (message) => console.error(message),
  label = "youtube-mcp-aio",
): (signal: "SIGTERM" | "SIGINT") => void {
  let shuttingDown = false;
  const shutdown = (signal: "SIGTERM" | "SIGINT"): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[${label}] received ${signal}; shutting down`);
    void handle
      .close()
      .then(() => {
        source.exitCode = 0;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`[${label}] shutdown failed: ${message}`);
        source.exitCode = 1;
      });
  };
  source.once("SIGTERM", () => shutdown("SIGTERM"));
  source.once("SIGINT", () => shutdown("SIGINT"));
  return shutdown;
}
