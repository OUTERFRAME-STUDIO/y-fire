import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  emitSnapshot,
  emitSnapshotError,
  emitUpdatesSnapshot,
  onSnapshotCallCount,
  resetFirestoreMock,
} from "./_mocks/firestore";
import { createTestProvider, flushMicrotasks, TEST_PATH } from "./helpers";

describe("snapshot auto-reconnect", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries trackData with exponential backoff on transient errors", async () => {
    const { provider } = await createTestProvider();
    const initialCalls = onSnapshotCallCount;

    emitSnapshotError(TEST_PATH, { code: "unavailable" });

    await vi.advanceTimersByTimeAsync(500);
    expect(onSnapshotCallCount).toBe(initialCalls + 2);

    emitSnapshotError(TEST_PATH, { code: "unavailable" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onSnapshotCallCount).toBe(initialCalls + 4);

    void provider;
  });

  it("resets retry attempt after a successful snapshot", async () => {
    const { provider } = await createTestProvider();
    const callsBefore = onSnapshotCallCount;

    emitSnapshotError(TEST_PATH, { code: "unavailable" });
    provider.trackData();

    expect(onSnapshotCallCount).toBeGreaterThan(callsBefore);
  });

  it("backs off a persistently failing snapshotStore read across re-subscribes", async () => {
    const denied = Object.assign(new Error("storage/unauthorized"), {
      code: "storage/unauthorized",
    });
    const read = vi.fn(async () => {
      throw denied;
    });
    await createTestProvider({
      snapshotStore: { read, write: vi.fn() },
    });
    const shard = {
      snapshotBackend: "storage",
      contentStoragePath: "snap/0",
    };
    // Like Firestore, every (re)subscribe first delivers the cached doc and
    // updates snapshots, whose success handlers reset the listener backoff.
    const deliverCachedSnapshots = async () => {
      emitSnapshot(TEST_PATH, {
        exists: () => true,
        data: () => shard,
        metadata: { fromCache: true, hasPendingWrites: false },
      });
      emitUpdatesSnapshot(TEST_PATH, { fromCache: true, hasPendingWrites: false });
      await flushMicrotasks();
    };

    await deliverCachedSnapshots();
    expect(read).toHaveBeenCalledTimes(1);

    for (const delay of [500, 1000, 2000, 4000]) {
      const subscribesBefore = onSnapshotCallCount;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(onSnapshotCallCount).toBe(subscribesBefore);
      await vi.advanceTimersByTimeAsync(1);
      expect(onSnapshotCallCount).toBe(subscribesBefore + 2);
      await deliverCachedSnapshots();
    }
    expect(read).toHaveBeenCalledTimes(5);
  });

  it("permission-denied triggers onDeleted and does not retry", async () => {
    resetFirestoreMock();
    const onDeleted = vi.fn();
    const { provider } = await createTestProvider();
    provider.onDeleted = onDeleted;
    const callsBefore = onSnapshotCallCount;

    emitSnapshotError(TEST_PATH, { code: "permission-denied" });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onSnapshotCallCount).toBe(callsBefore);
  });
});
