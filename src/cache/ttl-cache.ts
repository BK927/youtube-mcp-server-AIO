interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface AsyncCache<T> {
  getOrLoad(
    key: string,
    loader: () => Promise<T>,
    ttlMs?: number,
  ): Promise<T>;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(
    private readonly defaultTtlMs: number,
    private readonly maxEntries = Number.POSITIVE_INFINITY,
  ) {
    if (!(maxEntries > 0)) {
      throw new Error("maxEntries must be greater than zero.");
    }
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs = this.defaultTtlMs): void {
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + Math.max(1, ttlMs),
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  async getOrLoad(
    key: string,
    loader: () => Promise<T>,
    ttlMs = this.defaultTtlMs,
  ): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = loader()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  get size(): number {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    return this.entries.size;
  }
}
