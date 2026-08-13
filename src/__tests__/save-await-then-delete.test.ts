import { describe, it, expect, vi, beforeEach } from "vitest";
import { setTransactionError } from "./_mocks/firestore";
import { del, getIdbDeleteCount } from "./_mocks/idb";
import { createTestProvider, markServerReady, TEST_PATH } from "./helpers";

describe("save await then delete", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("does not deleteLocal when the merge transaction rejects", async () => {
    const { provider } = await createTestProvider();
    await markServerReady(TEST_PATH);
    setTransactionError(new Error("network error"));

    await provider.saveToFirestore();

    expect(getIdbDeleteCount()).toBe(0);
  });

  it("deletes local exactly once when the merge transaction resolves", async () => {
    const { provider } = await createTestProvider();
    await markServerReady(TEST_PATH);

    await provider.saveToFirestore();

    expect(del).toHaveBeenCalledTimes(1);
  });
});
