import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import {
  emitSnapshot,
  emitUpdatesSnapshot,
  firestoreDocs,
  runTransaction,
  seedFirestoreShard,
  seedFirestoreUpdate,
  setDocCalls,
  setTransactionError,
} from "./_mocks/firestore";
import {
  createTestProvider,
  emitServerMissing,
  flushMicrotasks,
  TEST_PATH,
  whenTabFoldsIdle,
  FireProvider,
} from "./helpers";
import type { SnapshotAnomalyEvent } from "../provider";
import {
  CONTENT_STORAGE_PATH_FIELD,
  SNAPSHOT_BACKEND_FIELD,
  type SnapshotStore,
} from "../append-store";

/**
 * DEV-421: a stale Firestore cache entry can make the doc listener report a
 * shard as missing (`exists() === false`, `fromCache === false`) while it
 * exists on the server. `getDocFromServer` goes through the same listen
 * target, so the provider confirms with a transaction read instead.
 */

function baseAndUpdate(): { snapshot: Uint8Array; update: Uint8Array } {
  const base = new Y.Doc();
  base.getText("t").insert(0, "base");
  const snapshot = Y.encodeStateAsUpdate(base);
  const sv = Y.encodeStateVector(base);
  base.getText("t").insert(4, "+update");
  const update = Y.encodeStateAsUpdate(base, sv);
  base.destroy();
  return { snapshot, update };
}

async function flushAll() {
  for (let i = 0; i < 5; i++) await flushMicrotasks();
}

describe("stale cached 'missing' shard doc (DEV-421)", () => {
  let provider: FireProvider | undefined;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    setTransactionError(null);
    provider = undefined;
  });

  afterEach(async () => {
    setTransactionError(null);
    await whenTabFoldsIdle();
    if (provider) {
      await provider.kill();
      provider = undefined;
    }
    vi.mocked(console.log).mockRestore();
    vi.useRealTimers();
  });

  it("hydrates from a server read when the listener says missing but the doc exists", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const anomalies: SnapshotAnomalyEvent[] = [];
    provider.onSnapshotAnomaly = (event) => anomalies.push(event);
    const onServerReady = vi.fn();
    provider.onServerReady = onServerReady;

    const { snapshot, update } = baseAndUpdate();
    seedFirestoreShard(TEST_PATH, snapshot);
    seedFirestoreUpdate(TEST_PATH, "u1", update, { seq: 1 });

    await emitServerMissing(TEST_PATH);
    await flushAll();

    expect(created.ydoc.getText("t").toString()).toBe("base+update");
    expect(created.ydoc.store.pendingStructs).toBeNull();
    expect(provider.serverReady).toBe(true);
    expect(onServerReady).toHaveBeenCalledTimes(1);
    expect(anomalies).toEqual([
      { documentPath: TEST_PATH, kind: "listener-missing-doc-exists" },
    ]);
  });

  it("hydrates a snapshotStore shard from its Storage pointer", async () => {
    const { snapshot } = baseAndUpdate();
    const read = vi.fn(async () => snapshot);
    const store: SnapshotStore = {
      read,
      write: vi.fn(async () => ({ path: "unused" })),
    };
    const created = await createTestProvider({ snapshotStore: store });
    provider = created.provider;
    firestoreDocs.set(TEST_PATH, {
      [SNAPSHOT_BACKEND_FIELD]: "storage",
      [CONTENT_STORAGE_PATH_FIELD]: "snap/1",
    });

    await emitServerMissing(TEST_PATH);
    await flushAll();

    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ path: "snap/1" }),
    );
    expect(created.ydoc.getText("t").toString()).toBe("base");
    expect(provider.serverReady).toBe(true);
  });

  it("does not write a first snapshot over the doc it read from the server", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const { snapshot } = baseAndUpdate();
    seedFirestoreShard(TEST_PATH, snapshot);

    await emitServerMissing(TEST_PATH);
    await flushAll();
    created.ydoc.getText("t").insert(0, ">");
    await provider.saveToFirestore();

    const contentWrites = setDocCalls.filter(
      (c) =>
        c.ref.path === TEST_PATH &&
        (c.data as Record<string, unknown> | undefined)?.content !== undefined,
    );
    expect(contentWrites).toEqual([]);
    expect(firestoreDocs.get(TEST_PATH)?.content).toBeDefined();
  });

  it("keeps the confirmed-missing path for a shard that does not exist", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const anomalies: SnapshotAnomalyEvent[] = [];
    provider.onSnapshotAnomaly = (event) => anomalies.push(event);

    await emitServerMissing(TEST_PATH);
    await flushAll();

    expect(provider.serverReady).toBe(true);
    expect(created.ydoc.getText("t").toString()).toBe("");
    expect(anomalies).toEqual([]);
  });

  it("stays not server-ready and retries when the server read fails", async () => {
    vi.useFakeTimers();
    const created = await createTestProvider();
    provider = created.provider;
    const anomalies: SnapshotAnomalyEvent[] = [];
    provider.onSnapshotAnomaly = (event) => anomalies.push(event);
    const { snapshot } = baseAndUpdate();
    seedFirestoreShard(TEST_PATH, snapshot);

    setTransactionError({ code: "unavailable" });
    await emitServerMissing(TEST_PATH);
    await flushAll();

    expect(provider.serverReady).toBe(false);
    expect(anomalies).toEqual([
      { documentPath: TEST_PATH, kind: "missing-verify-failed" },
    ]);

    setTransactionError(null);
    await vi.advanceTimersByTimeAsync(1_000);
    // The retry re-subscribes; the stale listener says missing again.
    await emitServerMissing(TEST_PATH);
    await flushAll();

    expect(provider.serverReady).toBe(true);
    expect(created.ydoc.getText("t").toString()).toBe("base");
  });

  it("keeps the server read when only the transaction commit is refused", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const { snapshot } = baseAndUpdate();
    seedFirestoreShard(TEST_PATH, snapshot);
    vi.mocked(runTransaction).mockImplementationOnce(async (_db, updateFn) => {
      await updateFn({
        get: async () => ({
          exists: () => true,
          data: () => firestoreDocs.get(TEST_PATH),
        }),
      } as never);
      throw { code: "permission-denied" };
    });

    await emitServerMissing(TEST_PATH);
    await flushAll();

    expect(created.ydoc.getText("t").toString()).toBe("base");
    expect(provider.serverReady).toBe(true);
  });

  it("ignores later 'missing' snapshots once hydrated", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const { snapshot } = baseAndUpdate();
    seedFirestoreShard(TEST_PATH, snapshot);

    await emitServerMissing(TEST_PATH);
    await flushAll();
    const reads = vi.mocked(runTransaction).mock.calls.length;

    emitSnapshot(TEST_PATH, {
      exists: () => false,
      data: () => undefined,
      metadata: { fromCache: false, hasPendingWrites: false },
    });
    emitUpdatesSnapshot(TEST_PATH);
    await flushAll();

    expect(vi.mocked(runTransaction).mock.calls.length).toBe(reads);
    expect(created.ydoc.getText("t").toString()).toBe("base");
  });

  it("does not verify a cache-only 'missing' snapshot", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const before = vi.mocked(runTransaction).mock.calls.length;

    emitSnapshot(TEST_PATH, {
      exists: () => false,
      data: () => undefined,
      metadata: { fromCache: true, hasPendingWrites: false },
    });
    await flushAll();

    expect(vi.mocked(runTransaction).mock.calls.length).toBe(before);
    expect(provider.serverReady).toBe(false);
  });
});
