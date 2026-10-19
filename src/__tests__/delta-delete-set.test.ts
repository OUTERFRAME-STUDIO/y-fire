import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { addDocCalls, emitUpdatesSnapshot, seedFirestoreUpdate } from "./_mocks/firestore";
import { idbStore } from "./_mocks/idb";
import {
  createTestProvider,
  decodeUpdateBytes,
  emitServerUpdate,
  flushMicrotasks,
  hydrateControl,
  TEST_PATH,
  FireProvider,
  whenTabFoldsIdle,
} from "./helpers";

/** Snapshot of a shard with a long edit history (a large delete set). */
function historySnapshot(): Uint8Array {
  const doc = new Y.Doc();
  for (let c = 0; c < 40; c++) {
    const writer = new Y.Doc();
    Y.applyUpdate(writer, Y.encodeStateAsUpdate(doc));
    const map = writer.getMap("m");
    const text = writer.getText("t");
    for (let i = 0; i < 25; i++) {
      map.set(`k${i % 5}`, `v${c}-${i}`);
      text.insert(0, `c${c}i${i} `);
      if (text.length > 8) text.delete(3, 2);
    }
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(writer));
  }
  return Y.encodeStateAsUpdate(doc);
}

function dsRangeCount(update: Uint8Array): number {
  let n = 0;
  for (const items of Y.decodeUpdate(update).ds.clients.values()) {
    n += items.length;
  }
  return n;
}

function appended(): Uint8Array[] {
  return addDocCalls.map((call) => decodeUpdateBytes(call.data));
}

function sameContent(a: Y.Doc, b: Y.Doc) {
  expect(a.getMap("m").toJSON()).toEqual(b.getMap("m").toJSON());
  expect(a.getText("t").toString()).toBe(b.getText("t").toString());
}

