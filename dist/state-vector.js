import * as Y from "yjs";
export function mergeStateVectors(...vectors) {
    var _a;
    const merged = new Map();
    for (const vector of vectors) {
        if (!vector || vector.byteLength === 0)
            continue;
        const map = Y.decodeStateVector(vector);
        for (const [client, clock] of map) {
            const prev = (_a = merged.get(client)) !== null && _a !== void 0 ? _a : 0;
            if (clock > prev)
                merged.set(client, clock);
        }
    }
    return Y.encodeStateVector(merged);
}
/**
 * Exact per-client clock from an update's structs.
 *
 * `Y.encodeStateVectorFromUpdate` only counts a client whose structs start at
 * clock 0, so it drops the writing client from every delta encoded against a
 * non-zero state vector. Fold/append bookkeeping needs the true
 * `max(clock + length)` so `lastPersistedSV` can advance.
 */
export function stateVectorFromUpdate(update) {
    var _a;
    const { structs } = Y.decodeUpdate(update);
    const clocks = new Map();
    for (const struct of structs) {
        if (struct instanceof Y.Skip)
            continue;
        const end = struct.id.clock + struct.length;
        const prev = (_a = clocks.get(struct.id.client)) !== null && _a !== void 0 ? _a : 0;
        if (end > prev)
            clocks.set(struct.id.client, end);
    }
    return Y.encodeStateVector(clocks);
}
/** True when `cover` has every client clock in `other` at least as high. */
export function stateVectorCovers(cover, other) {
    var _a;
    if (!other || other.byteLength === 0)
        return true;
    if (!cover || cover.byteLength === 0)
        return false;
    const coverMap = Y.decodeStateVector(cover);
    const otherMap = Y.decodeStateVector(other);
    for (const [client, clock] of otherMap) {
        if (((_a = coverMap.get(client)) !== null && _a !== void 0 ? _a : 0) < clock)
            return false;
    }
    return true;
}
