import { describe, it, expect, vi, beforeEach } from "vitest";
import { setDocCalls, onSnapshotCallCount } from "./_mocks/firestore";
import {
  createTestProvider,
  flushMicrotasks,
} from "./helpers";
import {
  fireLifecycleEvent,
  firePageShow,
  setVisibilityState,
} from "./_mocks/lifecycle";

describe("pagehide flush", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("pagehide triggers a Firestore flush via destroy", async () => {
    const { provider } = await createTestProvider();
    provider.sendToFirestoreQueue();

    fireLifecycleEvent("pagehide");
    await flushMicrotasks();

    expect(setDocCalls.length).toBe(1);
  });

  it("visibility hidden triggers flushOnHide without full destroy", async () => {
    const { provider } = await createTestProvider();
    provider.sendToFirestoreQueue();
    const callsBefore = setDocCalls.length;

    setVisibilityState("hidden");
    await flushMicrotasks();

    expect(setDocCalls.length).toBe(callsBefore + 1);
  });

  it("pageshow re-arms trackData without double-flushing", async () => {
    const { provider } = await createTestProvider();
    setVisibilityState("hidden");
    await flushMicrotasks();
    const callsAfterHide = setDocCalls.length;
    const subscriptionsAfterHide = onSnapshotCallCount;

    firePageShow();
    await flushMicrotasks();

    expect(setDocCalls.length).toBe(callsAfterHide);
    expect(onSnapshotCallCount).toBeGreaterThan(subscriptionsAfterHide);
    void provider;
  });
});
