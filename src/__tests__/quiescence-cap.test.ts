import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { setDocCalls } from "./_mocks/firestore";
import {
  createTestProvider,
  emitRemoteUpdate,
  TEST_PATH,
} from "./helpers";

describe("quiescence cap", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forces save when deferral exceeds maxFirestoreDeferral", async () => {
    const remoteDoc = new Y.Doc();
    remoteDoc.getText("remote").insert(0, "peer");
    const remote = Y.encodeStateAsUpdate(remoteDoc);

    const { provider } = await createTestProvider({
      maxWaitFirestoreTime: 50,
      maxFirestoreDeferral: 200,
    });

    provider.sendToFirestoreQueue();

    for (let t = 0; t <= 180; t += 30) {
      await vi.advanceTimersByTimeAsync(30);
      emitRemoteUpdate(TEST_PATH, remote);
    }

    expect(setDocCalls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(30);
    emitRemoteUpdate(TEST_PATH, remote);
    await vi.advanceTimersByTimeAsync(50);

    expect(setDocCalls.length).toBe(1);
  });
});
