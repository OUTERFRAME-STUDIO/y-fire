import { get, set, del } from "idb-keyval";

export type PersistenceMode = "indexeddb" | "none";

export interface PersistenceAdapter {
  getLocal(key: string): Promise<Uint8Array | undefined>;
  setLocal(key: string, value: Uint8Array): Promise<void>;
  deleteLocal(key: string): Promise<void>;
}

export const idbKeyvalAdapter: PersistenceAdapter = {
  getLocal: (key) => get<Uint8Array>(key),
  setLocal: (key, value) => set(key, value),
  deleteLocal: (key) => del(key),
};

export const noopAdapter: PersistenceAdapter = {
  getLocal: async () => undefined,
  setLocal: async () => {},
  deleteLocal: async () => {},
};

export function createPersistenceAdapter(
  mode: PersistenceMode = "indexeddb",
): PersistenceAdapter {
  return mode === "none" ? noopAdapter : idbKeyvalAdapter;
}
