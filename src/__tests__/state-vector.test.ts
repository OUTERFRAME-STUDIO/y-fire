import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  mergeStateVectors,
  stateVectorCovers,
  stateVectorFromUpdate,
} from "../state-vector";

describe("mergeStateVectors", () => {
  it("takes the max clock per client", () => {
    const a = new Y.Doc();
    a.getText("t").insert(0, "aa");
    const svA = Y.encodeStateVector(a);

    const b = new Y.Doc();
    b.getText("t").insert(0, "bbbb");
    const svB = Y.encodeStateVector(b);

    const merged = mergeStateVectors(svA, svB);
    const map = Y.decodeStateVector(merged);
    const mapA = Y.decodeStateVector(svA);
    const mapB = Y.decodeStateVector(svB);

    for (const [client, clock] of mapA) {
      expect(map.get(client) ?? 0).toBeGreaterThanOrEqual(clock);
    }
    for (const [client, clock] of mapB) {
      expect(map.get(client) ?? 0).toBeGreaterThanOrEqual(clock);
    }
  });

  it("ignores empty / missing vectors", () => {
    const a = new Y.Doc();
    a.getText("t").insert(0, "x");
    const svA = Y.encodeStateVector(a);
    const merged = mergeStateVectors(undefined, new Uint8Array(), svA, null);
    expect(Y.decodeStateVector(merged)).toEqual(Y.decodeStateVector(svA));
  });

  it("stateVectorCovers is true when every clock is at least as high", () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "ab");
    const sv = Y.encodeStateVector(doc);
    expect(stateVectorCovers(sv, sv)).toBe(true);
    expect(stateVectorCovers(sv, new Uint8Array())).toBe(true);
    expect(stateVectorCovers(undefined, sv)).toBe(false);

    doc.getText("t").insert(2, "c");
    const later = Y.encodeStateVector(doc);
    expect(stateVectorCovers(later, sv)).toBe(true);
    expect(stateVectorCovers(sv, later)).toBe(false);
  });

  it("stateVectorFromUpdate matches encodeStateVectorFromUpdate", () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "hello");
    const update = Y.encodeStateAsUpdate(doc);
    expect(stateVectorFromUpdate(update)).toEqual(
      Y.encodeStateVectorFromUpdate(update),
    );
  });
});
