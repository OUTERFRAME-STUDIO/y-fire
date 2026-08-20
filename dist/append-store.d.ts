import { Bytes, Firestore } from "@firebase/firestore";
export declare const UPDATES_SUBCOLLECTION = "updates";
export declare const DEFAULT_EPOCH_FIELD = "contentGeneration";
export declare const SNAPSHOT_SV_FIELD = "snapshotSV";
export declare const DEFAULT_FOLD_UPDATE_THRESHOLD = 20;
export declare const DEFAULT_FOLD_BYTES_FRACTION = 0.5;
export declare function updatesCollectionPath(documentPath: string): string;
export declare function isAlreadyExistsError(error: unknown): boolean;
export declare function updateIdFromAlreadyExistsError(error: unknown): string | undefined;
export declare function readBytes(value: unknown): Uint8Array | undefined;
export declare function readSnapshotMeta(data: Record<string, unknown> | undefined, epochField?: string): {
    content?: Uint8Array;
    snapshotSV?: Uint8Array;
    epoch: number;
};
export type ListedUpdate = {
    id: string;
    update: Uint8Array;
    seq: number;
    clientId?: string;
};
export declare function unionYjsBytes(parts: Array<Uint8Array | undefined | null>): Uint8Array;
export declare function appendUpdate(db: Firestore, documentPath: string, payload: {
    update: Uint8Array;
    seq: number;
    clientId?: string;
}): Promise<import("@firebase/firestore").DocumentReference<import("@firebase/firestore").DocumentData, import("@firebase/firestore").DocumentData>>;
export declare function listUpdates(db: Firestore, documentPath: string): Promise<ListedUpdate[]>;
export declare function writeSnapshot(opts: {
    db: Firestore;
    documentPath: string;
    content: Uint8Array;
    documentMapper: (bytes: Bytes) => object;
}): Promise<"written" | "exists">;
export type FoldResult = {
    status: "ok";
    snapshot: Uint8Array;
    byteLength: number;
    kind: "ok" | "warn";
} | {
    status: "abort";
    byteLength: number;
} | {
    status: "empty";
};
export declare function foldUpdates(opts: {
    db: Firestore;
    documentPath: string;
    listed: ListedUpdate[];
    localUpdate: Uint8Array;
    documentMapper: (bytes: Bytes) => object;
    maxContentBytes: number;
    force?: boolean;
}): Promise<FoldResult>;
//# sourceMappingURL=append-store.d.ts.map