import {
  addDoc,
  Bytes,
  collection,
  doc,
  Firestore,
  getDocs,
  runTransaction,
  serverTimestamp,
} from "@firebase/firestore";
import * as Y from "yjs";
import { contentSizeKind } from "./firestore-limits";

export const UPDATES_SUBCOLLECTION = "updates";
export const DEFAULT_EPOCH_FIELD = "contentGeneration";
export const SNAPSHOT_SV_FIELD = "snapshotSV";
export const SNAPSHOT_BACKEND_FIELD = "snapshotBackend";
export const CONTENT_STORAGE_PATH_FIELD = "contentStoragePath";
export const CONTENT_STORAGE_GENERATION_FIELD = "contentStorageGeneration";
export const CONTENT_GZIP_BYTES_FIELD = "contentGzipBytes";
export const CONTENT_RAW_BYTES_FIELD = "contentRawBytes";
export const SNAPSHOT_BACKEND_STORAGE = "storage";
export const DEFAULT_FOLD_UPDATE_THRESHOLD = 20;
export const DEFAULT_FOLD_BYTES_FRACTION = 0.5;

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
   * conventional object for `epoch` (packed `canvas-bodies`
   * `{contentGeneration}.yjs.gz`, then epoch 0). `null` means absent —
   * first write. Must not throw for a missing object.
   */
  readDefault?(opts?: {
    epoch?: number | null;
  }): Promise<{ bytes: Uint8Array; meta: SnapshotMeta } | null>;
};

export type WriteSnapshotResult = {
  outcome: "written" | "exists";
  snapshotSV?: Uint8Array;
  contentStoragePath?: string;
};

export function updatesCollectionPath(documentPath: string): string {
  return `${documentPath}/${UPDATES_SUBCOLLECTION}`;
}

export function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "already-exists" || code === "firestore/already-exists";
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return "";
}

export function updateIdFromAlreadyExistsError(
  error: unknown,
): string | undefined {
  const message = errorMessage(error).trimEnd();
  const marker = `/${UPDATES_SUBCOLLECTION}/`;
  const idx = message.lastIndexOf(marker);
  if (idx < 0) return undefined;
  const rest = message.slice(idx + marker.length);
  const id = rest.split(/[/\s]/)[0];
  return id || undefined;
}

export function readBytes(value: unknown): Uint8Array | undefined {
  if (!value || typeof (value as { toUint8Array?: unknown }).toUint8Array !== "function") {
    return undefined;
  }
  const bytes = (value as { toUint8Array: () => Uint8Array }).toUint8Array();
  return bytes && bytes.byteLength > 0 ? bytes : undefined;
}

export function readSnapshotMeta(
  data: Record<string, unknown> | undefined,
  epochField: string = DEFAULT_EPOCH_FIELD,
): {
  content?: Uint8Array;
  snapshotSV?: Uint8Array;
  epoch: number;
  snapshotBackend?: string;
  contentStoragePath?: string;
  contentStorageGeneration?: string;
  contentGzipBytes?: number;
  contentRawBytes?: number;
} {
  const epochValue = data?.[epochField];
  const snapshotBackend = data?.[SNAPSHOT_BACKEND_FIELD];
  const contentStoragePath = data?.[CONTENT_STORAGE_PATH_FIELD];
  const contentStorageGeneration = data?.[CONTENT_STORAGE_GENERATION_FIELD];
  const contentGzipBytes = data?.[CONTENT_GZIP_BYTES_FIELD];
  const contentRawBytes = data?.[CONTENT_RAW_BYTES_FIELD];
  return {
    content: readBytes(data?.content),
    snapshotSV: readBytes(data?.[SNAPSHOT_SV_FIELD]),
    epoch: typeof epochValue === "number" ? epochValue : 0,
    snapshotBackend:
      typeof snapshotBackend === "string" ? snapshotBackend : undefined,
    contentStoragePath:
      typeof contentStoragePath === "string" ? contentStoragePath : undefined,
    contentStorageGeneration:
      typeof contentStorageGeneration === "string"
        ? contentStorageGeneration
        : undefined,
    contentGzipBytes:
      typeof contentGzipBytes === "number" ? contentGzipBytes : undefined,
    contentRawBytes:
      typeof contentRawBytes === "number" ? contentRawBytes : undefined,
  };
}

export function snapshotMetaFromFields(meta: {
  contentStoragePath?: string;
  contentStorageGeneration?: string;
  contentGzipBytes?: number;
  contentRawBytes?: number;
}): SnapshotMeta | undefined {
  if (!meta.contentStoragePath) return undefined;
  return {
    path: meta.contentStoragePath,
    generation: meta.contentStorageGeneration,
    gzipBytes: meta.contentGzipBytes,
    rawBytes: meta.contentRawBytes,
  };
}

