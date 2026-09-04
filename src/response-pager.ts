import { randomUUID } from "node:crypto";
import { TtlCache } from "./cache/ttl-cache.js";
import { CursorCodec } from "./cursor.js";
import { YouTubeMcpError } from "./errors.js";
import { errorResult, resultByteLength, successResult, type ToolPayload } from "./mcp-response.js";

const PREFIX = "buffer:";
const MAX_SNAPSHOT_BYTES = 512 * 1024;
export interface PageSnapshot { payload: ToolPayload; expiresAt: number }
export interface PageSnapshotStore {
  get(id: string): Promise<PageSnapshot | undefined>;
  put(id: string, snapshot: PageSnapshot): Promise<void>;
}

/** Keep the fetched page immutable while clients consume its bounded slices. */
export class ResponsePager {
  private readonly pages: TtlCache<PageSnapshot>;

  constructor(private readonly codec: CursorCodec, private readonly ttlMs: number, private readonly maxBytes: number, private readonly store?: PageSnapshotStore) {
    // At most 32 MiB of serialized snapshots, shared by the service's HTTP sessions.
    this.pages = new TtlCache(ttlMs, 64);
  }

  async run(
    operation: string,
    filters: Record<string, unknown>,
    cursor: string | undefined,
    limit: number,
    action: () => Promise<ToolPayload>,
  ) {
    try {
      let id = randomUUID();
      let start = 0;
      let expiresAt = Date.now() + this.ttlMs;
      let source: ToolPayload;
      const resumed = cursor?.startsWith(PREFIX);
      if (resumed && cursor) {
        const state = this.codec.decode(cursor.slice(PREFIX.length), `buffer:${operation}`, filters);
        if (typeof state.id !== "string" || !Number.isSafeInteger(state.offset) || (state.offset as number) < 0) {
          throw this.expired();
        }
        id = state.id as typeof id;
        start = state.offset as number;
        const saved = this.pages.get(id) ?? await this.store?.get(id);
        if (!saved || saved.expiresAt <= Date.now() || start >= (saved.payload.items?.length ?? 0)) throw this.expired();
        source = saved.payload;
        expiresAt = saved.expiresAt;
      } else {
        source = await action();
        source = { ...source, meta: { ...source.meta, retrieved_at: source.meta?.retrieved_at ?? new Date().toISOString() } };
      }
      const allItems = source.items ?? [];
      let deferred = false;
      const continuation = (returned: number) => {
        const offset = start + returned;
        if (offset >= allItems.length) return source.page?.next_cursor ?? null;
        deferred = true;
        return PREFIX + this.codec.encode(`buffer:${operation}`, filters, { id, offset }, expiresAt);
      };
      const items = allItems.slice(start, start + limit);
      const result = successResult({
        ...source,
        items,
        page: { returned: items.length, has_more: false, next_cursor: continuation(items.length) },
        meta: resumed ? { ...source.meta, quota_cost: { data: 0, search: 0 } } : source.meta ?? {},
      }, this.maxBytes, continuation);
      if (deferred && !resumed) {
        if (resultByteLength(source) > MAX_SNAPSHOT_BYTES) {
          throw new YouTubeMcpError("UPSTREAM_ERROR", "The fetched page exceeds the continuation cache limit. Use a smaller limit.");
        }
        const snapshot = { payload: structuredClone(source), expiresAt };
        await this.store?.put(id, snapshot);
        this.pages.set(id, snapshot);
      }
      return result;
    } catch (error) {
      return errorResult(operation, error);
    }
  }

  private expired() {
    return new YouTubeMcpError("CURSOR_MISMATCH", "The buffered page expired or is unavailable on this server. Restart this query; no items were skipped.");
  }
}
