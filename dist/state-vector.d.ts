export declare function mergeStateVectors(...vectors: Array<Uint8Array | undefined | null>): Uint8Array;
/**
 * Exact per-client clock from an update's structs.
 *
 * `Y.encodeStateVectorFromUpdate` only counts a client whose structs start at
 * clock 0, so it drops the writing client from every delta encoded against a
 * non-zero state vector. Fold/append bookkeeping needs the true
 * `max(clock + length)` so `lastPersistedSV` can advance.
 */
export declare function stateVectorFromUpdate(update: Uint8Array): Uint8Array;
/** True when `cover` has every client clock in `other` at least as high. */
export declare function stateVectorCovers(cover: Uint8Array | undefined | null, other: Uint8Array | undefined | null): boolean;
//# sourceMappingURL=state-vector.d.ts.map