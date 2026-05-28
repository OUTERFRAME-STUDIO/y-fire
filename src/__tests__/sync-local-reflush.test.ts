import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { setDocCalls } from "./_mocks/firestore";
import { get, idbStore } from "./_mocks/idb";
import {
  createTestProvider,
  TEST_PATH,
} from "./helpers";

describe("syncLocal re-flush", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-queues Firestore flush after restoring non-empty local bytes", async () => {
    const seedDoc = new Y.Doc();
    seedDoc.getText("local").insert(0, "offline-data");
    const localBytes = Y.encodeStateAsUpdate(seedDoc);

    const { provider } = await createTestProvider({
      maxWaitFirestoreTime: 10,
      maxFirestoreDeferral: 15,
    });

    idbStore.set(TEST_PATH, localBytes);
    await provider.syncLocal();
    await vi.advanceTimersByTimeAsync(20);

    expect(setDocCalls.length).toBeGreaterThan(0);
    const saved = setDocCalls[0]?.data as {
      content: { toUint8Array: () => Uint8Array };
    };
    expect(saved.content.toUint8Array()).toEqual(
      Y.encodeStateAsUpdate(provider.doc),
    );
  });

  it("skips IDB read and re-flush when persistence is none", async () => {
    idbStore.set(TEST_PATH, new Uint8Array([9, 9, 9]));

    await createTestProvider({ persistence: "none" });

    expect(get).not.toHaveBeenCalled();
    expect(setDocCalls.length).toBe(0);
  });
});