describe("append delete set (DEV-356)", () => {
  let provider: FireProvider | undefined;
  let snapshot: Uint8Array;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    provider = undefined;
    snapshot = historySnapshot();
    expect(dsRangeCount(snapshot)).toBeGreaterThan(500);
  });

  afterEach(async () => {
    await whenTabFoldsIdle();
    if (provider) {
      await provider.kill();
      provider = undefined;
    }
    vi.mocked(console.log).mockRestore();
  });

  async function hydratedProvider(seed?: () => void) {
    const created = await createTestProvider();
    provider = created.provider;
    seed?.();
    emitServerUpdate(TEST_PATH, snapshot);
    await flushMicrotasks();
    expect(provider.serverReady).toBe(true);
    return created;
  }

  it("a one-field edit appends only its own deletion", async () => {
    const { ydoc } = await hydratedProvider();
    ydoc.getMap("m").set("k0", "edited");
    await provider!.saveToFirestore();

    const [delta] = appended();
    expect(delta).toBeDefined();
    expect(dsRangeCount(delta)).toBe(1);
    expect(delta.byteLength).toBeLessThan(100);
    sameContent(hydrateControl(snapshot, [delta]), ydoc);
  });

  it("does not re-send a deletion an earlier append carried", async () => {
    const { ydoc } = await hydratedProvider();
    ydoc.getMap("m").set("k0", "first");
    await provider!.saveToFirestore();
    ydoc.getMap("m").set("k1", "second");
    await provider!.saveToFirestore();

    const [first, second] = appended();
    expect(dsRangeCount(first)).toBe(1);
    expect(dsRangeCount(second)).toBe(1);
    const firstDs = [...Y.decodeUpdate(first).ds.clients.entries()];
    const secondDs = [...Y.decodeUpdate(second).ds.clients.entries()];
    expect(secondDs).not.toEqual(firstDs);
    sameContent(hydrateControl(snapshot, [first, second]), ydoc);
  });

  it("restoring an IndexedDB copy with nothing new appends nothing", async () => {
    vi.useFakeTimers();
    try {
      await hydratedProvider(() => idbStore.set(TEST_PATH, snapshot));
      await provider!.syncLocal();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(addDocCalls.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restoring an IndexedDB copy with an offline delete persists the delete", async () => {
    const offline = new Y.Doc();
    Y.applyUpdate(offline, snapshot);
    offline.getText("t").delete(0, 30);
    offline.getMap("m").delete("k2");
    const offlineBytes = Y.encodeStateAsUpdate(offline);

    const { ydoc } = await hydratedProvider(() =>
      idbStore.set(TEST_PATH, offlineBytes),
    );
    await provider!.syncLocal();
    await flushMicrotasks();
    await provider!.saveToFirestore();

    const deltas = appended();
    expect(deltas.length).toBe(1);
    expect(Y.decodeUpdate(deltas[0]).structs.length).toBe(0);
    sameContent(hydrateControl(snapshot, deltas), offline);
  });

  it("persists deletions that arrive from a WebRTC peer", async () => {
    const peer = new Y.Doc();
    Y.applyUpdate(peer, snapshot);
    const sv = Y.encodeStateVector(peer);
    peer.getText("t").delete(5, 10);
    peer.getMap("m").set("k3", "peer");
    const peerUpdate = Y.encodeStateAsUpdate(peer, sv);

    const { ydoc } = await hydratedProvider();
    Y.applyUpdate(ydoc, peerUpdate, "peer-uid");
    ydoc.getMap("m").set("k4", "local");
    await provider!.saveToFirestore();

    const deltas = appended();
    expect(deltas.length).toBe(1);
    sameContent(hydrateControl(snapshot, deltas), ydoc);
  });

  it("deletes of content from another client's update converge", async () => {
    const other = new Y.Doc();
    Y.applyUpdate(other, snapshot);
    const sv = Y.encodeStateVector(other);
    other.getText("t").insert(0, "from-other ");
    other.getMap("m").set("fresh", "x");
    const otherUpdate = Y.encodeStateAsUpdate(other, sv);
    const { ydoc } = await hydratedProvider(() =>
      seedFirestoreUpdate(TEST_PATH, "other-1", otherUpdate, { seq: 1 }),
    );
    expect(ydoc.getText("t").toString().startsWith("from-other ")).toBe(true);
    ydoc.getText("t").delete(0, 5);
    ydoc.getMap("m").delete("fresh");
    await provider!.saveToFirestore();

    const deltas = appended();
    expect(deltas.length).toBe(1);
    sameContent(hydrateControl(snapshot, [otherUpdate, ...deltas]), ydoc);
    // Order does not matter to a reader.
    sameContent(hydrateControl(snapshot, [...deltas, otherUpdate]), ydoc);
  });

  it("two offline clients with concurrent edits and deletes converge from the stored updates", async () => {
    const editA = async () => {
      const { ydoc } = await hydratedProvider();
      ydoc.getText("t").delete(0, 20);
      ydoc.getText("t").insert(0, "A-was-here ");
      ydoc.getMap("m").set("k0", "A");
      ydoc.getMap("m").delete("k1");
      await provider!.saveToFirestore();
      const state = Y.encodeStateAsUpdate(ydoc);
      const deltas = appended();
      await provider!.kill();
      provider = undefined;
      return { state, deltas };
    };
    const editB = async () => {
      const { ydoc } = await hydratedProvider();
      ydoc.getText("t").delete(10, 25);
      ydoc.getText("t").insert(3, "B ");
      ydoc.getMap("m").set("k0", "B");
      ydoc.getMap("m").set("k1", "B");
      await provider!.saveToFirestore();
      const state = Y.encodeStateAsUpdate(ydoc);
      const deltas = appended();
      return { state, deltas };
    };

    const a = await editA();
    const b = await editB();
    expect(a.deltas.length).toBe(1);
    expect(b.deltas.length).toBe(1);
    for (const d of [...a.deltas, ...b.deltas]) {
      expect(d.byteLength).toBeLessThan(400);
    }

    const expected = new Y.Doc();
    Y.applyUpdate(expected, a.state);
    Y.applyUpdate(expected, b.state);
    sameContent(hydrateControl(snapshot, [...a.deltas, ...b.deltas]), expected);
    sameContent(hydrateControl(snapshot, [...b.deltas, ...a.deltas]), expected);
  });

  it("a fold after appends keeps every deletion", async () => {
    const { ydoc } = await hydratedProvider();
    ydoc.getText("t").delete(0, 15);
    await provider!.saveToFirestore();
    ydoc.getMap("m").set("k2", "after");
    await provider!.saveToFirestore();
    const deltas = appended();
    expect(deltas.length).toBe(2);
    emitUpdatesSnapshot(TEST_PATH);
    await flushMicrotasks();
    sameContent(hydrateControl(snapshot, deltas), ydoc);
  });
});
