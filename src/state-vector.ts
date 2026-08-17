import * as Y from "yjs";

export function mergeStateVectors(
  ...vectors: Array<Uint8Array | undefined | null>
): Uint8Array {
  const merged = new Map<number, number>();
  for (const vector of vectors) {
    if (!vector || vector.byteLength === 0) continue;
    const map = Y.decodeStateVector(vector);
    for (const [client, clock] of map) {
      const prev = merged.get(client) ?? 0;
      if (clock > prev) merged.set(client, clock);
    }
  }
  return Y.encodeStateVector(merged);
}

export function stateVectorFromUpdate(update: Uint8Array): Uint8Array {
  return Y.encodeStateVectorFromUpdate(update);
}

/** True when `cover` has every client clock in `other` at least as high. */
export function stateVectorCovers(
  cover: Uint8Array | undefined | null,
  other: Uint8Array | undefined | null,
): boolean {
  if (!other || other.byteLength === 0) return true;
  if (!cover || cover.byteLength === 0) return false;
  const coverMap = Y.decodeStateVector(cover);
  const otherMap = Y.decodeStateVector(other);
  for (const [client, clock] of otherMap) {
    if ((coverMap.get(client) ?? 0) < clock) return false;
  }
  return true;
}
