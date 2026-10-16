import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { set } from "./_mocks/idb";
import {
  createTestProvider,
  flushMicrotasks,
  FireProvider,
} from "./helpers";
import {
  LOCAL_PERSIST_DEBOUNCE_MS,
  REMOTE_LOCAL_PERSIST_DELAY_MS,
} from "../provider";

function remoteUpdate(text: string): Uint8Array {
  const other = new Y.Doc();
  other.getText("t").insert(0, text);
  return Y.encodeStateAsUpdate(other);
}

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

  it("defers the local save of a remote update (DEV-358)", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const saveSpy = vi.spyOn(provider, "saveToLocal");

    Y.applyUpdate(created.ydoc, remoteUpdate("r"), "origin:firebase/update");
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(LOCAL_PERSIST_DEBOUNCE_MS);
    expect(saveSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(
      REMOTE_LOCAL_PERSIST_DELAY_MS - LOCAL_PERSIST_DEBOUNCE_MS,
    );
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("a local edit after a remote update saves on the short debounce", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const saveSpy = vi.spyOn(provider, "saveToLocal");

    Y.applyUpdate(created.ydoc, remoteUpdate("r"), "origin:firebase/update");
    created.ydoc.getText("t").insert(0, "local");
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(LOCAL_PERSIST_DEBOUNCE_MS);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("a remote update does not postpone a pending local save", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const saveSpy = vi.spyOn(provider, "saveToLocal");

    created.ydoc.getText("t").insert(0, "local");
    await vi.advanceTimersByTimeAsync(LOCAL_PERSIST_DEBOUNCE_MS - 100);
    Y.applyUpdate(created.ydoc, remoteUpdate("r"), "origin:firebase/update");
    await vi.advanceTimersByTimeAsync(100);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("flushSaveToLocal skips the encode when nothing changed (DEV-358)", async () => {
    const created = await createTestProvider();
    provider = created.provider;

    created.ydoc.getText("t").insert(0, "once");
    await provider.flushSaveToLocal();
    set.mockClear();

    await provider.flushSaveToLocal();
    expect(set).not.toHaveBeenCalled();
  });

  it("localEditsOnly flushes skip unsaved remote content", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    await provider.flushSaveToLocal();
    set.mockClear();

    Y.applyUpdate(created.ydoc, remoteUpdate("r"), "origin:firebase/update");
    await provider.flushSaveToLocal({ localEditsOnly: true });
    expect(set).not.toHaveBeenCalled();

    await provider.flushSaveToLocal();
    expect(set).toHaveBeenCalled();
  });

  it("reports the local encode to onMainThreadWork", async () => {
    const created = await createTestProvider();
    provider = created.provider;
    const events: Array<{ phase: string; bytes: number }> = [];
    provider.onMainThreadWork = (e) => events.push(e);

    created.ydoc.getText("t").insert(0, "measured");
    await provider.flushSaveToLocal();

    expect(events).toContainEqual(
      expect.objectContaining({ phase: "local-encode" }),
    );
    expect(events[0]!.bytes).toBeGreaterThan(0);
  });
});
