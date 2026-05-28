import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { createTestProvider, flushMicrotasks } from "./helpers";

const CLIENT_UID = "test-uid";

function yFireQueuesFirestoreFlush(origin: unknown, uid: string): boolean {
  if (origin === uid) return false;
  const from = typeof origin === "string" ? origin : uid;
  return from === uid;
}

describe("origin routing", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("routes uid-origin updates to Firestore queue", async () => {
    const { provider } = await createTestProvider();
    const queueSpy = vi.spyOn(provider, "sendToFirestoreQueue");

    provider.sendToQueue({
      from: CLIENT_UID,
      update: new Uint8Array([1]),
    });

    expect(queueSpy).not.toHaveBeenCalled();

    provider.sendCache(CLIENT_UID);
    expect(queueSpy).toHaveBeenCalled();
  });

  it("treats non-uid string origins as peer-only", async () => {
    const { provider } = await createTestProvider();
    const queueSpy = vi.spyOn(provider, "sendToFirestoreQueue");
    const peerSpy = vi.spyOn(provider, "sendDataToPeers");

    provider.sendToQueue({
      from: "local-sync",
      update: new Uint8Array([2]),
    });

    expect(queueSpy).not.toHaveBeenCalled();
    expect(peerSpy).toHaveBeenCalled();
  });

  it("mirrors updateHandler routing for object vs string origins", async () => {
    expect(yFireQueuesFirestoreFlush("local-sync", CLIENT_UID)).toBe(false);
    expect(yFireQueuesFirestoreFlush("peer-uid", CLIENT_UID)).toBe(false);
    expect(yFireQueuesFirestoreFlush(undefined, CLIENT_UID)).toBe(true);
    expect(yFireQueuesFirestoreFlush({ key: "local-sync" }, CLIENT_UID)).toBe(
      true,
    );

    const { provider, ydoc } = await createTestProvider({
      maxWaitTime: 10,
    });
    const queueSpy = vi.spyOn(provider, "sendToFirestoreQueue");

    ydoc.getText("a").insert(0, "x");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);

    expect(queueSpy).toHaveBeenCalled();
  });
});
