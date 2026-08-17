import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import {
  addDoc,
  addDocCalls,
  assertNoUndefinedFields,
  collection,
  emitSnapshotError,
  firestoreCollections,
  firestoreDocs,
  getDocs,
  setDocCalls,
  seedFirestoreUpdate,
  updatesPath,
} from "./_mocks/firestore";
import {
  createTestProvider,
  decodeSavedDoc,
  emitDocSnapshotOnly,
  emitServerUpdate,
  flushMicrotasks,
  TEST_PATH,
  FireProvider,
} from "./helpers";
import { FIRESTORE_CONTENT_MAX_BYTES } from "../firestore-limits";

function saveReasons(handler: ReturnType<typeof vi.fn>): string[] {
  return handler.mock.calls.map((c) => (c[1] as { reason?: string })?.reason ?? "");
}

function warningReasons(handler: ReturnType<typeof vi.fn>): string[] {
  return handler.mock.calls.map((c) => (c[0] as { reason?: string })?.reason ?? "");
}

/** Insert+delete padding that stays in a `gc: false` doc so the incremental delta is huge. */
function bloatThenShrink(ydoc: Y.Doc, padChars: number) {
  const t = ydoc.getText("t");
  const pad = "x".repeat(padChars);
  const at = t.length;
  t.insert(at, pad);
  t.delete(at, pad.length);
  t.insert(at, "!");
}

