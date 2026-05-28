import { vi } from "vitest";

export type MockRef = { path: string };

export const setDocCalls: Array<{
  ref: MockRef;
  data: unknown;
  options?: unknown;
}> = [];
export let setDocImpl: () => Promise<void> = async () => {};

export function setSetDocImpl(impl: () => Promise<void>) {
  setDocImpl = impl;
}
export let onSnapshotCallCount = 0;

export const snapshotSubscriptions = new Map<
  string,
  { onNext: (doc: unknown) => void; onError: (error: { code: string }) => void }
>();

export function resetFirestoreMock() {
  setDocCalls.length = 0;
  setDocImpl = async () => {};
  onSnapshotCallCount = 0;
  snapshotSubscriptions.clear();
  doc.mockClear();
  collection.mockClear();
  onSnapshot.mockClear();
  setDoc.mockClear();
  getFirestore.mockClear();
}

export function emitSnapshot(
  path: string,
  snapshot: { exists: () => boolean; data: () => unknown; forEach?: (fn: (d: { id: string }) => void) => void },
) {
  const sub = snapshotSubscriptions.get(path);
  if (sub) sub.onNext(snapshot);
}

export function emitSnapshotError(path: string, error: { code: string }) {
  const sub = snapshotSubscriptions.get(path);
  if (sub) sub.onError(error);
}

export const doc = vi.fn((_db: unknown, path: string): MockRef => ({ path }));

export const collection = vi.fn(
  (_db: unknown, path: string): MockRef => ({ path }),
);

export const onSnapshot = vi.fn(
  (
    ref: MockRef,
    onNext: (doc: unknown) => void,
    onError: (error: { code: string }) => void,
  ) => {
    onSnapshotCallCount++;
    snapshotSubscriptions.set(ref.path, { onNext, onError });
    return () => {
      snapshotSubscriptions.delete(ref.path);
    };
  },
);

export const setDoc = vi.fn(async (ref: MockRef, data: unknown, options?: unknown) => {
  setDocCalls.push({ ref, data, options });
  await setDocImpl();
});

export const Bytes = {
  fromUint8Array: (arr: Uint8Array) => ({
    toUint8Array: () => arr,
  }),
};

export const getFirestore = vi.fn(() => ({}));
