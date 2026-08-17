import { vi } from "vitest";

export type MockRef = { path: string };

export type MockSnapshot = {
  exists: () => boolean;
  data: () => unknown;
  metadata?: { fromCache: boolean; hasPendingWrites: boolean };
  forEach?: (fn: (d: { id: string; data?: () => unknown }) => void) => void;
  docs?: Array<{
    id: string;
    exists: () => boolean;
    data: () => unknown;
    metadata?: { fromCache: boolean; hasPendingWrites: boolean };
  }>;
  empty?: boolean;
  size?: number;
  docChanges?: () => unknown[];
};

export const setDocCalls: Array<{
  ref: MockRef;
  data: unknown;
  options?: unknown;
}> = [];

export const addDocCalls: Array<{
  ref: MockRef;
  data: unknown;
  id: string;
}> = [];

export const deleteDocCalls: Array<{ ref: MockRef }> = [];

export let setDocImpl: () => Promise<void> = async () => {};

export function setSetDocImpl(impl: () => Promise<void>) {
  setDocImpl = impl;
}

/** In-memory Firestore docs used by `runTransaction` / `setDoc`. */
export const firestoreDocs = new Map<string, Record<string, unknown>>();

/** In-memory collections: path → (id → data). */
export const firestoreCollections = new Map<
  string,
  Map<string, Record<string, unknown>>
>();

export let transactionShouldFail: unknown = null;

export function setTransactionError(error: unknown | null) {
  transactionShouldFail = error;
}

export let addDocShouldFail: unknown = null;

export function setAddDocError(error: unknown | null) {
  addDocShouldFail = error;
}

export let onSnapshotCallCount = 0;

export const snapshotSubscriptions = new Map<
  string,
  { onNext: (doc: unknown) => void; onError: (error: { code: string }) => void }
>();

let autoIdCounter = 0;

export function resetFirestoreMock() {
  setDocCalls.length = 0;
  addDocCalls.length = 0;
  deleteDocCalls.length = 0;
  setDocImpl = async () => {};
  transactionShouldFail = null;
  addDocShouldFail = null;
  firestoreDocs.clear();
  firestoreCollections.clear();
  onSnapshotCallCount = 0;
  autoIdCounter = 0;
  snapshotSubscriptions.clear();
  doc.mockClear();
  collection.mockClear();
  onSnapshot.mockClear();
  setDoc.mockClear();
  addDoc.mockClear();
  getDocs.mockClear();
  deleteDoc.mockClear();
  query.mockClear();
  orderBy.mockClear();
  serverTimestamp.mockClear();
  runTransaction.mockClear();
  getFirestore.mockClear();
}

export function updatesPath(documentPath: string) {
  return `${documentPath}/updates`;
}

function getOrCreateCollection(path: string) {
  let col = firestoreCollections.get(path);
  if (!col) {
    col = new Map();
    firestoreCollections.set(path, col);
  }
  return col;
}

function splitDocPath(path: string): { col: string; id: string } {
  const i = path.lastIndexOf("/");
  return { col: path.slice(0, i), id: path.slice(i + 1) };
}

function wrapBytes(content: Uint8Array) {
  return { toUint8Array: () => content };
}

/** Mirrors Firestore: undefined field values are rejected. */
export function assertNoUndefinedFields(
  value: unknown,
  fieldPath = "",
): void {
  if (value === undefined) {
    throw new Error(
      `Unsupported field value: undefined (found in field ${fieldPath || "(root)"})`,
    );
  }
  if (value === null || typeof value !== "object") return;
  if (typeof (value as { toUint8Array?: unknown }).toUint8Array === "function") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      assertNoUndefinedFields(item, fieldPath ? `${fieldPath}[${i}]` : `[${i}]`);
    });
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const next = fieldPath ? `${fieldPath}.${key}` : key;
    if (nested === undefined) {
      throw new Error(
        `Unsupported field value: undefined (found in field ${next})`,
      );
    }
    assertNoUndefinedFields(nested, next);
  }
}

export function seedFirestoreContent(path: string, content: Uint8Array) {
  const existing = firestoreDocs.get(path) ?? {};
  firestoreDocs.set(path, {
    ...existing,
    content: wrapBytes(content),
  });
}

export function seedFirestoreShard(
  path: string,
  content: Uint8Array,
  extra?: {
    epoch?: number;
    snapshotSV?: Uint8Array;
  },
) {
  const data: Record<string, unknown> = {
    content: wrapBytes(content),
  };
  if (extra?.epoch !== undefined) {
    data.contentGeneration = extra.epoch;
  }
  if (extra?.snapshotSV) {
    data.snapshotSV = wrapBytes(extra.snapshotSV);
  }
  firestoreDocs.set(path, data);
}

