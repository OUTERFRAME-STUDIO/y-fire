import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import {
  addDocCalls,
  deleteDocCalls,
  emitUpdatesSnapshot,
  firestoreCollections,
  firestoreDocs,
  getDocs,
  setAddDocError,
  setDocCalls,
  seedFirestoreUpdate,
  updatesPath,
} from "./_mocks/firestore";
import { getIdbDeleteCount, idbStore } from "./_mocks/idb";
import { setVisibilityState } from "./_mocks/lifecycle";
import {
  createTestProvider,
  decodeSavedDoc,
  decodeUpdateBytes,
  emitCacheUpdate,
  emitDocSnapshotOnly,
  emitServerMissing,
  emitServerUpdate,
  flushMicrotasks,
  hydrateControl,
  markServerReady,
  TEST_PATH,
  FireProvider,
} from "./helpers";

function sequentialPayload(): {
  control: Y.Doc;
  snapshot: Uint8Array;
  updates: Uint8Array[];
  text: string;
} {
  const control = new Y.Doc();
  const t = control.getText("t");
  t.insert(0, "Hello");
  const snapshot = Y.encodeStateAsUpdate(control);
  const sv1 = Y.encodeStateVector(control);
  t.insert(5, " ");
  const u1 = Y.encodeStateAsUpdate(control, sv1);
  const sv2 = Y.encodeStateVector(control);
  t.insert(6, "World");
  const u2 = Y.encodeStateAsUpdate(control, sv2);
  const sv3 = Y.encodeStateVector(control);
  t.insert(11, "!");
  const u3 = Y.encodeStateAsUpdate(control, sv3);
  return { control, snapshot, updates: [u1, u2, u3], text: "Hello World!" };
}