function hasExistingSnapshot(
  data: Record<string, unknown> | undefined,
): boolean {
  if (readBytes(data?.content)) return true;
  const path = data?.[CONTENT_STORAGE_PATH_FIELD];
  return typeof path === "string" && path.length > 0;
}

export function snapshotStoreDocFields(meta: SnapshotMeta): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    [SNAPSHOT_BACKEND_FIELD]: SNAPSHOT_BACKEND_STORAGE,
    [CONTENT_STORAGE_PATH_FIELD]: meta.path,
  };
  if (meta.generation !== undefined) {
    fields[CONTENT_STORAGE_GENERATION_FIELD] = meta.generation;
  }
  if (meta.gzipBytes !== undefined) {
    fields[CONTENT_GZIP_BYTES_FIELD] = meta.gzipBytes;
  }
  if (meta.rawBytes !== undefined) {
    fields[CONTENT_RAW_BYTES_FIELD] = meta.rawBytes;
  }
  return fields;
}

export type ListedUpdate = {
  id: string;
  update: Uint8Array;
  seq: number;
  clientId?: string;
};

export function unionYjsBytes(
  parts: Array<Uint8Array | undefined | null>,
): Uint8Array {
  const merged = new Y.Doc();
  try {
    for (const part of parts) {
      if (part && part.byteLength > 0) Y.applyUpdate(merged, part);
    }
    return Y.encodeStateAsUpdate(merged);
  } finally {
    merged.destroy();
  }
}

export async function appendUpdate(
  db: Firestore,
  documentPath: string,
  payload: { update: Uint8Array; seq: number; clientId?: string },
) {
  const col = collection(db, updatesCollectionPath(documentPath));
  return addDoc(col, {
    update: Bytes.fromUint8Array(payload.update),
    seq: payload.seq,
    ...(payload.clientId ? { clientId: payload.clientId } : {}),
    createdAt: serverTimestamp(),
  });
}

export async function listUpdates(
  db: Firestore,
  documentPath: string,
): Promise<ListedUpdate[]> {
  const col = collection(db, updatesCollectionPath(documentPath));
  const snap = await getDocs(col);
  const out: ListedUpdate[] = [];
  snap.forEach((d: { id: string; data?: () => unknown }) => {
    const data = (typeof d.data === "function" ? d.data() : undefined) as
      | Record<string, unknown>
      | undefined;
    const update = readBytes(data?.update);
    if (!update) return;
    out.push({
      id: d.id,
      update,
      seq: typeof data?.seq === "number" ? data.seq : 0,
      clientId: typeof data?.clientId === "string" ? data.clientId : undefined,
    });
  });
  return out;
}

function snapshotSvFromShardData(
  data: Record<string, unknown> | undefined,
): Uint8Array | undefined {
  return readBytes(data?.[SNAPSHOT_SV_FIELD]);
}

