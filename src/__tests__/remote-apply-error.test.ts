import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import {
  emitSnapshot,
  emitUpdatesSnapshot,
  onSnapshotCallCount,
  seedFirestoreUpdate,
} from "./_mocks/firestore";
import {
  createTestProvider,
  emitServerUpdate,
  flushMicrotasks,
  TEST_PATH,
  whenTabFoldsIdle,
  FireProvider,
} from "./helpers";
import type { RemoteApplyErrorEvent } from "../provider";

/**
 * DEV-455: an observer that throws while Firestore bytes are applied (the
 * script editor's slate-yjs binding) is not a Firestore failure. Yjs has
 * already integrated the update, so the provider reports it once through
 * `onRemoteApplyError` and keeps applying the remaining update docs instead
 * of resubscribing in a loop.
 */

function baseAndUpdates(): {
  snapshot: Uint8Array;
  first: Uint8Array;
  second: Uint8Array;
} {
  const src = new Y.Doc();
  src.getText("t").insert(0, "base");
  const snapshot = Y.encodeStateAsUpdate(src);
  let sv = Y.encodeStateVector(src);
  src.getText("t").insert(4, "+one");
  const first = Y.encodeStateAsUpdate(src, sv);
  sv = Y.encodeStateVector(src);
  src.getText("t").insert(8, "+two");
  const second = Y.encodeStateAsUpdate(src, sv);
  src.destroy();
  return { snapshot, first, second };
}

async function flushAll() {
  for (let i = 0; i < 5; i++) await flushMicrotasks();
}

/** Throw from a Y observer while the text contains `marker`. */
function throwWhileTextHas(ydoc: Y.Doc, marker: string) {
  ydoc.getText("t").observe(() => {
    if (ydoc.getText("t").toString().includes(marker)) {
      throw new SyntaxError("Invalid or unexpected token");
    }
  });
}

describe("remote apply errors (DEV-455)", () => {
  let provider: FireProvider | undefined;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
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

  it("keeps applying later update docs after an observer throws on one", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const errors: RemoteApplyErrorEvent[] = [];
    provider.onRemoteApplyError = (event) => errors.push(event);

    const { snapshot, first, second } = baseAndUpdates();
    emitServerUpdate(TEST_PATH, snapshot, { emitUpdates: false });
    await flushAll();

    let thrown = false;
    created.ydoc.getText("t").observe(() => {
      if (!thrown && created.ydoc.getText("t").toString().includes("+one")) {
        thrown = true;
        throw new SyntaxError("Invalid or unexpected token");
      }
    });
    seedFirestoreUpdate(TEST_PATH, "u1", first, { seq: 1 });
    seedFirestoreUpdate(TEST_PATH, "u2", second, { seq: 2 });
    const subscriptionsBefore = onSnapshotCallCount;

    expect(() => emitUpdatesSnapshot(TEST_PATH)).not.toThrow();
    await flushAll();

    expect(created.ydoc.getText("t").toString()).toBe("base+one+two");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      documentPath: TEST_PATH,
      source: "update",
      updateId: "u1",
      integrated: true,
    });
    expect(errors[0].error).toBeInstanceOf(SyntaxError);
    expect(onSnapshotCallCount).toBe(subscriptionsBefore);
  });

  it("does not resubscribe when an observer throws on the snapshot", async () => {
    vi.useFakeTimers();
    const created = await createTestProvider();
    provider = created.provider;
    const errors: RemoteApplyErrorEvent[] = [];
    provider.onRemoteApplyError = (event) => errors.push(event);
    const onReady = vi.fn();
    provider.onReady = onReady;
    throwWhileTextHas(created.ydoc, "base");

    const { snapshot } = baseAndUpdates();
    const subscriptionsBefore = onSnapshotCallCount;
    emitServerUpdate(TEST_PATH, snapshot);
    await flushAll();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(created.ydoc.getText("t").toString()).toBe("base");
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(provider.serverReady).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ source: "snapshot", integrated: true });
    expect(onSnapshotCallCount).toBe(subscriptionsBefore);
  });

  it("reports a malformed update doc without blocking the next one", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const errors: RemoteApplyErrorEvent[] = [];
    provider.onRemoteApplyError = (event) => errors.push(event);

    const { snapshot, first } = baseAndUpdates();
    emitServerUpdate(TEST_PATH, snapshot, { emitUpdates: false });
    await flushAll();

    seedFirestoreUpdate(TEST_PATH, "bad", new Uint8Array([1, 200, 7, 255, 3]), {
      seq: 1,
    });
    seedFirestoreUpdate(TEST_PATH, "good", first, { seq: 2 });
    expect(() => emitUpdatesSnapshot(TEST_PATH)).not.toThrow();
    await flushAll();

    expect(created.ydoc.getText("t").toString()).toBe("base+one");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      source: "update",
      updateId: "bad",
      integrated: false,
    });

    // The same snapshot replayed does not report the poison doc again.
    emitUpdatesSnapshot(TEST_PATH);
    await flushAll();
    expect(errors).toHaveLength(1);
  });

  it("logs the error when no hook is set", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const { snapshot, first } = baseAndUpdates();
    emitServerUpdate(TEST_PATH, snapshot, { emitUpdates: false });
    await flushAll();
    throwWhileTextHas(created.ydoc, "+one");

    seedFirestoreUpdate(TEST_PATH, "u1", first, { seq: 1 });
    expect(() => emitUpdatesSnapshot(TEST_PATH)).not.toThrow();

    expect(created.ydoc.getText("t").toString()).toBe("base+one");
    expect(vi.mocked(console.log)).toHaveBeenCalledWith(
      "Provider:",
      TEST_PATH,
      expect.any(String),
      "Remote apply error",
      expect.any(SyntaxError),
    );
  });

  it("backs off when a doc snapshot keeps failing to hydrate", async () => {
    vi.useFakeTimers();
    const created = await createTestProvider();
    provider = created.provider;
    provider.onRemoteApplyError = () => {
      throw new Error("host hook failure is swallowed");
    };

    const garbage = new Uint8Array([1, 200, 7, 255, 3]);
    const delays: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      if (args.includes("Scheduling trackData retry")) {
        delays.push(String(args[args.length - 1]));
      }
    });
    const emitGarbage = () =>
      emitSnapshot(TEST_PATH, {
        exists: () => true,
        data: () => ({ content: { toUint8Array: () => garbage } }),
        metadata: { fromCache: false, hasPendingWrites: false },
      });

    emitGarbage();
    await flushAll();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      emitGarbage();
      await flushAll();
    }

    expect(delays.slice(0, 4)).toEqual([
      "attempt 1, delay 500ms",
      "attempt 2, delay 1000ms",
      "attempt 3, delay 2000ms",
      "attempt 4, delay 4000ms",
    ]);
  });
});
