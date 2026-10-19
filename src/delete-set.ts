import * as Y from "yjs";

/**
 * Deleted id ranges per client, `[clock, clock + len)`. Same shape as
 * Yjs's `DeleteSet.clients`, kept here so ranges can be subtracted.
 */
export type DeleteRanges = Map<number, Array<{ clock: number; len: number }>>;

type DeleteSetLike = {
  clients: Map<number, Array<{ clock: number; len: number }>>;
};

/** Append `ds` to `target` (unsorted; {@link normalizeDeleteRanges} later). */
export function addDeleteRanges(
  target: DeleteRanges,
  ds: DeleteSetLike | DeleteRanges,
): void {
  const clients = ds instanceof Map ? ds : ds.clients;
  for (const [client, items] of clients) {
    if (items.length === 0) continue;
    let list = target.get(client);
    if (!list) {
      list = [];
      target.set(client, list);
    }
    for (const item of items) {
      if (item.len > 0) list.push({ clock: item.clock, len: item.len });
    }
  }
}

/** Sorted, merged copy. */
export function normalizeDeleteRanges(ds: DeleteRanges): DeleteRanges {
  const out: DeleteRanges = new Map();
  for (const [client, items] of ds) {
    const sorted = items
      .filter((item) => item.len > 0)
      .map((item) => ({ clock: item.clock, len: item.len }))
      .sort((a, b) => a.clock - b.clock);
    const merged: Array<{ clock: number; len: number }> = [];
    for (const item of sorted) {
      const last = merged[merged.length - 1];
      if (last && item.clock <= last.clock + last.len) {
        last.len = Math.max(last.len, item.clock + item.len - last.clock);
      } else {
        merged.push(item);
      }
    }
    if (merged.length > 0) out.set(client, merged);
  }
  return out;
}

/** `a` minus `b`, normalized. */
export function subtractDeleteRanges(
  a: DeleteRanges,
  b: DeleteRanges,
): DeleteRanges {
  const left = normalizeDeleteRanges(a);
  const right = normalizeDeleteRanges(b);
  const out: DeleteRanges = new Map();
  for (const [client, items] of left) {
    const sub = right.get(client) ?? [];
    const rest: Array<{ clock: number; len: number }> = [];
    let j = 0;
    for (const item of items) {
      let start = item.clock;
      const end = item.clock + item.len;
      while (j < sub.length && sub[j].clock + sub[j].len <= start) j++;
      for (let k = j; k < sub.length && sub[k].clock < end; k++) {
        if (sub[k].clock > start) {
          rest.push({ clock: start, len: sub[k].clock - start });
        }
        start = Math.max(start, sub[k].clock + sub[k].len);
        if (start >= end) break;
      }
      if (start < end) rest.push({ clock: start, len: end - start });
    }
    if (rest.length > 0) out.set(client, rest);
  }
  return out;
}

export function countDeleteRanges(ds: DeleteRanges): number {
  let n = 0;
  for (const items of ds.values()) n += items.length;
  return n;
}

function writeVarUint(out: number[], num: number): void {
  while (num > 0x7f) {
    out.push(0x80 | (num % 0x80));
    num = Math.floor(num / 0x80);
  }
  out.push(num);
}

/**
 * Update-v1 delete set section, written as Yjs's `writeDeleteSet` does:
 * clients in descending order, ranges in the order given.
 */
export function encodeDeleteRangesV1(ds: DeleteRanges): Uint8Array {
  const out: number[] = [];
  const clients = [...ds.entries()].filter(([, items]) => items.length > 0);
  writeVarUint(out, clients.length);
  clients.sort((a, b) => b[0] - a[0]);
  for (const [client, items] of clients) {
    writeVarUint(out, client);
    writeVarUint(out, items.length);
    for (const item of items) {
      writeVarUint(out, item.clock);
      writeVarUint(out, item.len);
    }
  }
  return Uint8Array.from(out);
}

function endsWith(bytes: Uint8Array, suffix: Uint8Array): boolean {
  if (suffix.byteLength > bytes.byteLength) return false;
  const offset = bytes.byteLength - suffix.byteLength;
  for (let i = 0; i < suffix.byteLength; i++) {
    if (bytes[offset + i] !== suffix[i]) return false;
  }
  return true;
}

/**
 * Delta from `sinceSV` whose delete set holds only deletions a reader of
 * the persisted updates may not have (DEV-356).
 *
 * `Y.encodeStateAsUpdate(doc, sv)` writes the doc's whole delete set, so on a
 * long-lived shard a one-field edit carried 7-26 KB of old deletions, and a
 * save with nothing new still stored them. The result keeps the same
 * structs and carries the deletions in `unpersisted`, plus every deletion of
 * a struct at or past `sinceSV` (the structs this update ships).
 *
 * Falls back to the plain state-vector diff when the doc holds pending
 * structs or deletions, or when the encoded layout is not the expected
 * structs-then-delete-set of update v1.
 */
export function encodeDeltaWithDeleteRanges(
  doc: Y.Doc,
  sinceSV: Uint8Array | undefined,
  unpersisted: DeleteRanges,
): Uint8Array {
  const full = Y.encodeStateAsUpdate(doc, sinceSV);
  if (doc.store.pendingStructs || doc.store.pendingDs) return full;
  const { ds } = Y.decodeUpdate(full);
  const docDs: DeleteRanges = ds.clients;
  const docDsBytes = encodeDeleteRangesV1(docDs);
  if (!endsWith(full, docDsBytes)) return full;
  const since = sinceSV ? Y.decodeStateVector(sinceSV) : new Map();
  const keep: DeleteRanges = new Map();
  addDeleteRanges(keep, unpersisted);
  for (const [client, items] of docDs) {
    const from = since.get(client) ?? 0;
    const shipped: Array<{ clock: number; len: number }> = [];
    for (const item of items) {
      const end = item.clock + item.len;
      if (end <= from) continue;
      const start = Math.max(item.clock, from);
      shipped.push({ clock: start, len: end - start });
    }
    if (shipped.length > 0) addDeleteRanges(keep, new Map([[client, shipped]]));
  }
  const keepBytes = encodeDeleteRangesV1(normalizeDeleteRanges(keep));
  const structsLength = full.byteLength - docDsBytes.byteLength;
  const out = new Uint8Array(structsLength + keepBytes.byteLength);
  out.set(full.subarray(0, structsLength), 0);
  out.set(keepBytes, structsLength);
  return out;
}