describe("append-only persistence", () => {
  let provider: FireProvider | undefined;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    setAddDocError(null);
    provider = undefined;
  });

  afterEach(async () => {
    if (provider) {
      await provider.kill();
      provider = undefined;
    }
    vi.mocked(console.log).mockRestore();
  });

  it("hydrates snapshot + 3 updates equal to a control doc", async () => {
    const { snapshot, updates, text } = sequentialPayload();
    const created = await createTestProvider();
    provider = created.provider;
    seedFirestoreUpdate(TEST_PATH, "u1", updates[0], { seq: 1 });
    seedFirestoreUpdate(TEST_PATH, "u2", updates[1], { seq: 2 });
    seedFirestoreUpdate(TEST_PATH, "u3", updates[2], { seq: 3 });
    emitServerUpdate(TEST_PATH, snapshot);
    await flushMicrotasks();

    expect(created.ydoc.getText("t").toString()).toBe(text);
    expect(provider.serverReady).toBe(true);
  });

  it("applies updates in reverse order to the same document", async () => {
    const { snapshot, updates, text } = sequentialPayload();
    const created = await createTestProvider();
    provider = created.provider;
    const reversed = [...updates].reverse();
    reversed.forEach((u, i) => {
      seedFirestoreUpdate(TEST_PATH, `r${i}`, u, { seq: updates.length - i });
    });

    const inOrder = hydrateControl(snapshot, updates);
    emitServerUpdate(TEST_PATH, snapshot);
    await flushMicrotasks();

    expect(created.ydoc.getText("t").toString()).toBe(inOrder.getText("t").toString());
    expect(created.ydoc.getText("t").toString()).toBe(text);
  });

  it("does not set serverReady until both the shard doc and updates listeners deliver a non-cache snapshot", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "server");
    const bytes = Y.encodeStateAsUpdate(remote);

    const created = await createTestProvider();
    provider = created.provider;
    const onServerReady = vi.fn();
    provider.onServerReady = onServerReady;

    emitDocSnapshotOnly(TEST_PATH, bytes);
    await flushMicrotasks();
    expect(provider.serverReady).toBe(false);
    expect(onServerReady).not.toHaveBeenCalled();

    emitUpdatesSnapshot(TEST_PATH, { fromCache: true, hasPendingWrites: false });
    await flushMicrotasks();
    expect(provider.serverReady).toBe(false);

    emitUpdatesSnapshot(TEST_PATH, { fromCache: false, hasPendingWrites: false });
    await flushMicrotasks();
    expect(provider.serverReady).toBe(true);
    expect(onServerReady).toHaveBeenCalledTimes(1);
  });

  it("skips hide-flush before both listeners are server-confirmed", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    created.ydoc.getText("t").insert(0, "local");
    provider.sendToFirestoreQueue();

    setVisibilityState("hidden");
    await flushMicrotasks();

    expect(addDocCalls.length).toBe(0);
    expect(setDocCalls.length).toBe(0);
    expect(provider.serverReady).toBe(false);
  });

  it("first write on a shard with no content writes the snapshot directly", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    created.ydoc.getText("t").insert(0, "genesis");
    await markServerReady(TEST_PATH);

    await provider.saveToFirestore();

    expect(addDocCalls.length).toBe(0);
    expect(setDocCalls.length).toBe(1);
    const saved = decodeSavedDoc(setDocCalls[0]?.data);
    expect(saved.getText("t").toString()).toBe("genesis");
    const payload = setDocCalls[0]?.data as { snapshotSV?: unknown; contentGeneration?: number };
    expect(payload.snapshotSV).toBeDefined();
    expect(payload.contentGeneration).toBeUndefined();
  });

  it("skips an empty delta append", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "already");
    const bytes = Y.encodeStateAsUpdate(remote);

    const created = await createTestProvider();
    provider = created.provider;
    emitServerUpdate(TEST_PATH, bytes);
    await flushMicrotasks();

    await provider.saveToFirestore();

    expect(addDocCalls.length).toBe(0);
  });

  it("legacy content-only docs hydrate and the first flush appends", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "legacy");
    const bytes = Y.encodeStateAsUpdate(remote);

    const created = await createTestProvider();
    provider = created.provider;
    emitServerUpdate(TEST_PATH, bytes);
    await flushMicrotasks();
    expect(created.ydoc.getText("t").toString()).toBe("legacy");

    created.ydoc.getText("t").insert(6, "!");
    await provider.saveToFirestore();

    expect(addDocCalls.length).toBe(1);
    const delta = decodeUpdateBytes(addDocCalls[0]?.data);
    const union = hydrateControl(bytes, [delta]);
    expect(union.getText("t").toString()).toBe("legacy!");
  });

  it("fold unions snapshot + read updates + local, deletes only folded ids, and does not bump epoch", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "base");
    const bytes = Y.encodeStateAsUpdate(remote);

    const created = await createTestProvider({ foldUpdateThreshold: 2 });
    provider = created.provider;
    emitServerUpdate(TEST_PATH, bytes);
    await flushMicrotasks();

    created.ydoc.getText("t").insert(4, "A");
    await provider.saveToFirestore();
    expect(addDocCalls.length).toBe(1);
    expect(firestoreCollections.get(updatesPath(TEST_PATH))?.size).toBe(1);

    created.ydoc.getText("t").insert(5, "B");
    await provider.saveToFirestore();

    const folded = firestoreDocs.get(TEST_PATH);
    expect(folded?.contentGeneration).toBeUndefined();
    const saved = decodeSavedDoc(folded);
    expect(saved.getText("t").toString()).toBe("baseAB");

    const remaining = firestoreCollections.get(updatesPath(TEST_PATH));
    expect(remaining?.size ?? 0).toBe(0);
    expect(deleteDocCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("fold survives a concurrent append by deleting only the ids it read", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "base");
    const bytes = Y.encodeStateAsUpdate(remote);

    const created = await createTestProvider({ foldUpdateThreshold: 2 });
    provider = created.provider;
    emitServerUpdate(TEST_PATH, bytes);
    await flushMicrotasks();

    created.ydoc.getText("t").insert(4, "A");
    await provider.saveToFirestore();
    created.ydoc.getText("t").insert(5, "B");

    const originalGetDocs = getDocs.getMockImplementation();
    getDocs.mockImplementation(async (ref) => {
      const col = firestoreCollections.get(ref.path) ?? new Map();
      const { makeQuerySnapshot } = await import("./_mocks/firestore");
      const result = makeQuerySnapshot(col);
      const late = new Y.Doc();
      late.getText("late").insert(0, "concurrent");
      seedFirestoreUpdate(TEST_PATH, "concurrent", Y.encodeStateAsUpdate(late), {
        seq: 99,
      });
      return result;
    });

    await provider.saveToFirestore();
    getDocs.mockImplementation(originalGetDocs as typeof originalGetDocs);

    const remaining = firestoreCollections.get(updatesPath(TEST_PATH));
    expect(remaining?.has("concurrent")).toBe(true);
    const saved = decodeSavedDoc(firestoreDocs.get(TEST_PATH));
    expect(saved.getText("t").toString()).toContain("base");
  });

  it("epoch bump fires onEpochReplace, does not union, and stops writing", async () => {
    const original = new Y.Doc();
    original.getText("t").insert(0, "AAAA");
    const originalBytes = Y.encodeStateAsUpdate(original);

    const replacement = new Y.Doc();
    replacement.getText("t").insert(0, "BBBB");
    const replacementBytes = Y.encodeStateAsUpdate(replacement);

    const created = await createTestProvider();
    provider = created.provider;
    const onEpochReplace = vi.fn();
    provider.onEpochReplace = onEpochReplace;

    emitServerUpdate(TEST_PATH, originalBytes, { epoch: 1 });
    await flushMicrotasks();
    expect(created.ydoc.getText("t").toString()).toBe("AAAA");

    emitServerUpdate(TEST_PATH, replacementBytes, { epoch: 2 });
    await flushMicrotasks();

    expect(onEpochReplace).toHaveBeenCalledWith({ from: 1, to: 2 });
    expect(created.ydoc.getText("t").toString()).toBe("AAAA");
    expect(created.ydoc.getText("t").toString()).not.toContain("BBBB");

    created.ydoc.getText("t").insert(4, "x");
    await provider.saveToFirestore();
    expect(addDocCalls.length).toBe(0);
  });

  it("drops a stale IndexedDB snapshot whose meta epoch is behind the server", async () => {
    const stale = new Y.Doc();
    stale.getText("t").insert(0, "OLD");
    const staleBytes = Y.encodeStateAsUpdate(stale);
    const fresh = new Y.Doc();
    fresh.getText("t").insert(0, "NEW");
    const freshBytes = Y.encodeStateAsUpdate(fresh);

    const created = await createTestProvider();
    provider = created.provider;
    const { encodeEpochMeta, persistenceMetaKey } = await import(
      "../persistence"
    );
    idbStore.set(TEST_PATH, staleBytes);
    idbStore.set(persistenceMetaKey(TEST_PATH), encodeEpochMeta(1));
    emitServerUpdate(TEST_PATH, freshBytes, { epoch: 2 });
    await flushMicrotasks();
    await provider.syncLocal();

    expect(created.ydoc.getText("t").toString()).toBe("NEW");
    expect(created.ydoc.getText("t").toString()).not.toContain("OLD");
  });

  it("size-aborts a delta larger than the cap and does not append", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "seed");
    const bytes = Y.encodeStateAsUpdate(remote);

    const created = await createTestProvider({ maxContentBytes: 1 });
    provider = created.provider;
    const onSaveError = vi.fn();
    provider.onSaveError = onSaveError;
    emitServerUpdate(TEST_PATH, bytes);
    await flushMicrotasks();

    created.ydoc.getText("t").insert(4, "!");
    await provider.saveToFirestore();

    expect(addDocCalls.length).toBe(0);
    expect(onSaveError.mock.calls.map((c) => (c[1] as { reason?: string })?.reason)).toContain(
      "size-abort",
    );
  });

  it("size-aborts a fold snapshot above the cap and keeps updates", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "base-content");
    const bytes = Y.encodeStateAsUpdate(remote);

    const created = await createTestProvider({ foldUpdateThreshold: 1 });
    provider = created.provider;
    emitServerUpdate(TEST_PATH, bytes);
    await flushMicrotasks();

    const sv = Y.encodeStateVector(created.ydoc);
    created.ydoc.getText("t").insert(12, "x");
    const delta = Y.encodeStateAsUpdate(created.ydoc, sv);
    const snapshotSize = Y.encodeStateAsUpdate(created.ydoc).byteLength;
    expect(delta.byteLength).toBeLessThan(snapshotSize);
    provider.maxContentBytes = snapshotSize - 1;
    expect(delta.byteLength).toBeLessThanOrEqual(provider.maxContentBytes);

    await provider.saveToFirestore();

    expect(addDocCalls.length).toBe(1);
    expect(firestoreCollections.get(updatesPath(TEST_PATH))?.size).toBe(1);
    const folded = firestoreDocs.get(TEST_PATH);
    expect(decodeSavedDoc(folded).getText("t").toString()).toBe("base-content");
  });

  it("warns when a fold snapshot is at least 70% of the cap but still folds", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "base");
    const bytes = Y.encodeStateAsUpdate(remote);

    const created = await createTestProvider({ foldUpdateThreshold: 1 });
    provider = created.provider;
    const onSaveWarning = vi.fn();
    provider.onSaveWarning = onSaveWarning;
    emitServerUpdate(TEST_PATH, bytes);
    await flushMicrotasks();

    created.ydoc.getText("t").insert(4, "X");
    const snapshotSize = Y.encodeStateAsUpdate(created.ydoc).byteLength;
    provider.maxContentBytes = Math.ceil(snapshotSize / 0.7);
    await provider.saveToFirestore();

    expect(onSaveWarning.mock.calls.map((c) => (c[0] as { reason?: string })?.reason)).toContain(
      "size-warn",
    );
    expect(firestoreCollections.get(updatesPath(TEST_PATH))?.size ?? 0).toBe(0);
  });

  it("offline addDoc failure keeps IDB, does not LWW-rewrite content, and fires onSaveError", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "server");
    const bytes = Y.encodeStateAsUpdate(remote);

    const created = await createTestProvider();
    provider = created.provider;
    emitServerUpdate(TEST_PATH, bytes);
    await flushMicrotasks();

    created.ydoc.getText("t").insert(6, "!");
    const onSaving = vi.fn();
    const onSaveError = vi.fn();
    provider.onSaving = onSaving;
    provider.onSaveError = onSaveError;
    setAddDocError(
      Object.assign(new Error("unavailable"), { code: "unavailable" }),
    );

    onSaving.mockClear();
    const deletesBefore = getIdbDeleteCount();
    await provider.saveToFirestore();

    expect(addDocCalls.length).toBe(0);
    expect(setDocCalls.length).toBe(0);
    expect(getIdbDeleteCount()).toBe(deletesBefore);
    expect(onSaveError).toHaveBeenCalled();
    expect(onSaving).not.toHaveBeenCalledWith(false);
  });
});
