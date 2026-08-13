import { vi } from "vitest";

export type MockRef = { path: string };

export type MockSnapshot = {
  exists: () => boolean;
  data: () => unknown;
  metadata?: { fromCache: boolean; hasPendingWrites: boolean };
  forEach?: (fn: (d: { id: string }) => void) => void;
};

export const setDocCalls: Array<{
  ref: MockRef;
  data: unknown;
  options?: unknown;
}> = [];

export let setDocImpl: () => Promise<void> = async () => {};

export function setSetDocImpl(impl: () => Promise<void>) {
  setDocImpl = impl;
}

/** In-memory Firestore docs used by `runTransaction`. */
export const firestoreDocs = new Map<string, Record<string, unknown>>();

export let transactionShouldFail: unknown = null;

export function setTransactionError(error: unknown | null) {
  transactionShouldFail = error;
}

export let onSnapshotCallCount = 0;

export const snapshotSubscriptions = new Map<
  string,
  { onNext: (doc: unknown) => void; onError: (error: { code: string }) => void }
>();

export function resetFirestoreMock() {
  setDocCalls.length = 0;
  setDocImpl = async () => {};
  transactionShouldFail = null;
  firestoreDocs.clear();
  onSnapshotCallCount = 0;
  snapshotSubscriptions.clear();
  doc.mockClear();
  collection.mockClear();
  onSnapshot.mockClear();
  setDoc.mockClear();
  runTransaction.mockClear();
  getFirestore.mockClear();
}

export function seedFirestoreContent(path: string, content: Uint8Array) {
  firestoreDocs.set(path, {
    content: {
      toUint8Array: () => content,
    },
  });
}

export function emitSnapshot(path: string, snapshot: MockSnapshot) {
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
    arg2:
      | ((doc: unknown) => void)
      | { includeMetadataChanges?: boolean },
    arg3?: ((doc: unknown) => void) | ((error: { code: string }) => void),
    arg4?: (error: { code: string }) => void,
  ) => {
    onSnapshotCallCount++;
    const onNext =
      typeof arg2 === "function"
        ? arg2
        : (arg3 as (doc: unknown) => void);
    const onError =
      typeof arg2 === "function"
        ? (arg3 as (error: { code: string }) => void)
        : arg4!;
    snapshotSubscriptions.set(ref.path, { onNext, onError });
    return () => {
      snapshotSubscriptions.delete(ref.path);
    };
  },
);

export const setDoc = vi.fn(async (ref: MockRef, data: unknown, options?: unknown) => {
  setDocCalls.push({ ref, data, options });
  const existing = firestoreDocs.get(ref.path) ?? {};
  const incoming = (data ?? {}) as Record<string, unknown>;
  firestoreDocs.set(
    ref.path,
    options && typeof options === "object" && (options as { merge?: boolean }).merge
      ? { ...existing, ...incoming }
      : incoming,
  );
  await setDocImpl();
});

type Transaction = {
  get: (ref: MockRef) => Promise<MockSnapshot>;
  set: (ref: MockRef, data: unknown, options?: { merge?: boolean }) => void;
};

export const runTransaction = vi.fn(
  async (_db: unknown, updateFn: (tx: Transaction) => Promise<unknown>) => {
    if (transactionShouldFail) {
      throw transactionShouldFail;
    }
    const tx: Transaction = {
      get: async (ref) => {
        const data = firestoreDocs.get(ref.path);
        return {
          exists: () => data !== undefined,
          data: () => data,
          metadata: { fromCache: false, hasPendingWrites: false },
        };
      },
      set: (ref, data, options) => {
        setDocCalls.push({ ref, data, options });
        const existing = firestoreDocs.get(ref.path) ?? {};
        const incoming = (data ?? {}) as Record<string, unknown>;
        firestoreDocs.set(
          ref.path,
          options?.merge ? { ...existing, ...incoming } : incoming,
        );
      },
    };
    return updateFn(tx);
  },
);

export const Bytes = {
  fromUint8Array: (arr: Uint8Array) => ({
    toUint8Array: () => arr,
  }),
};

export const getFirestore = vi.fn(() => ({}));
