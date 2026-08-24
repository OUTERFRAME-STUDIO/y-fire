var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { addDoc, Bytes, collection, doc, getDocs, runTransaction, serverTimestamp, } from "@firebase/firestore";
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
export function updatesCollectionPath(documentPath) {
    return `${documentPath}/${UPDATES_SUBCOLLECTION}`;
}
export function isAlreadyExistsError(error) {
    if (!error || typeof error !== "object")
        return false;
    const code = error.code;
    return code === "already-exists" || code === "firestore/already-exists";
}
function errorMessage(error) {
    if (typeof error === "string")
        return error;
    if (error instanceof Error)
        return error.message;
    if (error &&
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string") {
        return error.message;
    }
    return "";
}
export function updateIdFromAlreadyExistsError(error) {
    const message = errorMessage(error).trimEnd();
    const marker = `/${UPDATES_SUBCOLLECTION}/`;
    const idx = message.lastIndexOf(marker);
    if (idx < 0)
        return undefined;
    const rest = message.slice(idx + marker.length);
    const id = rest.split(/[/\s]/)[0];
    return id || undefined;
}
export function readBytes(value) {
    if (!value || typeof value.toUint8Array !== "function") {
        return undefined;
    }
    const bytes = value.toUint8Array();
    return bytes && bytes.byteLength > 0 ? bytes : undefined;
}
export function readSnapshotMeta(data, epochField = DEFAULT_EPOCH_FIELD) {
    const epochValue = data === null || data === void 0 ? void 0 : data[epochField];
    const snapshotBackend = data === null || data === void 0 ? void 0 : data[SNAPSHOT_BACKEND_FIELD];
    const contentStoragePath = data === null || data === void 0 ? void 0 : data[CONTENT_STORAGE_PATH_FIELD];
    const contentStorageGeneration = data === null || data === void 0 ? void 0 : data[CONTENT_STORAGE_GENERATION_FIELD];
    const contentGzipBytes = data === null || data === void 0 ? void 0 : data[CONTENT_GZIP_BYTES_FIELD];
    const contentRawBytes = data === null || data === void 0 ? void 0 : data[CONTENT_RAW_BYTES_FIELD];
    return {
        content: readBytes(data === null || data === void 0 ? void 0 : data.content),
        snapshotSV: readBytes(data === null || data === void 0 ? void 0 : data[SNAPSHOT_SV_FIELD]),
        epoch: typeof epochValue === "number" ? epochValue : 0,
        snapshotBackend: typeof snapshotBackend === "string" ? snapshotBackend : undefined,
        contentStoragePath: typeof contentStoragePath === "string" ? contentStoragePath : undefined,
        contentStorageGeneration: typeof contentStorageGeneration === "string"
            ? contentStorageGeneration
            : undefined,
        contentGzipBytes: typeof contentGzipBytes === "number" ? contentGzipBytes : undefined,
        contentRawBytes: typeof contentRawBytes === "number" ? contentRawBytes : undefined,
    };
}
export function snapshotMetaFromFields(meta) {
    if (!meta.contentStoragePath)
        return undefined;
    return {
        path: meta.contentStoragePath,
        generation: meta.contentStorageGeneration,
        gzipBytes: meta.contentGzipBytes,
        rawBytes: meta.contentRawBytes,
    };
}
function hasExistingSnapshot(data) {
    if (readBytes(data === null || data === void 0 ? void 0 : data.content))
        return true;
    const path = data === null || data === void 0 ? void 0 : data[CONTENT_STORAGE_PATH_FIELD];
    return typeof path === "string" && path.length > 0;
}
export function snapshotStoreDocFields(meta) {
    const fields = {
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
export function unionYjsBytes(parts) {
    const merged = new Y.Doc();
    try {
        for (const part of parts) {
            if (part && part.byteLength > 0)
                Y.applyUpdate(merged, part);
        }
        return Y.encodeStateAsUpdate(merged);
    }
    finally {
        merged.destroy();
    }
}
export function appendUpdate(db, documentPath, payload) {
    return __awaiter(this, void 0, void 0, function* () {
        const col = collection(db, updatesCollectionPath(documentPath));
        return addDoc(col, Object.assign(Object.assign({ update: Bytes.fromUint8Array(payload.update), seq: payload.seq }, (payload.clientId ? { clientId: payload.clientId } : {})), { createdAt: serverTimestamp() }));
    });
}
export function listUpdates(db, documentPath) {
    return __awaiter(this, void 0, void 0, function* () {
        const col = collection(db, updatesCollectionPath(documentPath));
        const snap = yield getDocs(col);
        const out = [];
        snap.forEach((d) => {
            const data = (typeof d.data === "function" ? d.data() : undefined);
            const update = readBytes(data === null || data === void 0 ? void 0 : data.update);
            if (!update)
                return;
            out.push({
                id: d.id,
                update,
                seq: typeof (data === null || data === void 0 ? void 0 : data.seq) === "number" ? data.seq : 0,
                clientId: typeof (data === null || data === void 0 ? void 0 : data.clientId) === "string" ? data.clientId : undefined,
            });
        });
        return out;
    });
}
export function writeSnapshot(opts) {
    return __awaiter(this, void 0, void 0, function* () {
        const ref = doc(opts.db, opts.documentPath);
        let outcome = "written";
        let stored;
        if (opts.snapshotStore) {
            // Peek first. Writing the store before this check clobbers an
            // Admin-packed blob when hasRemoteContent is still false (empty
            // first-write after a missing-path hydrate).
            let alreadyExists = false;
            yield runTransaction(opts.db, (tx) => __awaiter(this, void 0, void 0, function* () {
                const snap = yield tx.get(ref);
                alreadyExists = hasExistingSnapshot(snap.data());
            }));
            if (alreadyExists)
                return "exists";
            stored = yield opts.snapshotStore.write(opts.content);
        }
        yield runTransaction(opts.db, (tx) => __awaiter(this, void 0, void 0, function* () {
            const snap = yield tx.get(ref);
            const data = snap.data();
            if (hasExistingSnapshot(data)) {
                outcome = "exists";
                return;
            }
            if (opts.snapshotStore && stored) {
                tx.set(ref, Object.assign(Object.assign({}, snapshotStoreDocFields(stored)), { [SNAPSHOT_SV_FIELD]: Bytes.fromUint8Array(Y.encodeStateVectorFromUpdate(opts.content)), updatedAt: serverTimestamp() }), { merge: true });
                return;
            }
            tx.set(ref, Object.assign(Object.assign({}, opts.documentMapper(Bytes.fromUint8Array(opts.content))), { [SNAPSHOT_SV_FIELD]: Bytes.fromUint8Array(Y.encodeStateVectorFromUpdate(opts.content)), updatedAt: serverTimestamp() }), { merge: true });
        }));
        return outcome;
    });
}
export function foldUpdates(opts) {
    return __awaiter(this, void 0, void 0, function* () {
        if (opts.listed.length === 0 && !opts.force)
            return { status: "empty" };
        const ref = doc(opts.db, opts.documentPath);
        if (opts.snapshotStore) {
            return foldUpdatesWithStore(opts, ref, opts.snapshotStore);
        }
        let result = { status: "empty" };
        yield runTransaction(opts.db, (tx) => __awaiter(this, void 0, void 0, function* () {
            var _a;
            const snap = yield tx.get(ref);
            const remote = readBytes((_a = snap.data()) === null || _a === void 0 ? void 0 : _a.content);
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
            tx.set(ref, Object.assign(Object.assign({}, opts.documentMapper(Bytes.fromUint8Array(snapshot))), { [SNAPSHOT_SV_FIELD]: Bytes.fromUint8Array(Y.encodeStateVectorFromUpdate(snapshot)), updatedAt: serverTimestamp() }), { merge: true });
            for (const update of opts.listed) {
                tx.delete(doc(opts.db, `${updatesCollectionPath(opts.documentPath)}/${update.id}`));
            }
            result = {
                status: "ok",
                snapshot,
                byteLength: snapshot.byteLength,
                kind,
            };
        }));
        return result;
    });
}
function foldUpdatesWithStore(opts, ref, snapshotStore) {
    return __awaiter(this, void 0, void 0, function* () {
        let remoteMeta = readSnapshotMeta(undefined);
        yield runTransaction(opts.db, (tx) => __awaiter(this, void 0, void 0, function* () {
            const snap = yield tx.get(ref);
            remoteMeta = readSnapshotMeta(snap.data());
        }));
        let remote;
        const storedMeta = snapshotMetaFromFields(remoteMeta);
        if (storedMeta) {
            remote = yield snapshotStore.read(storedMeta);
        }
        const snapshot = unionYjsBytes([
            remote,
            ...opts.listed.map((u) => u.update),
            opts.localUpdate,
        ]);
        const written = yield snapshotStore.write(snapshot);
        let result = { status: "empty" };
        yield runTransaction(opts.db, (tx) => __awaiter(this, void 0, void 0, function* () {
            tx.set(ref, Object.assign(Object.assign({}, snapshotStoreDocFields(written)), { [SNAPSHOT_SV_FIELD]: Bytes.fromUint8Array(Y.encodeStateVectorFromUpdate(snapshot)), updatedAt: serverTimestamp() }), { merge: true });
            for (const update of opts.listed) {
                tx.delete(doc(opts.db, `${updatesCollectionPath(opts.documentPath)}/${update.id}`));
            }
            result = {
                status: "ok",
                snapshot,
                byteLength: snapshot.byteLength,
                kind: "ok",
            };
        }));
        return result;
    });
}
