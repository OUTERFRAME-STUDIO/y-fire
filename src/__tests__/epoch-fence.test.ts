import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import {
  addDoc,
  addDocCalls,
  emitSnapshot,
  emitUpdatesSnapshot,
  firestoreCollections,
  firestoreDocs,
  getDocFromServer,
  runTransaction,
  seedFirestoreUpdate,
  setAddDocError,
  setDocCalls,
  setGetDocFromServerError,
  updatesPath,
} from "./_mocks/firestore";
import {
  createTestProvider,
  emitServerMissing,
  emitServerUpdate,
  flushMicrotasks,
  TEST_PATH,
  whenTabFoldsIdle,
  FireProvider,
} from "./helpers";
import {
  EpochMismatchError,
  listUpdates,
  updateEpochMatches,
} from "../append-store";

function baseAndLegacy(): { snapshot: Uint8Array; legacy: Uint8Array } {
  const base = new Y.Doc();
  base.getText("t").insert(0, "base");
  const snapshot = Y.encodeStateAsUpdate(base);
  const sv = Y.encodeStateVector(base);
  base.getText("t").insert(4, "!");
  const legacy = Y.encodeStateAsUpdate(base, sv);
  base.destroy();
  return { snapshot, legacy };
}

describe("epoch fence", () => {
  let provider: FireProvider | undefined;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    setAddDocError(null);
    setGetDocFromServerError(null);
    provider = undefined;
  });

  afterEach(async () => {
    await whenTabFoldsIdle();
    if (provider) {
      await provider.kill();
      provider = undefined;
    }
    vi.mocked(console.log).mockRestore();
    vi.useRealTimers();
  });

  it("treats a missing update epoch as legacy and a number as exact", () => {
    expect(updateEpochMatches(undefined, 2)).toBe(true);
    expect(updateEpochMatches("1", 1)).toBe(true);
    expect(updateEpochMatches(2, 2)).toBe(true);
    expect(updateEpochMatches(1, 2)).toBe(false);
  });

  it("does not append before hydrate while hydratedEpoch is undefined", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    provider.serverReady = true;
    created.ydoc.getText("t").insert(0, "early");

    await provider.saveToFirestore();

    expect(addDocCalls.length).toBe(0);
    expect(setDocCalls.length).toBe(0);
  });

  it("stamps appendUpdate with the hydrated contentGeneration", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "base");
    const created = await createTestProvider();
    provider = created.provider;
    emitServerUpdate(TEST_PATH, Y.encodeStateAsUpdate(remote), { epoch: 7 });
    await flushMicrotasks();

    created.ydoc.getText("t").insert(4, "X");
    await provider.saveToFirestore();

    expect(addDocCalls.length).toBe(1);
    expect(addDocCalls[0]?.data).toMatchObject({ epoch: 7, seq: 1 });
    remote.destroy();
  });

  it("ignores a foreign-epoch update in the listener and in listUpdates", async () => {
    const { snapshot, legacy } = baseAndLegacy();
    const foreignDoc = new Y.Doc();
    foreignDoc.getText("t").insert(0, "FOREIGN");
    const foreign = Y.encodeStateAsUpdate(foreignDoc);

    const created = await createTestProvider({ foldUpdateThreshold: 1 });
    provider = created.provider;
    seedFirestoreUpdate(TEST_PATH, "foreign", foreign, { seq: 1 });
    firestoreCollections.get(updatesPath(TEST_PATH))!.get("foreign")!.epoch = 9;
    seedFirestoreUpdate(TEST_PATH, "legacy", legacy, { seq: 2 });
    emitServerUpdate(TEST_PATH, snapshot, { epoch: 1 });
    await flushMicrotasks();

    expect(created.ydoc.getText("t").toString()).toBe("base!");
    expect(created.ydoc.getText("t").toString()).not.toContain("FOREIGN");

    const listed = await listUpdates(provider.db, TEST_PATH);
    expect(listed.map((u) => u.id)).toEqual(["legacy"]);

    created.ydoc.getText("t").insert(5, "Z");
    await provider.saveToFirestore();
    await whenTabFoldsIdle();

    const remaining = firestoreCollections.get(updatesPath(TEST_PATH));
    expect(remaining?.has("foreign")).toBe(true);
    expect(remaining?.has("legacy")).toBe(false);
    foreignDoc.destroy();
  });

  it("applies a legacy update doc that has no epoch field", async () => {
    const { snapshot, legacy } = baseAndLegacy();
    const created = await createTestProvider();
    provider = created.provider;
    seedFirestoreUpdate(TEST_PATH, "legacy", legacy, { seq: 1 });
    const stored = firestoreCollections.get(updatesPath(TEST_PATH))!.get("legacy")!;
    expect(stored).not.toHaveProperty("epoch");

    emitServerUpdate(TEST_PATH, snapshot, { epoch: 3 });
    await flushMicrotasks();

    expect(created.ydoc.getText("t").toString()).toBe("base!");
    const listed = await listUpdates(provider.db, TEST_PATH);
    expect(listed.map((u) => u.id)).toEqual(["legacy"]);
  });

  it("fires onEpochReplace and skips addDoc when the doc listener sees a higher epoch", async () => {
    const original = new Y.Doc();
    original.getText("t").insert(0, "AAAA");
    const replacement = new Y.Doc();
    replacement.getText("t").insert(0, "BBBB");

    const created = await createTestProvider();
    provider = created.provider;
    const onEpochReplace = vi.fn();
    provider.onEpochReplace = onEpochReplace;

    emitServerUpdate(TEST_PATH, Y.encodeStateAsUpdate(original), { epoch: 1 });
    await flushMicrotasks();
    created.ydoc.getText("t").insert(4, "x");

    emitServerUpdate(TEST_PATH, Y.encodeStateAsUpdate(replacement), { epoch: 4 });
    await flushMicrotasks();
    await provider.saveToFirestore();

    expect(onEpochReplace).toHaveBeenCalledTimes(1);
    expect(onEpochReplace).toHaveBeenCalledWith({ from: 1, to: 4 });
    expect(addDocCalls.length).toBe(0);
    expect(created.ydoc.getText("t").toString()).not.toContain("BBBB");
    original.destroy();
    replacement.destroy();
  });

  it("enters epoch replace on EpochMismatchError during snapshot and does not retry", async () => {
    vi.useFakeTimers();
    const created = await createTestProvider();
    provider = created.provider;
    const onEpochReplace = vi.fn();
    const onSaveError = vi.fn();
    provider.onEpochReplace = onEpochReplace;
    provider.onSaveError = onSaveError;
    await emitServerMissing(TEST_PATH);

    firestoreDocs.set(TEST_PATH, { contentGeneration: 4 });
    created.ydoc.getText("t").insert(0, "late");
    await provider.saveToFirestore();
    const transactions = runTransaction.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60_000);

    expect(onEpochReplace).toHaveBeenCalledTimes(1);
    expect(onEpochReplace).toHaveBeenCalledWith({ from: 0, to: 4 });
    expect(runTransaction.mock.calls.length).toBe(transactions);
    expect(setDocCalls.length).toBe(0);
    expect(addDocCalls.length).toBe(0);
    expect(onSaveError).not.toHaveBeenCalled();
    expect(getDocFromServer).not.toHaveBeenCalled();
  });

  it("enters epoch replace on EpochMismatchError during fold and does not retry", async () => {
    vi.useFakeTimers();
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "base");
    const created = await createTestProvider({ foldUpdateThreshold: 1 });
    provider = created.provider;
    const onEpochReplace = vi.fn();
    provider.onEpochReplace = onEpochReplace;
    emitServerUpdate(TEST_PATH, Y.encodeStateAsUpdate(remote), { epoch: 1 });
    await flushMicrotasks();

    const shard = firestoreDocs.get(TEST_PATH)!;
    shard.contentGeneration = 5;
    created.ydoc.getText("t").insert(4, "Q");
    await provider.saveToFirestore();
    await whenTabFoldsIdle();
    const transactions = runTransaction.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60_000);
    await whenTabFoldsIdle();

    expect(onEpochReplace).toHaveBeenCalledTimes(1);
    expect(onEpochReplace).toHaveBeenCalledWith({ from: 1, to: 5 });
    expect(runTransaction.mock.calls.length).toBe(transactions);
    expect(addDocCalls.length).toBe(1);
    expect(getDocFromServer).not.toHaveBeenCalled();
    remote.destroy();
  });

  function permissionDenied() {
    return Object.assign(new Error("Missing or insufficient permissions."), {
      code: "permission-denied",
    });
  }

  it("retries a permission-denied append when the server epoch is unchanged", async () => {
    vi.useFakeTimers();
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "base");
    const created = await createTestProvider({ maxWaitFirestoreTime: 20 });
    provider = created.provider;
    const onEpochReplace = vi.fn();
    const onSaveError = vi.fn();
    provider.onEpochReplace = onEpochReplace;
    provider.onSaveError = onSaveError;
    emitServerUpdate(TEST_PATH, Y.encodeStateAsUpdate(remote), { epoch: 2 });
    await flushMicrotasks();

    setAddDocError(permissionDenied());
    const svBefore = (
      provider as unknown as { lastPersistedSV?: Uint8Array }
    ).lastPersistedSV;
    created.ydoc.getText("t").insert(4, "Z");
    await provider.saveToFirestore();

    expect(onEpochReplace).not.toHaveBeenCalled();
    expect(onSaveError).toHaveBeenCalled();
    expect(onSaveError.mock.calls[0]?.[1]).toMatchObject({
      reason: "save-failed",
    });
    expect(onSaveError.mock.calls[0]?.[0]).toMatchObject({
      code: "permission-denied",
    });
    expect(
      (provider as unknown as { epochReplaced: boolean }).epochReplaced,
    ).toBe(false);
    expect(created.ydoc.getText("t").toString()).toBe("baseZ");
    expect(
      (provider as unknown as { lastPersistedSV?: Uint8Array }).lastPersistedSV,
    ).toEqual(svBefore);
    expect(addDoc.mock.calls.length).toBe(1);
    expect(getDocFromServer).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(20);
    await flushMicrotasks();

    expect(addDoc.mock.calls.length).toBeGreaterThan(1);
    expect(onEpochReplace).not.toHaveBeenCalled();
    expect(created.ydoc.getText("t").toString()).toBe("baseZ");
    remote.destroy();
  });

  it("replaces on permission-denied only after the server epoch advances", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "base");
    const created = await createTestProvider();
    provider = created.provider;
    const onEpochReplace = vi.fn();
    const onSaveError = vi.fn();
    provider.onEpochReplace = onEpochReplace;
    provider.onSaveError = onSaveError;
    emitServerUpdate(TEST_PATH, Y.encodeStateAsUpdate(remote), { epoch: 2 });
    await flushMicrotasks();

    firestoreDocs.get(TEST_PATH)!.contentGeneration = 9;
    setAddDocError(permissionDenied());
    created.ydoc.getText("t").insert(4, "Z");
    await provider.saveToFirestore();

    expect(onEpochReplace).toHaveBeenCalledTimes(1);
    expect(onEpochReplace).toHaveBeenCalledWith({ from: 2, to: 9 });
    expect(onSaveError).not.toHaveBeenCalled();
    expect(getDocFromServer).toHaveBeenCalledTimes(1);
    expect(addDocCalls.length).toBe(0);
    remote.destroy();
  });

  it("treats a failed server epoch read after permission-denied as a save failure", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "base");
    const created = await createTestProvider();
    provider = created.provider;
    const onEpochReplace = vi.fn();
    const onSaveError = vi.fn();
    provider.onEpochReplace = onEpochReplace;
    provider.onSaveError = onSaveError;
    emitServerUpdate(TEST_PATH, Y.encodeStateAsUpdate(remote), { epoch: 2 });
    await flushMicrotasks();

    firestoreDocs.get(TEST_PATH)!.contentGeneration = 9;
    setGetDocFromServerError(new Error("server read failed"));
    setAddDocError(permissionDenied());
    created.ydoc.getText("t").insert(4, "Z");
    await provider.saveToFirestore();

    expect(onEpochReplace).not.toHaveBeenCalled();
    expect(onSaveError).toHaveBeenCalled();
    expect(onSaveError.mock.calls[0]?.[1]).toMatchObject({
      reason: "save-failed",
    });
    expect(onSaveError.mock.calls[0]?.[0]).toMatchObject({
      code: "permission-denied",
    });
    expect(
      (provider as unknown as { epochReplaced: boolean }).epochReplaced,
    ).toBe(false);
    expect(created.ydoc.getText("t").toString()).toBe("baseZ");
    remote.destroy();
  });

  it("replaces immediately on EpochMismatchError from appendUpdate without a server read", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "base");
    const created = await createTestProvider();
    provider = created.provider;
    const onEpochReplace = vi.fn();
    const onSaveError = vi.fn();
    provider.onEpochReplace = onEpochReplace;
    provider.onSaveError = onSaveError;
    emitServerUpdate(TEST_PATH, Y.encodeStateAsUpdate(remote), { epoch: 2 });
    await flushMicrotasks();

    setAddDocError(new EpochMismatchError(2, 6));
    created.ydoc.getText("t").insert(4, "Z");
    await provider.saveToFirestore();

    expect(onEpochReplace).toHaveBeenCalledTimes(1);
    expect(onEpochReplace).toHaveBeenCalledWith({ from: 2, to: 6 });
    expect(onSaveError).not.toHaveBeenCalled();
    expect(getDocFromServer).not.toHaveBeenCalled();
    remote.destroy();
  });

  it("drops a peer update with a mismatched numeric epoch and applies one without epoch", async () => {
    const { applyPeerYjsUpdate } = await vi.importActual<
      typeof import("../webrtc")
    >("../webrtc");
    const local = new Y.Doc();
    local.getText("t").insert(0, "local");
    const peer = new Y.Doc();
    peer.getText("t").insert(0, "PEER");
    const update = Y.encodeStateAsUpdate(peer);

    expect(applyPeerYjsUpdate(local, update, "peer", 9, 1)).toBe(false);
    expect(local.getText("t").toString()).toBe("local");

    expect(applyPeerYjsUpdate(local, update, "peer", undefined, 1)).toBe(true);
    expect(local.getText("t").toString()).toContain("PEER");

    local.destroy();
    peer.destroy();
  });

  it("sends hydratedEpoch on Yjs peer payloads and omits it for awareness", async () => {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "base");
    const created = await createTestProvider();
    provider = created.provider;
    const sendData = vi.fn();
    provider.peersRTC.receivers.peer = {
      sendData,
      destroy: vi.fn(),
    } as never;
    const bytes = new Uint8Array([1, 2, 3]);

    provider.sendDataToPeers({ from: "other", message: null, data: bytes });
    expect(sendData).toHaveBeenCalledWith({ message: null, data: bytes });

    emitServerUpdate(TEST_PATH, Y.encodeStateAsUpdate(remote), { epoch: 4 });
    await flushMicrotasks();
    sendData.mockClear();

    provider.sendDataToPeers({ from: "other", message: null, data: bytes });
    expect(sendData).toHaveBeenCalledWith({
      message: null,
      data: bytes,
      epoch: 4,
    });

    sendData.mockClear();
    provider.sendDataToPeers({
      from: "other",
      message: "awareness",
      data: bytes,
    });
    expect(sendData).toHaveBeenCalledWith({
      message: "awareness",
      data: bytes,
    });
    remote.destroy();
  });

  it("sets epoch 0 on a server-confirmed missing doc and still writes the first snapshot", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const onEpochReplace = vi.fn();
    provider.onEpochReplace = onEpochReplace;

    emitSnapshot(TEST_PATH, {
      exists: () => false,
      data: () => undefined,
      metadata: { fromCache: true, hasPendingWrites: false },
    });
    emitUpdatesSnapshot(TEST_PATH, { fromCache: true, hasPendingWrites: false });
    await flushMicrotasks();

    const real = new Y.Doc();
    real.getText("t").insert(0, "server");
    emitServerUpdate(TEST_PATH, Y.encodeStateAsUpdate(real), { epoch: 3 });
    await flushMicrotasks();

    expect(onEpochReplace).not.toHaveBeenCalled();
    expect(created.ydoc.getText("t").toString()).toBe("server");
    real.destroy();
    await provider.kill();
    provider = undefined;

    const fresh = await createTestProvider();
    provider = fresh.provider;
    await emitServerMissing(TEST_PATH);
    fresh.ydoc.getText("t").insert(0, "first");
    await provider.saveToFirestore();

    expect(setDocCalls.length).toBe(1);
    expect(addDocCalls.length).toBe(0);
    const saved = setDocCalls[0]?.data as { content?: { toUint8Array: () => Uint8Array } };
    const roundTrip = new Y.Doc();
    Y.applyUpdate(roundTrip, saved.content!.toUint8Array());
    expect(roundTrip.getText("t").toString()).toBe("first");
    roundTrip.destroy();
  });
});