describe("DEV-67 QA regressions", () => {
  let provider: FireProvider | undefined;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    provider = undefined;
  });

  afterEach(async () => {
    if (provider) {
      await provider.kill();
      provider = undefined;
    }
    vi.mocked(console.log).mockRestore();
  });

  it("A8: Firestore mock throws on undefined field values", async () => {
    const { resetFirestoreMock } = await import("./_mocks/firestore");
    resetFirestoreMock();
    expect(() => assertNoUndefinedFields({ clientId: undefined })).toThrow(
      /undefined \(found in field clientId\)/,
    );
    await expect(
      addDoc(collection({}, "projects/test/doc/updates"), {
        seq: 1,
        clientId: undefined,
      }),
    ).rejects.toThrow(/undefined \(found in field clientId\)/);
  });

  it("1: append with uid undefined writes no clientId key and does not throw", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "seed");
    const bytes = Y.encodeStateAsUpdate(remote);

    const created = await createTestProvider();
    provider = created.provider;
    emitServerUpdate(TEST_PATH, bytes);
    await flushMicrotasks();

    Object.assign(provider, { uid: undefined });
    created.ydoc.getText("t").insert(4, "!");
    await expect(provider.saveToFirestore()).resolves.toBeUndefined();

    expect(addDocCalls.length).toBe(1);
    expect(addDocCalls[0]?.data).not.toHaveProperty("clientId");
  });

  it("2: oversized delta writes a union snapshot instead of aborting", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "seed");
    const bytes = Y.encodeStateAsUpdate(remote);
    const peer = new Y.Doc();
    peer.getText("peer").insert(0, "P");
    const peerUpdate = Y.encodeStateAsUpdate(peer);

    const ydoc = new Y.Doc({ gc: false });
    const created = await createTestProvider({ ydoc, maxContentBytes: 1_000 });
    provider = created.provider;
    const onSaveError = vi.fn();
    provider.onSaveError = onSaveError;
    seedFirestoreUpdate(TEST_PATH, "peer1", peerUpdate, { seq: 1 });
    emitServerUpdate(TEST_PATH, bytes);
    await flushMicrotasks();

    bloatThenShrink(created.ydoc, 5_000);
    await provider.saveToFirestore();

    expect(addDocCalls.length).toBe(0);
    expect(saveReasons(onSaveError)).not.toContain("size-abort");
    const saved = decodeSavedDoc(firestoreDocs.get(TEST_PATH));
    expect(saved.getText("t").toString()).toBe(created.ydoc.getText("t").toString());
    expect(saved.getText("peer").toString()).toBe("P");

    const fresh = new Y.Doc();
    const content = (
      firestoreDocs.get(TEST_PATH)?.content as { toUint8Array: () => Uint8Array }
    ).toUint8Array();
    Y.applyUpdate(fresh, content);
    expect(fresh.getText("t").toString()).toBe(saved.getText("t").toString());
    expect(fresh.getText("peer").toString()).toBe("P");
  });

  it("3: forced fold with an empty updates collection still writes", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "seed");
    const bytes = Y.encodeStateAsUpdate(remote);

    const ydoc = new Y.Doc({ gc: false });
    const created = await createTestProvider({ ydoc, maxContentBytes: 1_000 });
    provider = created.provider;
    emitServerUpdate(TEST_PATH, bytes);
    await flushMicrotasks();
    expect(firestoreCollections.get(updatesPath(TEST_PATH))?.size ?? 0).toBe(0);

    bloatThenShrink(created.ydoc, 5_000);
    await provider.saveToFirestore();

    expect(addDocCalls.length).toBe(0);
    const saved = decodeSavedDoc(firestoreDocs.get(TEST_PATH));
    expect(saved.getText("t").toString()).toBe("seed!");
    expect(firestoreCollections.get(updatesPath(TEST_PATH))?.size ?? 0).toBe(0);
  });

  it("4: union above the cap reports compact-required once, backs off, and still appends", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "base-content");
    const bytes = Y.encodeStateAsUpdate(remote);

    const created = await createTestProvider({ foldUpdateThreshold: 1 });
    provider = created.provider;
    const onSaveError = vi.fn();
    const onSaveWarning = vi.fn();
    provider.onSaveError = onSaveError;
    provider.onSaveWarning = onSaveWarning;
    emitServerUpdate(TEST_PATH, bytes);
    await flushMicrotasks();

    const sv = Y.encodeStateVector(created.ydoc);
    created.ydoc.getText("t").insert(12, "x");
    const delta = Y.encodeStateAsUpdate(created.ydoc, sv);
    const snapshotSize = Y.encodeStateAsUpdate(created.ydoc).byteLength;
    provider.maxContentBytes = snapshotSize - 1;
    expect(delta.byteLength).toBeLessThanOrEqual(provider.maxContentBytes);

    getDocs.mockClear();
    await provider.saveToFirestore();
    const listReads = getDocs.mock.calls.length;
    expect(listReads).toBeGreaterThan(0);
    expect(addDocCalls.length).toBe(1);
    expect(saveReasons(onSaveError)).toEqual(["compact-required"]);
    expect(firestoreCollections.get(updatesPath(TEST_PATH))?.size).toBe(1);

    created.ydoc.getText("t").insert(13, "y");
    await provider.saveToFirestore();

    expect(addDocCalls.length).toBe(2);
    expect(getDocs.mock.calls.length).toBe(listReads);
    expect(saveReasons(onSaveError)).toEqual(["compact-required"]);
    expect(firestoreCollections.get(updatesPath(TEST_PATH))?.size).toBe(2);
  });

  it("5: a normal append does not getDocs the updates collection", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "seed");
    const bytes = Y.encodeStateAsUpdate(remote);

    const created = await createTestProvider();
    provider = created.provider;
    emitServerUpdate(TEST_PATH, bytes);
    await flushMicrotasks();

    created.ydoc.getText("t").insert(4, "!");
    getDocs.mockClear();
    await provider.saveToFirestore();

    expect(addDocCalls.length).toBe(1);
    expect(getDocs).not.toHaveBeenCalled();
  });

  it("6: updates permission-denied degrades instead of onDeleted", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "seed");
    const bytes = Y.encodeStateAsUpdate(remote);

    const created = await createTestProvider();
    provider = created.provider;
    const onDeleted = vi.fn();
    const onServerReady = vi.fn();
    provider.onDeleted = onDeleted;
    provider.onServerReady = onServerReady;

    emitDocSnapshotOnly(TEST_PATH, bytes);
    emitSnapshotError(updatesPath(TEST_PATH), { code: "permission-denied" });
    await flushMicrotasks();

    expect(onDeleted).not.toHaveBeenCalled();
    expect(provider.serverReady).toBe(true);
    expect(onServerReady).toHaveBeenCalledTimes(1);

    created.ydoc.getText("t").insert(4, "!");
    await provider.saveToFirestore();

    expect(addDocCalls.length).toBe(0);
    expect(setDocCalls.length).toBeGreaterThan(0);
    const saved = decodeSavedDoc(firestoreDocs.get(TEST_PATH));
    expect(saved.getText("t").toString()).toBe("seed!");
  });

  it("7: a large delta under the cap does not size-warn", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "seed");
    const bytes = Y.encodeStateAsUpdate(remote);

    const created = await createTestProvider({
      foldBytesFraction: 0.99,
      foldUpdateThreshold: 100,
    });
    provider = created.provider;
    const onSaveWarning = vi.fn();
    provider.onSaveWarning = onSaveWarning;
    emitServerUpdate(TEST_PATH, bytes);
    await flushMicrotasks();

    created.ydoc.getText("t").insert(4, "x".repeat(740_000));
    const delta = Y.encodeStateAsUpdate(
      created.ydoc,
      Y.encodeStateVectorFromUpdate(bytes),
    );
    expect(delta.byteLength).toBeGreaterThan(
      Math.floor(FIRESTORE_CONTENT_MAX_BYTES * 0.7),
    );
    expect(delta.byteLength).toBeLessThanOrEqual(FIRESTORE_CONTENT_MAX_BYTES);

    await provider.saveToFirestore();

    expect(addDocCalls.length).toBe(1);
    expect(warningReasons(onSaveWarning)).not.toContain("size-warn");
  });

  it("8: local exceeding the server snapshot by >1 MiB saves and clears the header", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "seed");
    const bytes = Y.encodeStateAsUpdate(remote);

    const ydoc = new Y.Doc({ gc: false });
    const created = await createTestProvider({ ydoc });
    provider = created.provider;
    const onSaving = vi.fn();
    const onSaveError = vi.fn();
    provider.onSaving = onSaving;
    provider.onSaveError = onSaveError;
    emitServerUpdate(TEST_PATH, bytes);
    await flushMicrotasks();

    bloatThenShrink(created.ydoc, FIRESTORE_CONTENT_MAX_BYTES + 4_096);
    onSaving.mockClear();
    await provider.saveToFirestore();

    expect(saveReasons(onSaveError)).not.toContain("size-abort");
    expect(onSaving).toHaveBeenCalledWith(false);
    const saved = decodeSavedDoc(firestoreDocs.get(TEST_PATH));
    expect(saved.getText("t").toString()).toBe("seed!");
  });
});
