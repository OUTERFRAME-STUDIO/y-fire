import { describe, it, expect, vi, beforeEach } from "vitest";
import { onSnapshotCallCount } from "./_mocks/firestore";
import { createTestProvider, flushMicrotasks } from "./helpers";
import { setVisibilityState } from "./_mocks/lifecycle";

describe("visibility resubscribe", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("visibility visible re-subscribes onSnapshot after hidden pause", async () => {
    const { provider } = await createTestProvider();
    const subscriptionsAfterInit = onSnapshotCallCount;

    setVisibilityState("hidden");
    await flushMicrotasks();
    const subscriptionsAfterHide = onSnapshotCallCount;

    setVisibilityState("visible");
    await flushMicrotasks();

    expect(subscriptionsAfterHide).toBe(subscriptionsAfterInit);
    expect(onSnapshotCallCount).toBeGreaterThan(subscriptionsAfterHide);
    void provider;
  });
});
