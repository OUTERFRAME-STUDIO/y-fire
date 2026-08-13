import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { setDocCalls, setTransactionError } from "./_mocks/firestore";
import { getIdbDeleteCount } from "./_mocks/idb";
import { setVisibilityState } from "./_mocks/lifecycle";
import {
  createTestProvider,
  decodeSavedDoc,
  emitCacheUpdate,
  emitServerMissing,
  emitServerUpdate,
  flushMicrotasks,
  markServerReady,
  TEST_PATH,
  FireProvider,
} from "./helpers";
import { seedFirestoreContent } from "./_mocks/firestore";

function lineage(): { cacheBytes: Uint8Array; serverBytes: Uint8Array } {
  const doc = new Y.Doc();
  doc.getText("old").insert(0, "old");
  const cacheBytes = Y.encodeStateAsUpdate(doc);
  doc.getText("new").insert(0, "new");
  const serverBytes = Y.encodeStateAsUpdate(doc);
  return { cacheBytes, serverBytes };
}

describe("merge-on-write", () => {
  let provider: FireProvider | undefined;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    setTransactionError(null);
    provider = undefined;
  });

  afterEach(async () => {
    if (provider) {
      await provider.kill();
      provider = undefined;
    }
    vi.mocked(console.log).mockRestore();
  });

  it("PATH 1: debounce after server snapshot writes the union", async () => {
    const { cacheBytes, serverBytes } = lineage();
    const created = await createTestProvider({
      maxWaitFirestoreTime: 50,
      maxFirestoreDeferral: 10_000,
    });
    provider = created.provider;
    const { ydoc } = created;

    emitCacheUpdate(TEST_PATH, cacheBytes);
    await flushMicrotasks();
    ydoc.getText("promptPatch").insert(0, "promptPatch");

    emitServerUpdate(TEST_PATH, serverBytes);
    await flushMicrotasks();

    await provider.saveToFirestore();

    expect(setDocCalls.length).toBe(1);
    const saved = decodeSavedDoc(setDocCalls[0]?.data);
    expect(saved.getText("old").toString()).toBe("old");
    expect(saved.getText("new").toString()).toBe("new");
    expect(saved.getText("promptPatch").toString()).toBe("promptPatch");
  });

  it("PATH 2: hide-flush before server snapshot does not write", async () => {
    const { cacheBytes, serverBytes } = lineage();
    const created = await createTestProvider();
    provider = created.provider;
    const { ydoc } = created;

    emitCacheUpdate(TEST_PATH, cacheBytes);
    await flushMicrotasks();
    expect(provider.serverReady).toBe(false);

    ydoc.getText("promptPatch").insert(0, "promptPatch");
    provider.sendToFirestoreQueue();

    setVisibilityState("hidden");
    await flushMicrotasks();

    expect(setDocCalls.length).toBe(0);
    expect(provider.serverReady).toBe(false);

    emitServerUpdate(TEST_PATH, serverBytes);
    await flushMicrotasks();
    provider.sendToFirestoreQueue();
    await provider.saveToFirestore();

    expect(setDocCalls.length).toBe(1);
    const saved = decodeSavedDoc(setDocCalls[0]?.data);
    expect(saved.getText("new").toString()).toBe("new");
    expect(saved.getText("promptPatch").toString()).toBe("promptPatch");
  });

  it("PATH 3: saveToFirestore before any snapshot does not LWW-encode an empty doc", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    await provider.saveToFirestore();
    expect(setDocCalls.length).toBe(0);
  });

  it("PATH 5: applying merged bytes back does not re-arm the Firestore queue", async () => {
    const remoteDoc = new Y.Doc();
    remoteDoc.getText("remote").insert(0, "only-on-server");
    const serverBytes = Y.encodeStateAsUpdate(remoteDoc);

    const created = await createTestProvider();
    provider = created.provider;
    const { ydoc } = created;
    ydoc.getText("local").insert(0, "local-only");
    await markServerReady(TEST_PATH);
    emitServerUpdate(TEST_PATH, serverBytes);
    await flushMicrotasks();

    const queueSpy = vi.spyOn(provider, "sendToFirestoreQueue");
    queueSpy.mockClear();

    await provider.saveToFirestore();

    expect(ydoc.getText("remote").toString()).toBe("only-on-server");
    expect(ydoc.getText("local").toString()).toBe("local-only");
    expect(queueSpy).not.toHaveBeenCalled();
  });

  it("offline transaction failure does not setDoc, keeps IDB, calls onSaveError, skips onSaving(false)", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    await markServerReady(TEST_PATH);
    const onSaving = vi.fn();
    const onSaveError = vi.fn();
    provider.onSaving = onSaving;
    provider.onSaveError = onSaveError;
    setTransactionError(
      Object.assign(new Error("unavailable"), { code: "unavailable" }),
    );

    onSaving.mockClear();
    await provider.saveToFirestore();

    expect(setDocCalls.length).toBe(0);
    expect(getIdbDeleteCount()).toBe(0);
    expect(onSaveError).toHaveBeenCalled();
    expect(onSaving).not.toHaveBeenCalledWith(false);
  });

  it("aborts the write when merged content exceeds 1 MiB", async () => {
    const created = await createTestProvider({ maxContentBytes: 1 });
    provider = created.provider;
    await markServerReady(TEST_PATH);
    const onSaveError = vi.fn();
    provider.onSaveError = onSaveError;

    await provider.saveToFirestore();

    expect(setDocCalls.length).toBe(0);
    expect(onSaveError.mock.calls.map((c) => (c[1] as { reason?: string })?.reason)).toContain(
      "size-abort",
    );
  });

  it("onServerReady fires on server metadata, not cache", async () => {
    const { cacheBytes, serverBytes } = lineage();
    const created = await createTestProvider();
    provider = created.provider;
    const onReady = vi.fn();
    const onServerReady = vi.fn();
    provider.onReady = onReady;
    provider.onServerReady = onServerReady;

    emitCacheUpdate(TEST_PATH, cacheBytes);
    await flushMicrotasks();

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onServerReady).not.toHaveBeenCalled();
    expect(provider.serverReady).toBe(false);
    expect(provider.ready).toBe(true);

    emitServerUpdate(TEST_PATH, serverBytes);
    await flushMicrotasks();

    expect(onServerReady).toHaveBeenCalledTimes(1);
    expect(provider.serverReady).toBe(true);
  });

  it("server-confirmed missing doc still marks serverReady", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const onServerReady = vi.fn();
    provider.onServerReady = onServerReady;

    await emitServerMissing(TEST_PATH);

    expect(onServerReady).toHaveBeenCalledTimes(1);
    expect(provider.serverReady).toBe(true);
    expect(provider.ready).toBe(false);
  });

  it("emits shrink warning when local replica is missing remote structs, still writes the union", async () => {
    const { cacheBytes, serverBytes } = lineage();
    const created = await createTestProvider();
    provider = created.provider;
    const { ydoc } = created;
    const onSaveWarning = vi.fn();
    provider.onSaveWarning = onSaveWarning;

    emitCacheUpdate(TEST_PATH, cacheBytes);
    await flushMicrotasks();
    ydoc.getText("local").insert(0, "patch");
    seedFirestoreContent(TEST_PATH, serverBytes);
    await emitServerMissing(TEST_PATH);

    await provider.saveToFirestore();

    expect(onSaveWarning).toHaveBeenCalled();
    const ctx = onSaveWarning.mock.calls[0]?.[0] as { reason?: string };
    expect(ctx.reason).toBe("shrink");
    expect(setDocCalls.length).toBeGreaterThan(0);
    const saved = decodeSavedDoc(setDocCalls[setDocCalls.length - 1]?.data);
    expect(saved.getText("new").toString()).toBe("new");
    expect(saved.getText("local").toString()).toBe("patch");
  });
});