export function seedFirestoreUpdate(
  documentPath: string,
  id: string,
  update: Uint8Array,
  extra?: { seq?: number; clientId?: string },
) {
  const col = getOrCreateCollection(updatesPath(documentPath));
  col.set(id, {
    update: wrapBytes(update),
    seq: extra?.seq ?? 0,
    clientId: extra?.clientId ?? "peer",
    createdAt: { seconds: 0 },
  });
}

export function makeQuerySnapshot(
  docs: Map<string, Record<string, unknown>>,
  metadata: { fromCache: boolean; hasPendingWrites: boolean } = {
    fromCache: false,
    hasPendingWrites: false,
  },
): MockSnapshot {
  const list = [...docs.entries()].map(([id, data]) => ({
    id,
    exists: () => true,
    data: () => data,
    metadata,
  }));
  return {
    exists: () => true,
    data: () => undefined,
    metadata,
    empty: list.length === 0,
    size: list.length,
    docs: list,
    forEach: (fn) => {
      list.forEach((d) => fn(d));
    },
    docChanges: () =>
      list.map((d, i) => ({
        type: "added" as const,
        doc: d,
        oldIndex: -1,
        newIndex: i,
      })),
  };
}

function notifyCollection(path: string) {
  const sub = snapshotSubscriptions.get(path);
  if (!sub) return;
  const col = firestoreCollections.get(path) ?? new Map();
  sub.onNext(
    makeQuerySnapshot(col, { fromCache: false, hasPendingWrites: false }),
  );
}

export function emitSnapshot(path: string, snapshot: MockSnapshot) {
  const sub = snapshotSubscriptions.get(path);
  if (sub) sub.onNext(snapshot);
}

export function emitUpdatesSnapshot(
  documentPath: string,
  metadata: { fromCache: boolean; hasPendingWrites: boolean } = {
    fromCache: false,
    hasPendingWrites: false,
  },
) {
  const colPath = updatesPath(documentPath);
  const col = firestoreCollections.get(colPath) ?? new Map();
  emitSnapshot(colPath, makeQuerySnapshot(col, metadata));
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
      typeof arg2 === "function" ? arg2 : (arg3 as (doc: unknown) => void);
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
  assertNoUndefinedFields(data);
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

export const addDoc = vi.fn(async (ref: MockRef, data: unknown) => {
  if (addDocShouldFail) {
    throw addDocShouldFail;
  }
  assertNoUndefinedFields(data);
  const id = `auto_${++autoIdCounter}`;
  const col = getOrCreateCollection(ref.path);
  col.set(id, (data ?? {}) as Record<string, unknown>);
  addDocCalls.push({ ref, data, id });
  notifyCollection(ref.path);
  return { id, path: `${ref.path}/${id}` };
});

export const getDocs = vi.fn(async (ref: MockRef) => {
  const col = firestoreCollections.get(ref.path) ?? new Map();
  return makeQuerySnapshot(col);
});

export const deleteDoc = vi.fn(async (ref: MockRef) => {
  deleteDocCalls.push({ ref });
  firestoreDocs.delete(ref.path);
  const { col, id } = splitDocPath(ref.path);
  firestoreCollections.get(col)?.delete(id);
  notifyCollection(col);
});

export const query = vi.fn((ref: MockRef, ..._constraints: unknown[]) => ref);

export const orderBy = vi.fn((field: string, direction?: string) => ({
  type: "orderBy",
  field,
  direction,
}));

export const serverTimestamp = vi.fn(() => ({ __serverTimestamp: true }));

type Transaction = {
  get: (ref: MockRef) => Promise<MockSnapshot>;
  set: (ref: MockRef, data: unknown, options?: { merge?: boolean }) => void;
  delete: (ref: MockRef) => void;
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
        assertNoUndefinedFields(data);
        setDocCalls.push({ ref, data, options });
        const existing = firestoreDocs.get(ref.path) ?? {};
        const incoming = (data ?? {}) as Record<string, unknown>;
        firestoreDocs.set(
          ref.path,
          options?.merge ? { ...existing, ...incoming } : incoming,
        );
      },
      delete: (ref) => {
        deleteDocCalls.push({ ref });
        firestoreDocs.delete(ref.path);
        const { col, id } = splitDocPath(ref.path);
        firestoreCollections.get(col)?.delete(id);
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
