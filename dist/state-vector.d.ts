export declare function mergeStateVectors(...vectors: Array<Uint8Array | undefined | null>): Uint8Array;
export declare function stateVectorFromUpdate(update: Uint8Array): Uint8Array;
/** True when `cover` has every client clock in `other` at least as high. */
export declare function stateVectorCovers(cover: Uint8Array | undefined | null, other: Uint8Array | undefined | null): boolean;
//# sourceMappingURL=state-vector.d.ts.map