import type { Firestore } from "@google-cloud/firestore";
import { Timestamp } from "@google-cloud/firestore";
import { expect, it, vi } from "vitest";
import { FirestorePageStore } from "../src/cache/response-page-store.js";

it("stores complete snapshots with a Firestore TTL and refuses expired documents", async () => {
  let document: Record<string, unknown> | undefined;
  const doc = vi.fn(() => ({
    get: async () => ({ data: () => document }),
    set: async (value: Record<string, unknown>) => { document = value; },
  }));
  const collection = vi.fn(() => ({ doc }));
  const store = new FirestorePageStore(undefined, { collection } as unknown as Firestore);
  expect(await store.get("missing")).toBeUndefined();
  const snapshot = { payload: { kind: "collection" as const, items: [{ id: "video", title: "한글🙂" }] }, expiresAt: Date.now() + 60_000 };
  await store.put("page", snapshot);
  expect(collection).toHaveBeenCalledWith("youtube_response_pages");
  expect(await store.get("page")).toEqual(snapshot);
  expect(document?.delete_at).toBeInstanceOf(Timestamp);
  document = { ...document, delete_at: Timestamp.fromMillis(Date.now() - 1) };
  expect(await store.get("page")).toBeUndefined();
});
