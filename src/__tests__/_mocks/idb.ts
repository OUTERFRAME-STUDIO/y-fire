import { vi } from "vitest";

const store = new Map<string, Uint8Array>();

export const idbStore = store;

export const get = vi.fn(async (key: string) => store.get(key));

export const set = vi.fn(async (key: string, value: Uint8Array) => {
  store.set(key, value);
});

export const del = vi.fn(async (key: string) => {
  store.delete(key);
});

export function resetIdbMock() {
  store.clear();
  get.mockClear();
  set.mockClear();
  del.mockClear();
}

export function getIdbDeleteCount() {
  return del.mock.calls.length;
}
