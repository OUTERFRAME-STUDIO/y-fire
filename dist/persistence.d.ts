export type PersistenceMode = "indexeddb" | "none";
export interface PersistenceAdapter {
    getLocal(key: string): Promise<Uint8Array | undefined>;
    setLocal(key: string, value: Uint8Array): Promise<void>;
    deleteLocal(key: string): Promise<void>;
}
export declare const idbKeyvalAdapter: PersistenceAdapter;
export declare const noopAdapter: PersistenceAdapter;
export declare function createPersistenceAdapter(mode?: PersistenceMode): PersistenceAdapter;
//# sourceMappingURL=persistence.d.ts.map