import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import {
  addDocCalls,
  setAddDocImpl,
  setRunTransactionBefore,
} from "./_mocks/firestore";
import {
  createTestProvider,
  emitServerUpdate,
  flushMicrotasks,
  markServerReady,
  TEST_PATH,
  type FireProvider,
} from "./helpers";

const SAVE_TIMEOUT_MS = 50;

function persistedSV(provider: FireProvider): Uint8Array | undefined {
  return (provider as unknown as { lastPersistedSV?: Uint8Array }).lastPersistedSV;
}

function lastSeq(provider: FireProvider): number {
  return (provider as unknown as { lastSeq: number }).lastSeq;
}

function svEqual(a?: Uint8Array, b?: Uint8Array): boolean {
  if (a === b) return true;
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  return a.every((value, i) => value === b[i]);
}

function saveReasons(onSaveError: ReturnType<typeof vi.fn>): Array<string | undefined> {
  return onSaveError.mock.calls.map(
    (c) => (c[1] as { reason?: string } | undefined)?.reason,
  );
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function createAppendReadyProvider(overrides: { saveTimeoutMs?: number } = {}) {
  const remoteDoc = new Y.Doc();
  remoteDoc.getText("remote").insert(0, "peer");
  const remote = Y.encodeStateAsUpdate(remoteDoc);
  const created = await createTestProvider({
    maxWaitFirestoreTime: 50,
    maxWaitTime: 60_000,
    saveTimeoutMs: overrides.saveTimeoutMs ?? SAVE_TIMEOUT_MS,
  });
  emitServerUpdate(TEST_PATH, remote);
  await flushMicrotasks();
  return created;
}

describe("saveTimeoutMs", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    setAddDocImpl(async () => {});
    setRunTransactionBefore(async () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(console.log).mockRestore();
  });

  it("times out a hung addDoc, reports save-timeout, and clears saveInFlight", async () => {
    const { provider, ydoc } = await createAppendReadyProvider();
    const onSaving = vi.fn();
    const onSaveError = vi.fn();
    provider.onSaving = onSaving;
    provider.onSaveError = onSaveError;

    setAddDocImpl(() => new Promise<void>(() => {}));

    ydoc.getText("local").insert(0, "a");
    const save = provider.saveToFirestore();
    await waitUntil(() => addDocCalls.length === 1, "hung appendUpdate");
    expect(provider.saveInFlight).toBe(true);

    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS);
    await save;
    await flushMicrotasks();

    expect(saveReasons(onSaveError)).toContain("save-timeout");
    expect(provider.saveInFlight).toBe(false);
    expect(onSaving).not.toHaveBeenCalledWith(false);
  });

  it("does not advance lastPersistedSV when addDoc resolves after timeout", async () => {
    const { provider, ydoc } = await createAppendReadyProvider();
    const onSaveError = vi.fn();
    provider.onSaveError = onSaveError;

    let release!: () => void;
    setAddDocImpl(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const seqBefore = lastSeq(provider);
    const svBefore = persistedSV(provider);
    ydoc.getText("local").insert(0, "a");
    const save = provider.saveToFirestore();
    await waitUntil(() => addDocCalls.length === 1, "held appendUpdate");

    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS);
    await save;
    await flushMicrotasks();

    expect(saveReasons(onSaveError)).toContain("save-timeout");
    expect(lastSeq(provider)).toBe(seqBefore);
    expect(svEqual(persistedSV(provider), svBefore)).toBe(true);

    release();
    await flushMicrotasks();
    // Dangling addDoc success must not take appendDelta's lastSeq /
    // lastPersistedSV assignment. A later retry still encodes a write
    // (Yjs CRDT: duplicate updates/* rows are merge-safe).
    setAddDocImpl(async () => {});
    ydoc.getText("local").insert(1, "b");
    await provider.saveToFirestore();
    await flushMicrotasks();

    expect(addDocCalls.length).toBe(2);
  });

  it("still reports onSaving(false) when addDoc finishes under the timeout", async () => {
    const { provider, ydoc } = await createAppendReadyProvider();
    const onSaving = vi.fn();
    const onSaveError = vi.fn();
    provider.onSaving = onSaving;
    provider.onSaveError = onSaveError;

    ydoc.getText("local").insert(0, "fast");
    onSaving.mockClear();
    await provider.saveToFirestore();
    await flushMicrotasks();

    expect(onSaveError).not.toHaveBeenCalled();
    expect(onSaving).toHaveBeenCalledWith(false);
    expect(provider.saveInFlight).toBe(false);
    expect(addDocCalls.length).toBe(1);
  });

  it("times out a hung first snapshot write", async () => {
    const { provider, ydoc } = await createTestProvider({
      maxWaitFirestoreTime: 50,
      maxWaitTime: 60_000,
      saveTimeoutMs: SAVE_TIMEOUT_MS,
    });
    await markServerReady(TEST_PATH);

    const onSaveError = vi.fn();
    provider.onSaveError = onSaveError;
    setRunTransactionBefore(() => new Promise<void>(() => {}));

    ydoc.getText("local").insert(0, "first");
    const save = provider.saveToFirestore();
    await flushMicrotasks();
    expect(provider.saveInFlight).toBe(true);

    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS);
    await save;
    await flushMicrotasks();

    expect(saveReasons(onSaveError)).toContain("save-timeout");
    expect(provider.saveInFlight).toBe(false);
  });
});
