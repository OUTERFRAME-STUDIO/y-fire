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
export const DEFAULT_FOLD_UPDATE_THRESHOLD = 20;
export const DEFAULT_FOLD_BYTES_FRACTION = 0.5;

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
} {
  const epochValue = data?.[epochField];
  return {
    content: readBytes(data?.content),
    snapshotSV: readBytes(data?.[SNAPSHOT_SV_FIELD]),
    epoch: typeof epochValue === "number" ? epochValue : 0,
  };
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

export async function writeSnapshot(opts: {
  db: Firestore;
  documentPath: string;
  content: Uint8Array;
  documentMapper: (bytes: Bytes) => object;
}): Promise<"written" | "exists"> {
  const ref = doc(opts.db, opts.documentPath);
  let outcome: "written" | "exists" = "written";
  await runTransaction(opts.db, async (tx) => {
    const snap = await tx.get(ref);
    const existing = readBytes(snap.data()?.content);
    if (existing) {
      outcome = "exists";
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
  return outcome;
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
}): Promise<FoldResult> {
  if (opts.listed.length === 0 && !opts.force) return { status: "empty" };
  const ref = doc(opts.db, opts.documentPath);
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