function storagePathFromShardData(
  data: Record<string, unknown> | undefined,
): string | undefined {
  const path = data?.[CONTENT_STORAGE_PATH_FIELD];
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

/**
 * Repair a missing Storage pointer after a successful `readDefault`.
 * Merge-only; no-ops when the shard already has a path or `content`.
 */
export async function stampSnapshotMeta(opts: {
  db: Firestore;
  documentPath: string;
  meta: SnapshotMeta;
  snapshotSV?: Uint8Array;
}): Promise<void> {
  const ref = doc(opts.db, opts.documentPath);
  await runTransaction(opts.db, async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() as Record<string, unknown> | undefined;
    if (hasExistingSnapshot(data)) return;
    tx.set(
      ref,
      {
        ...snapshotStoreDocFields(opts.meta),
        ...(opts.snapshotSV
          ? { [SNAPSHOT_SV_FIELD]: Bytes.fromUint8Array(opts.snapshotSV) }
          : {}),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  });
}

export async function writeSnapshot(opts: {
  db: Firestore;
  documentPath: string;
  content: Uint8Array;
  documentMapper: (bytes: Bytes) => object;
  snapshotStore?: SnapshotStore;
}): Promise<WriteSnapshotResult> {
  const ref = doc(opts.db, opts.documentPath);
  let outcome: "written" | "exists" = "written";
  let stored: SnapshotMeta | undefined;
  let existingSv: Uint8Array | undefined;
  let existingPath: string | undefined;
  if (opts.snapshotStore) {
    // Peek first. Writing the store before this check clobbers an
    // Admin-packed blob when hasRemoteContent is still false (empty
    // first-write after a missing-path hydrate).
    let alreadyExists = false;
    await runTransaction(opts.db, async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data() as Record<string, unknown> | undefined;
      alreadyExists = hasExistingSnapshot(data);
      if (alreadyExists) {
        existingSv = snapshotSvFromShardData(data);
        existingPath = storagePathFromShardData(data);
      }
    });
    if (alreadyExists) {
      return {
        outcome: "exists",
        snapshotSV: existingSv,
        contentStoragePath: existingPath,
      };
    }
    stored = await opts.snapshotStore.write(opts.content);
  }
  await runTransaction(opts.db, async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() as Record<string, unknown> | undefined;
    if (hasExistingSnapshot(data)) {
      outcome = "exists";
      existingSv = snapshotSvFromShardData(data);
      existingPath = storagePathFromShardData(data);
      return;
    }
    if (opts.snapshotStore && stored) {
      tx.set(
        ref,
        {
          ...snapshotStoreDocFields(stored),
          [SNAPSHOT_SV_FIELD]: Bytes.fromUint8Array(
            Y.encodeStateVectorFromUpdate(opts.content),
          ),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      return;
    }
    tx.set(
      ref,
      {
        ...opts.documentMapper(Bytes.fromUint8Array(opts.content)),
        [SNAPSHOT_SV_FIELD]: Bytes.fromUint8Array(
          Y.encodeStateVectorFromUpdate(opts.content),
        ),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  });
  return { outcome, snapshotSV: existingSv, contentStoragePath: existingPath };
}

export type FoldResult =
  | { status: "ok"; snapshot: Uint8Array; byteLength: number; kind: "ok" | "warn" }
  | { status: "abort"; byteLength: number }
  | { status: "empty" };

export async function foldUpdates(opts: {
  db: Firestore;
  documentPath: string;
  listed: ListedUpdate[];
  localUpdate: Uint8Array;
  documentMapper: (bytes: Bytes) => object;
  maxContentBytes: number;
  force?: boolean;
  snapshotStore?: SnapshotStore;
}): Promise<FoldResult> {
  if (opts.listed.length === 0 && !opts.force) return { status: "empty" };
  const ref = doc(opts.db, opts.documentPath);
  if (opts.snapshotStore) {
    return foldUpdatesWithStore(opts, ref, opts.snapshotStore);
  }
  let result: FoldResult = { status: "empty" };
  await runTransaction(opts.db, async (tx) => {
    const snap = await tx.get(ref);
    const remote = readBytes(snap.data()?.content);
    const snapshot = unionYjsBytes([
      remote,
      ...opts.listed.map((u) => u.update),
      opts.localUpdate,
    ]);
    const kind = contentSizeKind(snapshot.byteLength, opts.maxContentBytes);
    if (kind === "abort") {
      result = { status: "abort", byteLength: snapshot.byteLength };
      return;
    }
    tx.set(
      ref,
      {
        ...opts.documentMapper(Bytes.fromUint8Array(snapshot)),
        [SNAPSHOT_SV_FIELD]: Bytes.fromUint8Array(
          Y.encodeStateVectorFromUpdate(snapshot),
        ),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    for (const update of opts.listed) {
      tx.delete(
        doc(
          opts.db,
          `${updatesCollectionPath(opts.documentPath)}/${update.id}`,
        ),
      );
    }
    result = {
      status: "ok",
      snapshot,
      byteLength: snapshot.byteLength,
      kind,
    };
  });
  return result;
}

async function foldUpdatesWithStore(
  opts: {
    db: Firestore;
    documentPath: string;
    listed: ListedUpdate[];
    localUpdate: Uint8Array;
  },
  ref: ReturnType<typeof doc>,
  snapshotStore: SnapshotStore,
): Promise<FoldResult> {
  let remoteMeta = readSnapshotMeta(undefined);
  await runTransaction(opts.db, async (tx) => {
    const snap = await tx.get(ref);
    remoteMeta = readSnapshotMeta(
      snap.data() as Record<string, unknown> | undefined,
    );
  });
  let remote: Uint8Array | undefined;
  const storedMeta = snapshotMetaFromFields(remoteMeta);
  if (storedMeta) {
    remote = await snapshotStore.read(storedMeta);
  }
  const snapshot = unionYjsBytes([
    remote,
    ...opts.listed.map((u) => u.update),
    opts.localUpdate,
  ]);
  const written = await snapshotStore.write(snapshot);
  let result: FoldResult = { status: "empty" };
  await runTransaction(opts.db, async (tx) => {
    tx.set(
      ref,
      {
        ...snapshotStoreDocFields(written),
        [SNAPSHOT_SV_FIELD]: Bytes.fromUint8Array(
          Y.encodeStateVectorFromUpdate(snapshot),
        ),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    for (const update of opts.listed) {
      tx.delete(
        doc(
          opts.db,
          `${updatesCollectionPath(opts.documentPath)}/${update.id}`,
        ),
      );
    }
    result = {
      status: "ok",
      snapshot,
      byteLength: snapshot.byteLength,
      kind: "ok",
    };
  });
  return result;
}
