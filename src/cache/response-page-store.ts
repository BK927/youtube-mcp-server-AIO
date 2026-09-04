import { Firestore, Timestamp } from "@google-cloud/firestore";
import type { PageSnapshot, PageSnapshotStore } from "../response-pager.js";

/** Shared continuation snapshots for the existing multi-instance Cloud Run profile. */
export class FirestorePageStore implements PageSnapshotStore {
  private readonly db: Firestore;

  constructor(projectId: string | undefined, db?: Firestore) {
    this.db = db ?? new Firestore(projectId ? { projectId } : {});
  }

  async get(id: string): Promise<PageSnapshot | undefined> {
    const document = await this.db.collection("youtube_response_pages").doc(id).get();
    const value = document.data();
    if (!value || typeof value.payload !== "string" || !(value.delete_at instanceof Timestamp)) return undefined;
    const expiresAt = value.delete_at.toMillis();
    if (expiresAt <= Date.now()) return undefined;
    return { payload: JSON.parse(value.payload), expiresAt };
  }

  async put(id: string, snapshot: PageSnapshot): Promise<void> {
    await this.db.collection("youtube_response_pages").doc(id).set({
      payload: JSON.stringify(snapshot.payload),
      delete_at: Timestamp.fromMillis(snapshot.expiresAt),
    });
  }
}
