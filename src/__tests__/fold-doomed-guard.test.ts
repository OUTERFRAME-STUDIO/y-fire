import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";

vi.mock("../append-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../append-store")>();
  return { ...actual, foldUpdates: vi.fn(actual.foldUpdates) };
});

import {
  createTestProvider,
  emitServerUpdate,
  flushMicrotasks,
  TEST_PATH,
  whenTabFoldsIdle,
  FireProvider,
} from "./helpers";
import { foldUpdates } from "../append-store";

describe("DEV-358 doomed fold guard", () => {
  let provider: FireProvider | undefined;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(foldUpdates).mockClear();
    provider = undefined;
  });

  afterEach(async () => {
    await whenTabFoldsIdle();
    if (provider) {
      await provider.kill();
      provider = undefined;
    }
    vi.mocked(console.log).mockRestore();
  });

  async function appendTwice(maxContentBytes: number) {
    const remote = new Y.Doc();
    remote.getText("t").insert(0, "x".repeat(600));
    const created = await createTestProvider({
      foldUpdateThreshold: 2,
      maxContentBytes,
    });
    provider = created.provider;
    const onSaveError = vi.fn();
    provider.onSaveError = onSaveError;
    emitServerUpdate(TEST_PATH, Y.encodeStateAsUpdate(remote));
    await flushMicrotasks();

    created.ydoc.getText("t").insert(0, "A");
    await provider.saveToFirestore();
    created.ydoc.getText("t").insert(0, "B");
    await provider.saveToFirestore();
    await whenTabFoldsIdle();
    return onSaveError;
  }

  it("skips the union when the replica alone is over the cap", async () => {
    const onSaveError = await appendTwice(400);

    expect(foldUpdates).not.toHaveBeenCalled();
    expect(onSaveError).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "compact-required" }),
      expect.anything(),
    );
  });

  it("still folds when the replica fits", async () => {
    await appendTwice(64 * 1024);

    expect(foldUpdates).toHaveBeenCalledTimes(1);
  });
});
