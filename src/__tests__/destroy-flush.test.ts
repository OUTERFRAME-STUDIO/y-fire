import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import { setDocCalls } from "./_mocks/firestore";
import { createTestProvider, flushMicrotasks } from "./helpers";

describe("destroy flush", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("drains pending Firestore queue on kill when cache is pending", async () => {
    const { provider, ydoc } = await createTestProvider();
    const update = Y.encodeStateAsUpdate(ydoc);
    provider.cache = update;

    await provider.kill();

    expect(setDocCalls.length).toBe(1);
  });

  it("drains pending Firestore queue on destroy when firestoreTimeout is set", async () => {
    const { provider } = await createTestProvider();
    provider.sendToFirestoreQueue();
    expect(provider.firestoreTimeout).toBeTruthy();

    provider.destroy();
    await flushMicrotasks();

    expect(setDocCalls.length).toBe(1);
  });
});
