import { describe, expect, it, vi } from "vitest";
import type { AsyncCache } from "../src/cache/ttl-cache.js";
import type { QuotaStore } from "../src/quota/quota-store.js";
import type { TranscriptDocument } from "../src/types.js";
import { YouTubeService } from "../src/youtube-service.js";
import { testAppConfig } from "./helpers.js";

describe("service dependency injection", () => {
  it("accepts cache and quota interfaces without changing providers", async () => {
    const getOrLoad = vi.fn(async () => ({
      id: "dQw4w9WgXcQ",
      provider: "injected-cache",
    }));
    const videoCache: AsyncCache<Record<string, unknown>> = { getOrLoad };
    const transcriptCache: AsyncCache<TranscriptDocument> = {
      getOrLoad: async (_key, loader) => loader(),
    };
    const quota: QuotaStore = {
      consume: async () => undefined,
      status: async () => ({
        day: "2026-01-01",
        timeZone: "America/Los_Angeles",
        data: { used: 0, budget: 100, remaining: 100 },
        search: { used: 0, budget: 10, remaining: 10 },
      }),
    };
    const service = new YouTubeService(testAppConfig(), {
      quota,
      videoCache,
      transcriptCache,
    });
    await expect(service.getVideo("dQw4w9WgXcQ")).resolves.toMatchObject({
      provider: "injected-cache",
    });
    expect(getOrLoad).toHaveBeenCalledOnce();
    await expect(service.catalog()).resolves.toMatchObject({
      quota: { store: "memory", data: { used: 0 } },
    });
  });
});
