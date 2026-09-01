import { Firestore } from "@google-cloud/firestore";
import { YouTubeMcpError } from "../errors.js";
import type { AppConfig, QuotaStatus } from "../types.js";

export type QuotaBucket = "data" | "search";

interface DayUsage {
  data: number;
  search: number;
}

export interface QuotaStore {
  consume(bucket: QuotaBucket, amount?: number, operation?: string): Promise<void>;
  status(): Promise<QuotaStatus>;
}

export function pacificDay(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function positiveUsage(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function quotaStatus(
  day: string,
  usage: DayUsage,
  dataBudget: number,
  searchBudget: number,
): QuotaStatus {
  return {
    day,
    timeZone: "America/Los_Angeles",
    data: {
      used: usage.data,
      budget: dataBudget,
      remaining: Math.max(0, dataBudget - usage.data),
    },
    search: {
      used: usage.search,
      budget: searchBudget,
      remaining: Math.max(0, searchBudget - usage.search),
    },
  };
}

function validateConsumption(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new YouTubeMcpError(
      "INVALID_ARGUMENT",
      "Quota consumption must be a positive integer.",
      { amount },
    );
  }
}

function assertWithinBudget(
  bucket: QuotaBucket,
  amount: number,
  usage: DayUsage,
  dataBudget: number,
  searchBudget: number,
  operation?: string,
): void {
  const budget = bucket === "search" ? searchBudget : dataBudget;
  const used = usage[bucket];
  if (used + amount <= budget) return;
  throw new YouTubeMcpError(
    "RATE_LIMITED",
    `The ${bucket} quota guard blocked this request.`,
    {
      bucket,
      operation: operation ?? null,
      used,
      requested: amount,
      budget,
      resetTimeZone: "America/Los_Angeles",
    },
  );
}

export class MemoryQuotaStore implements QuotaStore {
  private day: string;
  private usage: DayUsage = { data: 0, search: 0 };

  constructor(
    private readonly dataBudget: number,
    private readonly searchBudget: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.day = pacificDay(now());
  }

  private refreshDay(): void {
    const currentDay = pacificDay(this.now());
    if (currentDay === this.day) return;
    this.day = currentDay;
    this.usage = { data: 0, search: 0 };
  }

  async consume(
    bucket: QuotaBucket,
    amount = 1,
    operation?: string,
  ): Promise<void> {
    validateConsumption(amount);
    this.refreshDay();
    assertWithinBudget(
      bucket,
      amount,
      this.usage,
      this.dataBudget,
      this.searchBudget,
      operation,
    );
    this.usage[bucket] += amount;
  }

  async status(): Promise<QuotaStatus> {
    this.refreshDay();
    return quotaStatus(
      this.day,
      this.usage,
      this.dataBudget,
      this.searchBudget,
    );
  }
}

export interface FirestoreDocumentSnapshotLike {
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface FirestoreDocumentReferenceLike {
  get(): Promise<FirestoreDocumentSnapshotLike>;
}

export interface FirestoreTransactionLike {
  get(
    reference: FirestoreDocumentReferenceLike,
  ): Promise<FirestoreDocumentSnapshotLike>;
  set(
    reference: FirestoreDocumentReferenceLike,
    data: Record<string, unknown>,
    options: { merge: boolean },
  ): unknown;
}

export interface FirestoreLike {
  collection(name: string): {
    doc(id: string): FirestoreDocumentReferenceLike;
  };
  runTransaction<T>(
    action: (transaction: FirestoreTransactionLike) => Promise<T>,
  ): Promise<T>;
}

export class FirestoreQuotaStore implements QuotaStore {
  constructor(
    private readonly firestore: FirestoreLike,
    private readonly dataBudget: number,
    private readonly searchBudget: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private reference(day: string): FirestoreDocumentReferenceLike {
    return this.firestore.collection("youtube_quota").doc(day);
  }

  private usage(snapshot: FirestoreDocumentSnapshotLike): DayUsage {
    const data = snapshot.exists ? snapshot.data() : undefined;
    return {
      data: positiveUsage(data?.dataUsed),
      search: positiveUsage(data?.searchUsed),
    };
  }

  async consume(
    bucket: QuotaBucket,
    amount = 1,
    operation?: string,
  ): Promise<void> {
    validateConsumption(amount);
    const day = pacificDay(this.now());
    const reference = this.reference(day);
    await this.firestore.runTransaction(async (transaction) => {
      const usage = this.usage(await transaction.get(reference));
      assertWithinBudget(
        bucket,
        amount,
        usage,
        this.dataBudget,
        this.searchBudget,
        operation,
      );
      usage[bucket] += amount;
      transaction.set(
        reference,
        {
          day,
          timeZone: "America/Los_Angeles",
          dataUsed: usage.data,
          searchUsed: usage.search,
          updatedAt: this.now().toISOString(),
          schemaVersion: 1,
        },
        { merge: true },
      );
    });
  }

  async status(): Promise<QuotaStatus> {
    const day = pacificDay(this.now());
    const usage = this.usage(await this.reference(day).get());
    return quotaStatus(day, usage, this.dataBudget, this.searchBudget);
  }
}

export function createQuotaStore(config: AppConfig): QuotaStore {
  if (config.quotaStoreMode === "firestore") {
    const firestore = new Firestore(
      config.firestoreProjectId ? { projectId: config.firestoreProjectId } : {},
    );
    return new FirestoreQuotaStore(
      firestore as unknown as FirestoreLike,
      config.apiDailyBudget,
      config.searchDailyBudget,
    );
  }
  return new MemoryQuotaStore(config.apiDailyBudget, config.searchDailyBudget);
}
