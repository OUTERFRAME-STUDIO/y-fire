import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { set } from "./_mocks/idb";
import {
  createTestProvider,
  flushMicrotasks,
  FireProvider,
} from "./helpers";

describe("local persist debounce", () => {
  let provider: FireProvider | undefined;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    provider = undefined;
  });

  afterEach(async () => {
    if (provider) {
      await provider.kill();
      provider = undefined;
    }
    vi.useRealTimers();
    vi.mocked(console.log).mockRestore();
  });

  it("N local updates produce one setLocal after the trailing debounce", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const saveSpy = vi.spyOn(provider, "saveToLocal");
    set.mockClear();

    const t = created.ydoc.getText("t");
    t.insert(0, "a");
    t.insert(1, "b");
    t.insert(2, "c");
    t.insert(3, "d");
    await flushMicrotasks();

    expect(saveSpy).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(saveSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalled();
  });

  it("flushOnHide writes IndexedDB immediately without waiting for the debounce", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const saveSpy = vi.spyOn(provider, "saveToLocal");
    set.mockClear();

    created.ydoc.getText("t").insert(0, "hidden");
    await flushMicrotasks();
    expect(saveSpy).not.toHaveBeenCalled();

    provider.flushOnHide();
    await flushMicrotasks();

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalled();
  });

  it("destroy writes IndexedDB immediately without waiting for the debounce", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const saveSpy = vi.spyOn(provider, "saveToLocal");
    set.mockClear();

    created.ydoc.getText("t").insert(0, "destroy-me");
    await flushMicrotasks();
    expect(saveSpy).not.toHaveBeenCalled();

    await provider.kill();
    provider = undefined;

    expect(saveSpy).toHaveBeenCalled();
    expect(set).toHaveBeenCalled();
  });
});
