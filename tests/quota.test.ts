import { describe, expect, it } from "vitest";
import { QuotaLedger } from "../src/quota/quota-ledger.js";

describe("quota ledger", () => {
  it("tracks ordinary and search budgets separately", () => {
    const ledger = new QuotaLedger(3, 2);
    ledger.consume("data");
    ledger.consume("search");

    expect(ledger.status().data).toMatchObject({ used: 1, remaining: 2 });
    expect(ledger.status().search).toMatchObject({ used: 1, remaining: 1 });
  });

  it("blocks requests before a configured budget is exceeded", () => {
    const ledger = new QuotaLedger(1, 1);
    ledger.consume("search");
    expect(() => ledger.consume("search")).toThrow(/quota guard/i);
  });
});
