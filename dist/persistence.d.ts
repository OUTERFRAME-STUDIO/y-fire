export type PersistenceMode = "indexeddb" | "none";
export declare const PERSISTENCE_META_SUFFIX = "#meta";
export declare function persistenceMetaKey(documentPath: string): string;
export declare function encodeEpochMeta(epoch: number): Uint8Array;
export declare function decodeEpochMeta(bytes: Uint8Array | undefined): number;
export interface PersistenceAdapter {
    getLocal(key: string): Promise<Uint8Array | undefined>;
    setLocal(key: string, value: Uint8Array): Promise<void>;
    deleteLocal(key: string): Promise<void>;
}
export declare const idbKeyvalAdapter: PersistenceAdapter;
export declare const noopAdapter: PersistenceAdapter;
export declare function createPersistenceAdapter(mode?: PersistenceMode): PersistenceAdapter;
//# sourceMappingURL=persistence.d.ts.map