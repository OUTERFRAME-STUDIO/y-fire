import { describe, it, expect, vi, beforeEach } from "vitest";
import { setDocCalls, onSnapshotCallCount } from "./_mocks/firestore";
import {
  createTestProvider,
  flushMicrotasks,
  markServerReady,
  TEST_PATH,
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

  it("pagehide triggers a Firestore flush via destroy once server-ready", async () => {
    const { provider } = await createTestProvider();
    await markServerReady(TEST_PATH);
    provider.sendToFirestoreQueue();

    fireLifecycleEvent("pagehide");
    await flushMicrotasks();

    expect(setDocCalls.length).toBe(1);
  });

  it("visibility hidden flushes only after serverReady", async () => {
    const { provider } = await createTestProvider();
    provider.sendToFirestoreQueue();
    const callsBefore = setDocCalls.length;

    setVisibilityState("hidden");
    await flushMicrotasks();
    expect(setDocCalls.length).toBe(callsBefore);

    await markServerReady(TEST_PATH);
    provider.sendToFirestoreQueue();
    setVisibilityState("hidden");
    await flushMicrotasks();

    expect(setDocCalls.length).toBe(callsBefore + 1);
  });

  it("pageshow does not re-subscribe because hide no longer unsubscribes", async () => {
    const { provider } = await createTestProvider();
    const subscriptionsAfterInit = onSnapshotCallCount;
    setVisibilityState("hidden");
    await flushMicrotasks();
    const callsAfterHide = setDocCalls.length;

    firePageShow();
    await flushMicrotasks();

    expect(setDocCalls.length).toBe(callsAfterHide);
    expect(onSnapshotCallCount).toBe(subscriptionsAfterInit);
    void provider;
  });
});
