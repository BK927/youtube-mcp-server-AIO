import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache/ttl-cache.js";

describe("bounded TTL cache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new TtlCache<number>(60_000, 2);
    cache.set("first", 1);
    cache.set("second", 2);
    expect(cache.get("first")).toBe(1);
    cache.set("third", 3);
    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toBe(1);
    expect(cache.get("third")).toBe(3);
    expect(cache.size).toBe(2);
  });
});
