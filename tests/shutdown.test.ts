import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  installGracefulShutdown,
  type SignalSource,
} from "../src/shutdown.js";

class FakeSignalSource extends EventEmitter implements SignalSource {
  exitCode: string | number | null | undefined;

  override once(event: "SIGTERM" | "SIGINT", listener: () => void): this {
    return super.once(event, listener);
  }
}

describe("graceful shutdown", () => {
  it("closes once on SIGTERM and sets a successful exit code", async () => {
    const source = new FakeSignalSource();
    const close = vi.fn(async () => undefined);
    const log = vi.fn();
    installGracefulShutdown({ close }, source, log);
    source.emit("SIGTERM");
    source.emit("SIGINT");
    await vi.waitFor(() => expect(source.exitCode).toBe(0));
    expect(close).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "[youtube-mcp-aio] received SIGTERM; shutting down",
    );
  });

  it("sets a failing exit code when server close rejects", async () => {
    const source = new FakeSignalSource();
    const log = vi.fn();
    installGracefulShutdown(
      { close: async () => Promise.reject(new Error("close failed")) },
      source,
      log,
    );
    source.emit("SIGTERM");
    await vi.waitFor(() => expect(source.exitCode).toBe(1));
    expect(log).toHaveBeenCalledWith(
      "[youtube-mcp-aio] shutdown failed: close failed",
    );
  });
});
