import { Bytes, Firestore } from "@firebase/firestore";
export declare const UPDATES_SUBCOLLECTION = "updates";
export declare const DEFAULT_EPOCH_FIELD = "contentGeneration";
export declare const SNAPSHOT_SV_FIELD = "snapshotSV";
export declare const SNAPSHOT_BACKEND_FIELD = "snapshotBackend";
export declare const CONTENT_STORAGE_PATH_FIELD = "contentStoragePath";
export declare const CONTENT_STORAGE_GENERATION_FIELD = "contentStorageGeneration";
export declare const CONTENT_GZIP_BYTES_FIELD = "contentGzipBytes";
export declare const CONTENT_RAW_BYTES_FIELD = "contentRawBytes";
export declare const SNAPSHOT_BACKEND_STORAGE = "storage";
export declare const DEFAULT_FOLD_UPDATE_THRESHOLD = 20;
export declare const DEFAULT_FOLD_BYTES_FRACTION = 0.5;
export type SnapshotMeta = {
    path: string;
    generation?: string;
    gzipBytes?: number;
    rawBytes?: number;
};
export type SnapshotStore = {
    /** Return inflated Yjs update bytes (Y.encodeStateAsUpdate). */
    read(meta: SnapshotMeta): Promise<Uint8Array>;
    /** Persist snapshot bytes; may gzip internally. */
    write(bytes: Uint8Array): Promise<SnapshotMeta>;
    /**
     * When the shard doc has no `contentStoragePath`, try the store's
     * conventional object (e.g. packed `canvas-bodies` epoch 0). `null`
     * means absent — first write. Must not throw for a missing object.
     */
    readDefault?(): Promise<{
        bytes: Uint8Array;
        meta: SnapshotMeta;
    } | null>;
};
export type WriteSnapshotResult = {
    outcome: "written" | "exists";
    snapshotSV?: Uint8Array;
};
export declare function updatesCollectionPath(documentPath: string): string;
export declare function isAlreadyExistsError(error: unknown): boolean;
export declare function updateIdFromAlreadyExistsError(error: unknown): string | undefined;
export declare function readBytes(value: unknown): Uint8Array | undefined;
export declare function readSnapshotMeta(data: Record<string, unknown> | undefined, epochField?: string): {
    content?: Uint8Array;
    snapshotSV?: Uint8Array;
    epoch: number;
    snapshotBackend?: string;
    contentStoragePath?: string;
    contentStorageGeneration?: string;
    contentGzipBytes?: number;
    contentRawBytes?: number;
};
export declare function snapshotMetaFromFields(meta: {
    contentStoragePath?: string;
    contentStorageGeneration?: string;
    contentGzipBytes?: number;
    contentRawBytes?: number;
}): SnapshotMeta | undefined;
export declare function snapshotStoreDocFields(meta: SnapshotMeta): Record<string, unknown>;
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
    snapshotStore?: SnapshotStore;
}): Promise<WriteSnapshotResult>;
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
    snapshotStore?: SnapshotStore;
}): Promise<FoldResult>;
//# sourceMappingURL=append-store.d.ts.map