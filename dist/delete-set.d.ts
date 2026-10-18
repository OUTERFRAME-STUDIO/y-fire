import * as Y from "yjs";
/**
 * Deleted id ranges per client, `[clock, clock + len)`. Same shape as
 * Yjs's `DeleteSet.clients`, kept here so ranges can be subtracted.
 */
export type DeleteRanges = Map<number, Array<{
    clock: number;
    len: number;
}>>;
type DeleteSetLike = {
    clients: Map<number, Array<{
        clock: number;
        len: number;
    }>>;
};
/** Append `ds` to `target` (unsorted; {@link normalizeDeleteRanges} later). */
export declare function addDeleteRanges(target: DeleteRanges, ds: DeleteSetLike | DeleteRanges): void;
/** Sorted, merged copy. */
export declare function normalizeDeleteRanges(ds: DeleteRanges): DeleteRanges;
/** `a` minus `b`, normalized. */
export declare function subtractDeleteRanges(a: DeleteRanges, b: DeleteRanges): DeleteRanges;
export declare function countDeleteRanges(ds: DeleteRanges): number;
/**
 * Update-v1 delete set section, written as Yjs's `writeDeleteSet` does:
 * clients in descending order, ranges in the order given.
 */
export declare function encodeDeleteRangesV1(ds: DeleteRanges): Uint8Array;
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
export declare function encodeDeltaWithDeleteRanges(doc: Y.Doc, sinceSV: Uint8Array | undefined, unpersisted: DeleteRanges): Uint8Array;
export {};
//# sourceMappingURL=delete-set.d.ts.map