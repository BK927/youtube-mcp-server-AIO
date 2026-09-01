import { YouTubeMcpError } from "../errors.js";
import type { QuotaStatus } from "../types.js";

export type QuotaBucket = "data" | "search";

interface DayUsage {
  data: number;
  search: number;
}

function pacificDay(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export class QuotaLedger {
  private day = pacificDay();
  private usage: DayUsage = { data: 0, search: 0 };

  constructor(
    private readonly dataBudget: number,
    private readonly searchBudget: number,
  ) {}

  private refreshDay(): void {
    const currentDay = pacificDay();
    if (currentDay !== this.day) {
      this.day = currentDay;
      this.usage = { data: 0, search: 0 };
    }
  }

  consume(bucket: QuotaBucket, amount = 1, operation?: string): void {
    this.refreshDay();
    if (!Number.isInteger(amount) || amount < 1) {
      throw new YouTubeMcpError(
        "INVALID_QUOTA_AMOUNT",
        "Quota consumption must be a positive integer.",
        { amount },
      );
    }

    const budget = bucket === "search" ? this.searchBudget : this.dataBudget;
    const used = this.usage[bucket];
    if (used + amount > budget) {
      throw new YouTubeMcpError(
        "LOCAL_QUOTA_GUARD",
        `Local ${bucket} quota guard blocked the request before the configured daily budget was exceeded.`,
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
    this.usage[bucket] += amount;
  }

  status(): QuotaStatus {
    this.refreshDay();
    return {
      day: this.day,
      timeZone: "America/Los_Angeles",
      data: {
        used: this.usage.data,
        budget: this.dataBudget,
        remaining: Math.max(0, this.dataBudget - this.usage.data),
      },
      search: {
        used: this.usage.search,
        budget: this.searchBudget,
        remaining: Math.max(0, this.searchBudget - this.usage.search),
      },
    };
  }
}
