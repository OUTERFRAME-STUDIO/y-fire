import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  countDeleteRanges,
  encodeDeleteRangesV1,
  encodeDeltaWithDeleteRanges,
  normalizeDeleteRanges,
  subtractDeleteRanges,
  type DeleteRanges,
} from "../delete-set";

function ranges(
  entries: Array<[number, Array<[number, number]>]>,
): DeleteRanges {
  return new Map(
    entries.map(([client, items]) => [
      client,
      items.map(([clock, len]) => ({ clock, len })),
    ]),
  );
}

function plain(ds: DeleteRanges) {
  return [...ds.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([client, items]) => [client, items.map((i) => [i.clock, i.len])]);
}

function docDeleteRanges(doc: Y.Doc): DeleteRanges {
  return normalizeDeleteRanges(
    Y.createDeleteSetFromStructStore(doc.store).clients,
  );
}

/** A doc with a long edit history: many clients, many deleted ranges. */
function historyDoc(opts: { gc?: boolean } = {}): Y.Doc {
  const doc = new Y.Doc({ gc: opts.gc ?? true });
  for (let c = 0; c < 30; c++) {
    const writer = new Y.Doc();
    Y.applyUpdate(writer, Y.encodeStateAsUpdate(doc));
    const map = writer.getMap("m");
    const text = writer.getText("t");
    for (let i = 0; i < 20; i++) {
      map.set(`k${i % 5}`, `v${c}-${i}`);
      text.insert(0, `c${c}i${i} `);
      if (text.length > 8) text.delete(3, 2);
    }
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(writer));
  }
  return doc;
}

describe("delete ranges", () => {
  it("normalizes by sorting and merging overlapping or touching ranges", () => {
    const ds = ranges([[1, [[10, 2], [0, 3], [3, 2], [11, 5]]]]);
    expect(plain(normalizeDeleteRanges(ds))).toEqual([[1, [[0, 5], [10, 6]]]]);
  });

  it("subtracts ranges, splitting where needed", () => {
    const a = ranges([
      [1, [[0, 10], [20, 5]]],
      [2, [[0, 4]]],
    ]);
    const b = ranges([
      [1, [[2, 3], [8, 14]]],
      [2, [[0, 4]]],
    ]);
    expect(plain(subtractDeleteRanges(a, b))).toEqual([
      [1, [[0, 2], [5, 3], [22, 3]]],
    ]);
  });

  it("encodes the delete set exactly as Yjs does", () => {
    const doc = historyDoc();
    const update = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc));
    const ds = Y.decodeUpdate(update).ds.clients;
    expect(countDeleteRanges(ds)).toBeGreaterThan(100);
    const bytes = encodeDeleteRangesV1(ds);
    // A struct-less update is one zero byte followed by the delete set.
    expect(update).toEqual(Uint8Array.from([0, ...bytes]));
  });
});

describe("encodeDeltaWithDeleteRanges", () => {
  it("drops persisted deletions and keeps the structs", () => {
    const doc = historyDoc();
    const persisted = Y.encodeStateAsUpdate(doc);
    const sv = Y.encodeStateVector(doc);
    doc.getMap("m").set("k0", "edited");

    const before = Y.encodeStateAsUpdate(doc, sv);
    const after = encodeDeltaWithDeleteRanges(doc, sv, new Map());
    expect(after.byteLength).toBeLessThan(before.byteLength / 10);
    expect(Y.decodeUpdate(after).structs.length).toBe(
      Y.decodeUpdate(before).structs.length,
    );

    const reader = new Y.Doc();
    Y.applyUpdate(reader, persisted);
    Y.applyUpdate(reader, after);
    expect(reader.getMap("m").toJSON()).toEqual(doc.getMap("m").toJSON());
    expect(plain(docDeleteRanges(reader))).toEqual(plain(docDeleteRanges(doc)));
  });

  it("is empty when nothing changed", () => {
    const doc = historyDoc();
    const sv = Y.encodeStateVector(doc);
    expect(encodeDeltaWithDeleteRanges(doc, sv, new Map())).toEqual(
      Uint8Array.from([0, 0]),
    );
  });

  it("ships unpersisted deletions of old structs", () => {
    const doc = historyDoc();
    const persisted = Y.encodeStateAsUpdate(doc);
    const sv = Y.encodeStateVector(doc);
    const local: DeleteRanges = new Map();
    doc.on("afterTransaction", (tr: Y.Transaction) => {
      for (const [client, items] of tr.deleteSet.clients) {
        local.set(client, [...(local.get(client) ?? []), ...items]);
      }
    });
    const text = doc.getText("t");
    text.delete(0, 40);

    const delta = encodeDeltaWithDeleteRanges(doc, sv, local);
    expect(Y.decodeUpdate(delta).structs.length).toBe(0);

    const reader = new Y.Doc();
    Y.applyUpdate(reader, persisted);
    Y.applyUpdate(reader, delta);
    expect(reader.getText("t").toString()).toBe(text.toString());
  });

  it("ships the deletion state of structs it ships even when not tracked", () => {
    // gc off keeps deleted content, so only the delete set marks it deleted.
    const doc = historyDoc({ gc: false });
    const persisted = Y.encodeStateAsUpdate(doc);
    const sv = Y.encodeStateVector(doc);
    const text = doc.getText("t");
    text.insert(0, "temporary ");
    text.delete(0, 4);

    // No tracked deletions: the new structs' own deletion still goes out.
    const delta = encodeDeltaWithDeleteRanges(doc, sv, new Map());
    const reader = new Y.Doc();
    Y.applyUpdate(reader, persisted);
    Y.applyUpdate(reader, delta);
    expect(reader.getText("t").toString()).toBe(text.toString());
  });

  it("falls back to the full diff while the doc holds pending structs", () => {
    const source = new Y.Doc();
    source.getText("t").insert(0, "a");
    const sv1 = Y.encodeStateVector(source);
    source.getText("t").insert(1, "b");
    const later = Y.encodeStateAsUpdate(source, sv1);

    const doc = historyDoc();
    Y.applyUpdate(doc, later); // depends on a struct this doc lacks
    expect(doc.store.pendingStructs).not.toBeNull();
    const sv = Y.encodeStateVector(doc);
    expect(encodeDeltaWithDeleteRanges(doc, sv, new Map())).toEqual(
      Y.encodeStateAsUpdate(doc, sv),
    );
  });
});
