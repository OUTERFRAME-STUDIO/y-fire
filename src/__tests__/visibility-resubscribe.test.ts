import { describe, it, expect, vi, beforeEach } from "vitest";
import { onSnapshotCallCount, snapshotSubscriptions } from "./_mocks/firestore";
import { createTestProvider, flushMicrotasks, TEST_PATH } from "./helpers";
import { setVisibilityState } from "./_mocks/lifecycle";

describe("visibility resubscribe", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("visibility hidden does not unsubscribe trackData", async () => {
    const { provider } = await createTestProvider();
    const subscriptionsAfterInit = onSnapshotCallCount;

    setVisibilityState("hidden");
    await flushMicrotasks();

    expect(onSnapshotCallCount).toBe(subscriptionsAfterInit);
    expect(snapshotSubscriptions.has(TEST_PATH)).toBe(true);

    setVisibilityState("visible");
    await flushMicrotasks();

    expect(onSnapshotCallCount).toBe(subscriptionsAfterInit);
    void provider;
  });
});
