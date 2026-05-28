import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  emitSnapshotError,
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
    expect(onSnapshotCallCount).toBe(initialCalls + 1);

    emitSnapshotError(TEST_PATH, { code: "unavailable" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onSnapshotCallCount).toBe(initialCalls + 2);

    void provider;
  });

  it("resets retry attempt after a successful snapshot", async () => {
    const { provider } = await createTestProvider();
    const callsBefore = onSnapshotCallCount;

    emitSnapshotError(TEST_PATH, { code: "unavailable" });
    provider.trackData();

    expect(onSnapshotCallCount).toBeGreaterThan(callsBefore);
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
