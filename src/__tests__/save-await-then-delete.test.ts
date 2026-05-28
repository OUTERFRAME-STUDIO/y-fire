import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setSetDocImpl } from "./_mocks/firestore";
import { del, getIdbDeleteCount } from "./_mocks/idb";
import { createTestProvider } from "./helpers";

describe("save await then delete", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("does not deleteLocal when setDoc rejects", async () => {
    const { provider } = await createTestProvider();
    setSetDocImpl(async () => {
      throw new Error("network error");
    });

    await provider.saveToFirestore();

    expect(getIdbDeleteCount()).toBe(0);
  });

  it("deletes local exactly once when setDoc resolves", async () => {
    const { provider } = await createTestProvider();
    setSetDocImpl(async () => {});

    await provider.saveToFirestore();

    expect(del).toHaveBeenCalledTimes(1);
  });
});
