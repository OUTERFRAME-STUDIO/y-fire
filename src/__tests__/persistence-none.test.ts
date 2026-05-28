import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { setDocCalls } from "./_mocks/firestore";
import { get, set } from "./_mocks/idb";
import { createTestProvider, flushMicrotasks } from "./helpers";

describe("persistence none", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never touches idb-keyval and still queues Firestore on local edits", async () => {
    const { provider, ydoc } = await createTestProvider({
      persistence: "none",
      maxWaitFirestoreTime: 10,
      maxWaitTime: 10,
    });

    await flushMicrotasks();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();

    ydoc.getText("content").insert(0, "hello");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);

    expect(set).not.toHaveBeenCalled();
    expect(provider.firestoreTimeout || setDocCalls.length > 0).toBeTruthy();
  });
});
