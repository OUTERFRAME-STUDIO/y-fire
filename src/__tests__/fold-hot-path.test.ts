import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import {
  firestoreCollections,
  firestoreDocs,
  getDocs,
  runTransaction,
  seedFirestoreUpdate,
  setRunTransactionBefore,
  updatesPath,
} from "./_mocks/firestore";
import {
  createTestProvider,
  decodeSavedDoc,
  emitServerUpdate,
  flushMicrotasks,
  TEST_PATH,
  whenTabFoldsIdle,
  FireProvider,
} from "./helpers";

async function waitUntil(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("DEV-68 fold hot path", () => {
  let provider: FireProvider | undefined;
  let extraProviders: FireProvider[] = [];

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    provider = undefined;
    extraProviders = [];
  });

  afterEach(async () => {
    await whenTabFoldsIdle();
    if (provider) {
      await provider.kill();
      provider = undefined;
    }
    for (const extra of extraProviders) {
      await extra.kill();
    }
    extraProviders = [];
    vi.mocked(console.log).mockRestore();
  });

  it("fold does not getDocs when the updates listener has populated the cache", async () => {
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
    getDocs.mockClear();
    await provider.saveToFirestore();
    await whenTabFoldsIdle();

    expect(getDocs).not.toHaveBeenCalled();
    expect(firestoreCollections.get(updatesPath(TEST_PATH))?.size ?? 0).toBe(0);
    expect(decodeSavedDoc(firestoreDocs.get(TEST_PATH)).getText("t").toString()).toBe(
      "baseAB",
    );
  });

  it("calls onSaving(false) and clears saveInFlight before fold completes", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "base");
    const bytes = Y.encodeStateAsUpdate(remote);

    const created = await createTestProvider({ foldUpdateThreshold: 1 });
    provider = created.provider;
    const onSaving = vi.fn();
    provider.onSaving = onSaving;
    emitServerUpdate(TEST_PATH, bytes);
    await flushMicrotasks();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setRunTransactionBefore(() => gate);

    created.ydoc.getText("t").insert(4, "A");
    onSaving.mockClear();
    const save = provider.saveToFirestore();
    await save;
    await waitUntil(
      () => runTransaction.mock.calls.length === 1,
      "fold transaction start",
    );

    expect(onSaving).toHaveBeenCalledWith(false);
    expect(provider.saveInFlight).toBe(false);
    expect(firestoreCollections.get(updatesPath(TEST_PATH))?.size).toBe(1);

    release();
    await whenTabFoldsIdle();
    expect(firestoreCollections.get(updatesPath(TEST_PATH))?.size ?? 0).toBe(0);
  });

  it("serializes folds across providers without holding saveInFlight", async () => {
    const pathA = "projects/test/doc-a";
    const pathB = "projects/test/doc-b";
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "base");
    const bytes = Y.encodeStateAsUpdate(remote);

    const createdA = await createTestProvider({
      path: pathA,
      foldUpdateThreshold: 1,
    });
    provider = createdA.provider;
    const createdB = await createTestProvider(
      { path: pathB, foldUpdateThreshold: 1 },
      { reset: false },
    );
    extraProviders.push(createdB.provider);

    const onSavingA = vi.fn();
    const onSavingB = vi.fn();
    createdA.provider.onSaving = onSavingA;
    createdB.provider.onSaving = onSavingB;

    emitServerUpdate(pathA, bytes);
    emitServerUpdate(pathB, bytes);
    await flushMicrotasks();

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let transactionStarts = 0;
    setRunTransactionBefore(async () => {
      transactionStarts += 1;
      if (transactionStarts === 1) await firstGate;
    });

    createdA.ydoc.getText("t").insert(4, "A");
    onSavingA.mockClear();
    await createdA.provider.saveToFirestore();
    await waitUntil(
      () => transactionStarts === 1,
      "first fold transaction start",
    );

    createdB.ydoc.getText("t").insert(4, "B");
    onSavingB.mockClear();
    await createdB.provider.saveToFirestore();
    await flushMicrotasks();

    expect(onSavingA).toHaveBeenCalledWith(false);
    expect(onSavingB).toHaveBeenCalledWith(false);
    expect(createdA.provider.saveInFlight).toBe(false);
    expect(createdB.provider.saveInFlight).toBe(false);
    expect(transactionStarts).toBe(1);

    releaseFirst();
    await whenTabFoldsIdle();
    expect(transactionStarts).toBe(2);
    expect(firestoreCollections.get(updatesPath(pathA))?.size ?? 0).toBe(0);
    expect(firestoreCollections.get(updatesPath(pathB))?.size ?? 0).toBe(0);
  });

  it("fold survives a concurrent append by deleting only cached listener ids", async () => {
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

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setRunTransactionBefore(() => gate);

    await provider.saveToFirestore();
    await waitUntil(
      () => runTransaction.mock.calls.length === 1,
      "fold transaction start",
    );

    const late = new Y.Doc();
    late.getText("late").insert(0, "concurrent");
    seedFirestoreUpdate(TEST_PATH, "concurrent", Y.encodeStateAsUpdate(late), {
      seq: 99,
    });

    release();
    await whenTabFoldsIdle();

    const remaining = firestoreCollections.get(updatesPath(TEST_PATH));
    expect(remaining?.has("concurrent")).toBe(true);
    const saved = decodeSavedDoc(firestoreDocs.get(TEST_PATH));
    expect(saved.getText("t").toString()).toContain("base");
    expect(getDocs).not.toHaveBeenCalled();
  });
});
