import { describe, expect, it } from "vitest";
import {
  FirestoreQuotaStore,
  MemoryQuotaStore,
  type FirestoreDocumentReferenceLike,
  type FirestoreDocumentSnapshotLike,
  type FirestoreLike,
  type FirestoreTransactionLike,
} from "../src/quota/quota-store.js";

class FakeFirestore implements FirestoreLike {
  readonly documents = new Map<string, Record<string, unknown>>();
  transactionCount = 0;
  private transactionTail: Promise<void> = Promise.resolve();

  collection(name: string) {
    return {
      doc: (id: string): FirestoreDocumentReferenceLike =>
        new FakeDocumentReference(`${name}/${id}`, this.documents),
    };
  }

  async runTransaction<T>(
    action: (transaction: FirestoreTransactionLike) => Promise<T>,
  ): Promise<T> {
    const previous = this.transactionTail;
    let release = (): void => undefined;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.transactionCount += 1;
    try {
      return await action({
        get: (reference) => reference.get(),
        set: (reference, data) => {
          const fake = reference as FakeDocumentReference;
          this.documents.set(fake.path, {
            ...(this.documents.get(fake.path) ?? {}),
            ...data,
          });
        },
      });
    } finally {
      release();
    }
  }
}

class FakeDocumentReference implements FirestoreDocumentReferenceLike {
  constructor(
    readonly path: string,
    private readonly documents: Map<string, Record<string, unknown>>,
  ) {}

  async get(): Promise<FirestoreDocumentSnapshotLike> {
    const value = this.documents.get(this.path);
    return {
      exists: Boolean(value),
      data: () => value,
    };
  }
}

describe("quota stores", () => {
  it("tracks memory budgets asynchronously and independently", async () => {
    const store = new MemoryQuotaStore(3, 2);
    await store.consume("data");
    await store.consume("search");
    expect((await store.status()).data).toMatchObject({ used: 1, remaining: 2 });
    expect((await store.status()).search).toMatchObject({ used: 1, remaining: 1 });
  });

  it("uses a Pacific-day Firestore transaction document", async () => {
    const firestore = new FakeFirestore();
    const now = () => new Date("2026-01-02T07:00:00.000Z");
    const store = new FirestoreQuotaStore(firestore, 3, 1, now);
    await store.consume("data", 2, "videos");
    await store.consume("search", 1, "search");

    expect(firestore.transactionCount).toBe(2);
    expect(firestore.documents.get("youtube_quota/2026-01-01")).toMatchObject({
      dataUsed: 2,
      searchUsed: 1,
      schemaVersion: 1,
      timeZone: "America/Los_Angeles",
    });
    expect(await store.status()).toMatchObject({
      day: "2026-01-01",
      data: { used: 2, remaining: 1 },
      search: { used: 1, remaining: 0 },
    });
    await expect(store.consume("search", 1, "search")).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("serializes concurrent increments without lost updates or budget overflow", async () => {
    const firestore = new FakeFirestore();
    const store = new FirestoreQuotaStore(
      firestore,
      5,
      5,
      () => new Date("2026-02-03T12:00:00.000Z"),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => store.consume("data")),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(5);
    expect((await store.status()).data).toMatchObject({
      used: 5,
      remaining: 0,
    });
    expect(firestore.documents.get("youtube_quota/2026-02-03")).toMatchObject({
      dataUsed: 5,
    });
  });
});
