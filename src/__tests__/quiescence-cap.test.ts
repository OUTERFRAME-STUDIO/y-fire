import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import {
  addDocCalls,
  setAddDocImpl,
  setDocCalls,
} from "./_mocks/firestore";
import {
  createTestProvider,
  emitRemoteUpdate,
  emitServerUpdate,
  flushMicrotasks,
  markServerReady,
  TEST_PATH,
} from "./helpers";

function writeCount() {
  return setDocCalls.length + addDocCalls.length;
}

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

async function createAppendReadyProvider() {
  const remoteDoc = new Y.Doc();
  remoteDoc.getText("remote").insert(0, "peer");
  const remote = Y.encodeStateAsUpdate(remoteDoc);
  const created = await createTestProvider({
    maxWaitFirestoreTime: 50,
    maxFirestoreDeferral: 200,
    maxWaitTime: 60_000,
  });
  emitServerUpdate(TEST_PATH, remote);
  await flushMicrotasks();
  return created;
}

describe("quiescence cap", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forces save when deferral exceeds maxFirestoreDeferral", async () => {
    const remoteDoc = new Y.Doc();
    remoteDoc.getText("remote").insert(0, "peer");
    const remote = Y.encodeStateAsUpdate(remoteDoc);

    const { provider, ydoc } = await createTestProvider({
      maxWaitFirestoreTime: 50,
      maxFirestoreDeferral: 200,
      maxWaitTime: 60_000,
    });

    await markServerReady(TEST_PATH);
    ydoc.getText("local").insert(0, "mine");
    provider.sendToFirestoreQueue();

    for (let t = 0; t <= 180; t += 30) {
      await vi.advanceTimersByTimeAsync(30);
      emitRemoteUpdate(TEST_PATH, remote);
    }

    expect(writeCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(30);
    emitRemoteUpdate(TEST_PATH, remote);
    await vi.advanceTimersByTimeAsync(50);

    expect(writeCount()).toBe(1);
  });

  it("local re-entry past maxFirestoreDeferral flushes once, not per keystroke", async () => {
    const { provider, ydoc } = await createTestProvider({
      maxWaitFirestoreTime: 50,
      maxFirestoreDeferral: 200,
      maxWaitTime: 60_000,
    });

    await markServerReady(TEST_PATH);
    const text = ydoc.getText("local");
    text.insert(0, "a");
    provider.sendToFirestoreQueue();

    for (let t = 30; t <= 180; t += 30) {
      await vi.advanceTimersByTimeAsync(30);
      text.insert(text.length, "x");
      provider.sendToFirestoreQueue();
      expect(writeCount()).toBe(0);
    }

    await vi.advanceTimersByTimeAsync(30);
    text.insert(text.length, "x");
    provider.sendToFirestoreQueue();
    await flushMicrotasks();

    expect(writeCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();
    expect(writeCount()).toBe(1);
  });

  it("serializes overlapping saveToFirestore and coalesces a second flush", async () => {
    const { provider, ydoc } = await createAppendReadyProvider();

    let release!: () => void;
    setAddDocImpl(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const text = ydoc.getText("local");
    text.insert(0, "a");

    const firstSave = provider.saveToFirestore();
    await waitUntil(() => addDocCalls.length === 1, "first appendUpdate");
    expect(provider.saveInFlight).toBe(true);
    expect(addDocCalls.length).toBe(1);

    text.insert(text.length, "b");
    provider.sendToFirestoreQueue();
    await flushMicrotasks();
    expect(addDocCalls.length).toBe(1);

    release();
    await firstSave;
    await flushMicrotasks();
    expect(provider.saveInFlight).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();
    expect(addDocCalls.length).toBe(2);
  });

  it("records saveInFlight during await and lastSaveDurationMs after success", async () => {
    const { provider, ydoc } = await createAppendReadyProvider();

    let release!: () => void;
    setAddDocImpl(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    ydoc.getText("local").insert(0, "a");

    const save = provider.saveToFirestore();
    await waitUntil(() => addDocCalls.length === 1, "first appendUpdate");
    expect(provider.saveInFlight).toBe(true);
    expect(typeof provider.saveStartedAt).toBe("number");
    expect(provider.lastSaveDurationMs).toBeNull();

    await vi.advanceTimersByTimeAsync(40);
    release();
    await save;
    await flushMicrotasks();

    expect(provider.saveInFlight).toBe(false);
    expect(provider.saveStartedAt).toBeUndefined();
    expect(provider.lastSaveDurationMs).not.toBeNull();
    expect(Number.isFinite(provider.lastSaveDurationMs)).toBe(true);
    expect(provider.lastSaveDurationMs).toBeGreaterThanOrEqual(40);
  });
});
