import { Firestore } from "@google-cloud/firestore";
import { afterAll, describe, expect, it } from "vitest";
import {
  FirestoreQuotaStore,
  type FirestoreLike,
} from "../src/quota/quota-store.js";

const emulatorEnabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const firestore = emulatorEnabled
  ? new Firestore({ projectId: `youtube-mcp-test-${process.pid}` })
  : undefined;

afterAll(async () => {
  await firestore?.terminate();
});

describe.skipIf(!emulatorEnabled)("Firestore emulator quota transaction", () => {
  it("atomically caps concurrent consumers", async () => {
    const store = new FirestoreQuotaStore(
      firestore as unknown as FirestoreLike,
      5,
      5,
      () => new Date("2037-04-05T12:00:00.000Z"),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => store.consume("data")),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(5);
    expect((await store.status()).data.used).toBe(5);
  }, 30_000);
});
