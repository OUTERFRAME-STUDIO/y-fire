var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { getFirestore, onSnapshot, doc, collection, } from "@firebase/firestore";
import * as Y from "yjs";
import { ObservableV2 } from "lib0/observable";
import * as awarenessProtocol from "y-protocols/awareness";
import { deleteInstance, initiateInstance, refreshPeers } from "./utils";
import { WebRtc } from "./webrtc";
import { createGraph } from "./graph";
import { createPersistenceAdapter, decodeEpochMeta, encodeEpochMeta, persistenceMetaKey, } from "./persistence";
import { EMPTY_YJS_UPDATE_MAX_BYTES, FIRESTORE_CONTENT_MAX_BYTES, contentSizeKind, } from "./firestore-limits";
import { appendUpdate, DEFAULT_EPOCH_FIELD, DEFAULT_FOLD_BYTES_FRACTION, DEFAULT_FOLD_UPDATE_THRESHOLD, foldUpdates, isAlreadyExistsError, listUpdates, readBytes, readSnapshotMeta, snapshotMetaFromFields, updateIdFromAlreadyExistsError, updatesCollectionPath, writeSnapshot, } from "./append-store";
import { enqueueTabFold } from "./fold-scheduler";
import { mergeStateVectors, stateVectorCovers, stateVectorFromUpdate } from "./state-vector";
/** Default budget for `appendUpdate` / first-snapshot Firestore writes. */
export const DEFAULT_SAVE_TIMEOUT_MS = 15000;
const SNAPSHOT_BACKOFF_BASE_MS = 500;
const SNAPSHOT_BACKOFF_MAX_MS = 16000;
const FOLD_BACKOFF_MS = 30000;
/** Trailing debounce for full-doc IndexedDB encodes after local updates. */
export const LOCAL_PERSIST_DEBOUNCE_MS = 500;
/**
 * FireProvider class that handles firestore data sync and awareness
 * based on webRTC.
 * @param firebaseApp Firestore instance
 * @param ydoc ydoc
 * @param path path to the firestore document (ex. collection/documentuid)
 * @param maxUpdatesThreshold maximum number of updates to wait for before sending updates to peers
 * @param maxWaitTime maximum miliseconds to wait before sending updates to peers
 * @param maxWaitFirestoreTime miliseconds to wait before syncing this client's update to firestore
 * @param maxFirestoreDeferral maximum miliseconds local re-entry can postpone a Firestore flush
 */
export class FireProvider extends ObservableV2 {
    get clientTimeOffset() {
        return this.timeOffset;
    }
    saveContext(byteLength, reason, extra) {
        return {
            documentPath: this.documentPath,
            byteLength,
            code: extra === null || extra === void 0 ? void 0 : extra.code,
            fromCache: this.lastSnapshotFromCache,
            ready: this.ready,
            serverReady: this.serverReady,
            reason,
        };
    }
    /**
     * Race a Firestore write against {@link saveTimeoutMs}. On timeout the
     * underlying promise is left running (Firestore cannot cancel `addDoc`);
     * a dangling `.then` swallows the late result so `lastPersistedSV` /
     * `lastSeq` stay with the caller that already threw.
     */
    awaitWithSaveTimeout(work) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                void work.then(() => undefined, () => undefined);
                reject(Object.assign(new Error("y-fire: Firestore save timed out"), {
                    reason: "save-timeout",
                }));
            }, this.saveTimeoutMs);
            work.then((value) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            }, (error) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            });
        });
    }
    ;
    kill(keepReadOnly = false) {
        const _super = Object.create(null, {
            destroy: { get: () => super.destroy }
        });
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.flushSaveToLocal();
            }
            catch (error) {
                this.consoleHandler("kill: local persist error", error);
            }
            if (this.serverReady && (this.firestoreTimeout || this.cache)) {
                try {
                    yield this.saveToFirestore();
                }
                catch (error) {
                    this.consoleHandler("kill: flush error", error);
                }
            }
            this.instanceConnection.destroy();
            removeEventListener("beforeunload", this.destroy);
            removeEventListener("pagehide", this.destroy);
            removeEventListener("visibilitychange", this.onVisibilityChange);
            removeEventListener("pageshow", this.onPageShow);
            if (this.recreateTimeout)
                clearTimeout(this.recreateTimeout);
            if (this.cacheTimeout)
                clearTimeout(this.cacheTimeout);
            if (this.firestoreTimeout)
                clearTimeout(this.firestoreTimeout);
            if (this.snapshotRetryTimeout)
                clearTimeout(this.snapshotRetryTimeout);
            if (this.meshRetryTimeout)
                clearTimeout(this.meshRetryTimeout);
            if (this.saveRetryTimeout)
                clearTimeout(this.saveRetryTimeout);
            if (this.localPersistTimeout)
                clearTimeout(this.localPersistTimeout);
            this.doc.off("update", this.updateHandler);
            this.awareness.off("update", this.awarenessUpdateHandler);
            deleteInstance(this.db, this.documentPath, this.uid);
            if (this.unsubscribeData && !keepReadOnly) {
                this.unsubscribeData();
                delete this.unsubscribeData;
            }
            if (this.unsubscribeMesh) {
                this.unsubscribeMesh();
                delete this.unsubscribeMesh;
            }
            if (this.peersRTC) {
                if (this.peersRTC.receivers) {
                    Object.values(this.peersRTC.receivers).forEach((receiver) => receiver.destroy());
                }
                if (this.peersRTC.senders) {
                    Object.values(this.peersRTC.senders).forEach((sender) => sender.destroy());
                }
            }
            this.ready = false;
            this.serverReady = false;
            _super.destroy.call(this);
        });
    }
    constructor({ firebaseApp, ydoc, path, docMapper, maxUpdatesThreshold, maxWaitTime, maxWaitFirestoreTime, maxFirestoreDeferral, persistence, maxContentBytes, foldUpdateThreshold, foldBytesFraction, epochField, saveTimeoutMs, snapshotStore, }) {
        super();
        this.timeOffset = 0; // offset to server time in mili seconds
        this.clients = [];
        this.peersReceivers = new Set([]);
        this.peersSenders = new Set([]);
        this.peersRTC = {
            receivers: {},
            senders: {},
        };
        this.documentMapper = (bytes) => ({ content: bytes });
        this.maxCacheUpdates = 20;
        this.cacheUpdateCount = 0;
        this.maxRTCWait = 100;
        this.maxFirestoreWait = 3000;
        this.maxFirestoreDeferral = 10000;
        this.maxContentBytes = FIRESTORE_CONTENT_MAX_BYTES;
        this.saveTimeoutMs = DEFAULT_SAVE_TIMEOUT_MS;
        this.saveInFlight = false;
        this.lastSaveDurationMs = null;
        this.saveQueued = false;
        this.firebaseDataLastUpdatedAt = new Date().getTime();
        this.instanceConnection = new ObservableV2();
        this.snapshotRetryAttempt = 0;
        this.meshRetryAttempt = 0;
        this.dataListenerPaused = false;
        this.pendingSyncLocal = false;
        this.lastSnapshotFromCache = true;
        this.hasRemoteContent = false;
        this.epochReplaced = false;
        this.appliedUpdateIds = new Set();
        this.lastSeq = 0;
        this.docServerSnapshot = false;
        this.updatesServerSnapshot = false;
        this.foldUpdateThreshold = DEFAULT_FOLD_UPDATE_THRESHOLD;
        this.foldBytesFraction = DEFAULT_FOLD_BYTES_FRACTION;
        this.epochField = DEFAULT_EPOCH_FIELD;
        this.updateDocCount = 0;
        this.updateTotalBytes = 0;
        this.listedUpdates = [];
        this.foldInFlight = false;
        this.foldQueued = false;
        this.foldAbortReported = false;
        this.updatesAccessDenied = false;
        this.updatesDeniedWarned = false;
        this.snapshotHydrateGen = 0;
        this.ready = false;
        this.serverReady = false;
        this.init = () => __awaiter(this, void 0, void 0, function* () {
            this.trackData(); // initiate this before creating instance, so that users with read permissions can also view the document
            // Attach update handler immediately so writes (and onSaving) work even when
            // initiateInstance() fails or hangs offline. this.uid stays from previous session until we get a new one.
            this.initiateHandler();
            try {
                const data = yield initiateInstance(this.db, this.documentPath);
                this.instanceConnection.on("closed", this.trackConnections);
                this.uid = data.uid;
                this.timeOffset = data.offset;
                addEventListener("beforeunload", this.destroy);
                addEventListener("pagehide", this.destroy);
                addEventListener("visibilitychange", this.onVisibilityChange);
                addEventListener("pageshow", this.onPageShow);
            }
            catch (error) {
                this.consoleHandler("Could not connect to a peer network.");
                // this.uid stays from previous session; update handler already attached above
            }
        });
        this.syncLocal = () => __awaiter(this, void 0, void 0, function* () {
            var _a;
            if (!this.serverReady) {
                this.pendingSyncLocal = true;
                return;
            }
            if (this.epochReplaced) {
                this.pendingSyncLocal = false;
                return;
            }
            this.pendingSyncLocal = false;
            try {
                const local = yield this.persistenceAdapter.getLocal(this.documentPath);
                const metaBytes = yield this.persistenceAdapter.getLocal(persistenceMetaKey(this.documentPath));
                const localEpoch = decodeEpochMeta(metaBytes);
                if (local && ((_a = this.hydratedEpoch) !== null && _a !== void 0 ? _a : 0) > localEpoch) {
                    yield this.deleteLocal();
                    return;
                }
                if (local) {
                    Y.applyUpdate(this.doc, local, { key: "local-sync" });
                    if (this.persistenceMode !== "none") {
                        this.sendToFirestoreQueue();
                    }
                }
            }
            catch (e) {
                this.consoleHandler("get local error", e);
            }
        });
        this.saveToLocal = () => __awaiter(this, void 0, void 0, function* () {
            var _b;
            try {
                const currentDoc = Y.encodeStateAsUpdate(this.doc);
                yield this.persistenceAdapter.setLocal(this.documentPath, currentDoc);
                yield this.persistenceAdapter.setLocal(persistenceMetaKey(this.documentPath), encodeEpochMeta((_b = this.hydratedEpoch) !== null && _b !== void 0 ? _b : 0));
            }
            catch (e) {
                this.consoleHandler("set local error", e);
            }
        });
        this.scheduleSaveToLocal = () => {
            if (this.persistenceMode === "none")
                return;
            if (this.localPersistTimeout)
                clearTimeout(this.localPersistTimeout);
            this.localPersistTimeout = setTimeout(() => {
                this.localPersistTimeout = undefined;
                void this.saveToLocal();
            }, LOCAL_PERSIST_DEBOUNCE_MS);
        };
        this.flushSaveToLocal = () => __awaiter(this, void 0, void 0, function* () {
            if (this.localPersistTimeout) {
                clearTimeout(this.localPersistTimeout);
                this.localPersistTimeout = undefined;
            }
            if (this.persistenceMode === "none")
                return;
            yield this.saveToLocal();
        });
        this.deleteLocal = () => __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.persistenceAdapter.deleteLocal(this.documentPath);
                yield this.persistenceAdapter.deleteLocal(persistenceMetaKey(this.documentPath));
            }
            catch (e) {
                this.consoleHandler("del local error", e);
            }
        });
        this.initiateHandler = () => {
            this.consoleHandler("FireProvider initiated!");
            this.awareness.on("update", this.awarenessUpdateHandler);
            // We will track the mesh document on Firestore to
            // keep track of selected peers
            this.trackMesh();
            this.doc.on("update", this.updateHandler);
            this.pendingSyncLocal = this.persistenceMode !== "none";
        };
        this.scheduleSnapshotRetry = () => {
            const delay = Math.min(SNAPSHOT_BACKOFF_BASE_MS * Math.pow(2, this.snapshotRetryAttempt), SNAPSHOT_BACKOFF_MAX_MS);
            this.snapshotRetryAttempt++;
            this.consoleHandler("Scheduling trackData retry", `attempt ${this.snapshotRetryAttempt}, delay ${delay}ms`);
            if (this.snapshotRetryTimeout)
                clearTimeout(this.snapshotRetryTimeout);
            this.snapshotRetryTimeout = setTimeout(() => {
                this.trackData();
            }, delay);
        };
        this.scheduleMeshRetry = () => {
            const delay = Math.min(SNAPSHOT_BACKOFF_BASE_MS * Math.pow(2, this.meshRetryAttempt), SNAPSHOT_BACKOFF_MAX_MS);
            this.meshRetryAttempt++;
            this.consoleHandler("Scheduling trackMesh retry", `attempt ${this.meshRetryAttempt}, delay ${delay}ms`);
            if (this.meshRetryTimeout)
                clearTimeout(this.meshRetryTimeout);
            this.meshRetryTimeout = setTimeout(() => {
                this.trackMesh();
            }, delay);
        };
        this.maybeBecomeServerReady = () => {
            if (this.serverReady)
                return;
            if (!this.docServerSnapshot)
                return;
            if (!this.updatesServerSnapshot && !this.updatesAccessDenied)
                return;
            this.serverReady = true;
            if (this.onServerReady)
                this.onServerReady();
            void this.syncLocal();
        };
        this.applyRemoteUpdateBytes = (bytes) => {
            this.firebaseDataLastUpdatedAt = new Date().getTime();
            Y.applyUpdate(this.doc, bytes, "origin:firebase/update");
            this.lastPersistedSV = mergeStateVectors(this.lastPersistedSV, stateVectorFromUpdate(bytes));
        };
        this.trackData = () => {
            // Whenever there are changes to the firebase document
            // pull the changes and merge them to the current
            // yjs document
            if (this.unsubscribeData)
                this.unsubscribeData();
            if (this.snapshotRetryTimeout) {
                clearTimeout(this.snapshotRetryTimeout);
                delete this.snapshotRetryTimeout;
            }
            this.dataListenerPaused = false;
            const unsubDoc = onSnapshot(doc(this.db, this.documentPath), { includeMetadataChanges: true }, (snap) => {
                void this.handleDocSnapshot(snap).catch((error) => {
                    this.consoleHandler("Firestore sync error", error);
                    this.scheduleSnapshotRetry();
                });
            }, (error) => {
                this.consoleHandler("Firestore sync error", error);
                if (error.code === "permission-denied") {
                    if (this.onDeleted)
                        this.onDeleted();
                    return;
                }
                this.scheduleSnapshotRetry();
            });
            const unsubUpdates = onSnapshot(collection(this.db, updatesCollectionPath(this.documentPath)), { includeMetadataChanges: true }, (snap) => {
                var _a;
                this.snapshotRetryAttempt = 0;
                const fromCache = ((_a = snap.metadata) === null || _a === void 0 ? void 0 : _a.fromCache) === true;
                this.updatesAccessDenied = false;
                this.updateDocCount = 0;
                this.updateTotalBytes = 0;
                const listed = [];
                if (!this.epochReplaced && typeof snap.forEach === "function") {
                    snap.forEach((d) => {
                        const data = (typeof d.data === "function" ? d.data() : undefined);
                        const bytes = readBytes(data === null || data === void 0 ? void 0 : data.update);
                        if (!bytes)
                            return;
                        listed.push({
                            id: d.id,
                            update: bytes,
                            seq: typeof (data === null || data === void 0 ? void 0 : data.seq) === "number" ? data.seq : 0,
                            clientId: typeof (data === null || data === void 0 ? void 0 : data.clientId) === "string" ? data.clientId : undefined,
                        });
                        this.updateDocCount++;
                        this.updateTotalBytes += bytes.byteLength;
                        if (this.appliedUpdateIds.has(d.id))
                            return;
                        this.appliedUpdateIds.add(d.id);
                        if (typeof (data === null || data === void 0 ? void 0 : data.seq) === "number" && data.seq > this.lastSeq) {
                            this.lastSeq = data.seq;
                        }
                        this.applyRemoteUpdateBytes(bytes);
                    });
                }
                this.listedUpdates = listed;
                if (!fromCache) {
                    this.updatesServerSnapshot = true;
                    this.maybeBecomeServerReady();
                }
            }, (error) => {
                this.consoleHandler("Firestore updates sync error", error);
                if (error.code === "permission-denied") {
                    this.updatesAccessDenied = true;
                    if (!this.updatesDeniedWarned) {
                        this.updatesDeniedWarned = true;
                        this.consoleHandler("Updates collection permission-denied; writing full snapshots until access is restored");
                    }
                    this.maybeBecomeServerReady();
                    return;
                }
                this.scheduleSnapshotRetry();
            });
            this.unsubscribeData = () => {
                this.snapshotHydrateGen++;
                unsubDoc();
                unsubUpdates();
            };
        };
        this.handleDocSnapshot = (snap) => __awaiter(this, void 0, void 0, function* () {
            var _c;
            const hydrateGen = ++this.snapshotHydrateGen;
            this.snapshotRetryAttempt = 0;
            const fromCache = ((_c = snap.metadata) === null || _c === void 0 ? void 0 : _c.fromCache) === true;
            this.lastSnapshotFromCache = fromCache;
            if (snap.exists()) {
                const data = snap.data();
                const meta = readSnapshotMeta(data, this.epochField);
                if (this.hydratedEpoch !== undefined &&
                    meta.epoch > this.hydratedEpoch) {
                    if (!this.epochReplaced) {
                        const from = this.hydratedEpoch;
                        this.epochReplaced = true;
                        void this.deleteLocal();
                        if (this.onEpochReplace) {
                            this.onEpochReplace({ from, to: meta.epoch });
                        }
                    }
                }
                else {
                    const applied = yield this.applyRemoteSnapshot(meta, hydrateGen);
                    if (!applied)
                        return;
                    this.hydratedEpoch = meta.epoch;
                }
                if (hydrateGen !== this.snapshotHydrateGen)
                    return;
                if (!this.ready) {
                    if (this.onReady) {
                        this.onReady();
                        this.ready = true;
                    }
                }
            }
            if (hydrateGen !== this.snapshotHydrateGen)
                return;
            if (!fromCache) {
                this.docServerSnapshot = true;
                this.maybeBecomeServerReady();
            }
        });
        /**
         * Apply remote snapshot bytes. Returns false when a storage read failed
         * (retry scheduled) or a newer snapshot superseded this one.
         */
        this.applyRemoteSnapshot = (meta, hydrateGen) => __awaiter(this, void 0, void 0, function* () {
            var _d, _e;
            if (this.snapshotStore) {
                const stored = snapshotMetaFromFields(meta);
                if (!stored) {
                    // Missing path + empty doc: first write. Do not apply Firestore content.
                    return hydrateGen === this.snapshotHydrateGen;
                }
                const skipApply = !!meta.snapshotSV &&
                    stateVectorCovers(this.lastPersistedSV, meta.snapshotSV);
                if (skipApply) {
                    this.hasRemoteContent = true;
                    return hydrateGen === this.snapshotHydrateGen;
                }
                let bytes;
                try {
                    bytes = yield this.snapshotStore.read(stored);
                }
                catch (error) {
                    this.consoleHandler("Firestore sync error", error);
                    this.scheduleSnapshotRetry();
                    return false;
                }
                if (hydrateGen !== this.snapshotHydrateGen)
                    return false;
                this.hasRemoteContent = true;
                this.clearFoldBackoff();
                this.firebaseDataLastUpdatedAt = new Date().getTime();
                Y.applyUpdate(this.doc, bytes, "origin:firebase/update");
                this.lastPersistedSV = mergeStateVectors(this.lastPersistedSV, (_d = meta.snapshotSV) !== null && _d !== void 0 ? _d : stateVectorFromUpdate(bytes));
                return true;
            }
            if (meta.content) {
                this.hasRemoteContent = true;
                const skipApply = !!meta.snapshotSV &&
                    stateVectorCovers(this.lastPersistedSV, meta.snapshotSV);
                if (!skipApply) {
                    this.clearFoldBackoff();
                    this.firebaseDataLastUpdatedAt = new Date().getTime();
                    Y.applyUpdate(this.doc, meta.content, "origin:firebase/update");
                    this.lastPersistedSV = mergeStateVectors(this.lastPersistedSV, (_e = meta.snapshotSV) !== null && _e !== void 0 ? _e : stateVectorFromUpdate(meta.content));
                }
            }
            return true;
        });
        this.trackMesh = () => {
            if (this.unsubscribeMesh)
                this.unsubscribeMesh();
            if (this.meshRetryTimeout) {
                clearTimeout(this.meshRetryTimeout);
                delete this.meshRetryTimeout;
            }
            this.unsubscribeMesh = onSnapshot(collection(this.db, `${this.documentPath}/instances`), (snapshot) => {
                this.meshRetryAttempt = 0;
                this.clients = [];
                snapshot.forEach((doc) => {
                    this.clients.push(doc.id);
                });
                const mesh = createGraph(this.clients);
                // a -> b, c; a is the sender and b, c are receivers
                const receivers = mesh[this.uid]; // this user's receivers
                const senders = Object.keys(mesh).filter((v, i) => mesh[v] && mesh[v].length && mesh[v].includes(this.uid)); // this user's senders
                this.peersReceivers = this.connectToPeers(receivers, this.peersReceivers, true);
                this.peersSenders = this.connectToPeers(senders, this.peersSenders, false);
            }, (error) => {
                this.consoleHandler("Creating peer mesh error", error);
                if (error.code === "permission-denied") {
                    if (this.onDeleted)
                        this.onDeleted();
                    return;
                }
                this.scheduleMeshRetry();
            });
        };
        this.reconnect = () => {
            if (this.recreateTimeout)
                clearTimeout(this.recreateTimeout);
            this.recreateTimeout = setTimeout(() => __awaiter(this, void 0, void 0, function* () {
                this.consoleHandler("triggering reconnect", this.uid);
                // Soft reconnect: tear down mesh and instance only. Do NOT call destroy() so we keep
                // doc update handler and trackData — Firestore writes and onSaving keep working when offline.
                if (this.cacheTimeout)
                    clearTimeout(this.cacheTimeout);
                if (this.firestoreTimeout)
                    clearTimeout(this.firestoreTimeout);
                if (this.unsubscribeMesh) {
                    this.unsubscribeMesh();
                    delete this.unsubscribeMesh;
                }
                yield deleteInstance(this.db, this.documentPath, this.uid);
                if (this.peersRTC.receivers) {
                    Object.values(this.peersRTC.receivers).forEach((receiver) => receiver.destroy());
                    this.peersRTC.receivers = {};
                }
                if (this.peersRTC.senders) {
                    Object.values(this.peersRTC.senders).forEach((sender) => sender.destroy());
                    this.peersRTC.senders = {};
                }
                this.clients = [];
                this.peersReceivers = new Set([]);
                this.peersSenders = new Set([]);
                try {
                    const data = yield initiateInstance(this.db, this.documentPath);
                    this.uid = data.uid;
                    this.timeOffset = data.offset;
                    this.trackMesh();
                    // instanceConnection "closed" listener was never removed, no need to re-add
                }
                catch (error) {
                    this.consoleHandler("Could not connect to a peer network.");
                }
            }), 200);
        };
        this.trackConnections = () => __awaiter(this, void 0, void 0, function* () {
            const clients = this.clients.length;
            let connected = 0;
            Object.values(this.peersRTC.receivers).forEach((receiver) => {
                if (receiver.connection !== "closed")
                    connected++;
            });
            Object.values(this.peersRTC.senders).forEach((sender) => {
                if (sender.connection !== "closed")
                    connected++;
            });
            if (clients > 1 && connected <= 0) {
                // we have lost connection with all peers
                // trigger re-generation of the graph/mesh
                this.reconnect();
            }
        });
        this.connectToPeers = (newPeers, oldPeers, isCaller) => {
            if (!newPeers)
                return new Set([]);
            // We must:
            // 1. remove obselete peers
            // 2. add new peers
            // 3. no change to same peers
            const getNewPeers = refreshPeers(newPeers, oldPeers);
            const peersType = isCaller ? "receivers" : "senders";
            if (!this.peersRTC[peersType])
                this.peersRTC[peersType] = {};
            if (getNewPeers.obselete && getNewPeers.obselete.length) {
                // Old peers, remove them
                getNewPeers.obselete.forEach((peerUid) => __awaiter(this, void 0, void 0, function* () {
                    if (this.peersRTC[peersType][peerUid]) {
                        yield this.peersRTC[peersType][peerUid].destroy();
                        delete this.peersRTC[peersType][peerUid];
                    }
                }));
            }
            if (getNewPeers.new && getNewPeers.new.length) {
                // New peers, initiate new connection to them
                getNewPeers.new.forEach((peerUid) => __awaiter(this, void 0, void 0, function* () {
                    if (this.peersRTC[peersType][peerUid]) {
                        yield this.peersRTC[peersType][peerUid].destroy();
                        delete this.peersRTC[peersType][peerUid];
                    }
                    this.peersRTC[peersType][peerUid] = new WebRtc({
                        firebaseApp: this.firebaseApp,
                        ydoc: this.doc,
                        awareness: this.awareness,
                        instanceConnection: this.instanceConnection,
                        documentPath: this.documentPath,
                        uid: this.uid,
                        peerUid,
                        isCaller,
                    });
                }));
            }
            return new Set(newPeers);
        };
        this.sendDataToPeers = ({ from, message, data, }) => {
            if (this.peersRTC) {
                if (this.peersRTC.receivers) {
                    Object.keys(this.peersRTC.receivers).forEach((receiver) => {
                        if (receiver !== from) {
                            const rtc = this.peersRTC.receivers[receiver];
                            rtc.sendData({ message, data });
                        }
                    });
                }
                if (this.peersRTC.senders) {
                    Object.keys(this.peersRTC.senders).forEach((sender) => {
                        if (sender !== from) {
                            const rtc = this.peersRTC.senders[sender];
                            rtc.sendData({ message, data });
                        }
                    });
                }
            }
        };
        this.scheduleSaveRetry = () => {
            if (this.saveRetryTimeout)
                return;
            this.saveRetryTimeout = setTimeout(() => {
                this.saveRetryTimeout = undefined;
                if (this.serverReady)
                    this.sendToFirestoreQueue();
            }, this.maxFirestoreWait);
        };
        this.saveToFirestore = () => __awaiter(this, void 0, void 0, function* () {
            if (this.saveInFlight) {
                this.saveQueued = true;
                return;
            }
            this.saveInFlight = true;
            this.saveStartedAt = Date.now();
            if (this.firestoreTimeout) {
                clearTimeout(this.firestoreTimeout);
                this.firestoreTimeout = undefined;
            }
            let flushQueuedAfterSuccess = false;
            let foldAfterSave;
            try {
                yield this.flushSaveToLocal();
                if (!this.serverReady || this.epochReplaced) {
                    this.saveQueued = false;
                    return;
                }
                const localUpdate = Y.encodeStateAsUpdate(this.doc);
                try {
                    if (!this.hasRemoteContent) {
                        yield this.writeFirstSnapshot(localUpdate);
                    }
                    else {
                        foldAfterSave = yield this.appendDelta(localUpdate);
                    }
                    this.scheduledFirstAt = undefined;
                    yield this.deleteLocal();
                    this.lastSaveDurationMs =
                        this.saveStartedAt !== undefined
                            ? Date.now() - this.saveStartedAt
                            : null;
                    if (this.onSaving)
                        this.onSaving(false);
                    flushQueuedAfterSuccess = this.saveQueued;
                    this.saveQueued = false;
                    if (foldAfterSave)
                        this.scheduleFold(foldAfterSave);
                }
                catch (error) {
                    this.consoleHandler("saveToFirestore: CAUGHT error", error);
                    const reason = error && typeof error === "object" && "reason" in error
                        ? error.reason
                        : undefined;
                    if (reason === "size-abort" || reason === "compact-required") {
                        this.saveQueued = false;
                        return;
                    }
                    const code = error && typeof error === "object" && "code" in error
                        ? String(error.code)
                        : undefined;
                    const saveReason = reason === "save-timeout" ? "save-timeout" : "save-failed";
                    if (this.onSaveError) {
                        this.onSaveError(error, this.saveContext(localUpdate.byteLength, saveReason, { code }));
                    }
                    this.scheduleSaveRetry();
                }
            }
            finally {
                this.saveInFlight = false;
                this.saveStartedAt = undefined;
            }
            if (flushQueuedAfterSuccess) {
                this.sendToFirestoreQueue();
            }
        });
        this.abortSize = (byteLength, message) => {
            const err = Object.assign(new Error(message), {
                reason: "size-abort",
            });
            if (this.onSaveError) {
                this.onSaveError(err, this.saveContext(byteLength, "size-abort"));
            }
            throw err;
        };
        this.clearFoldBackoff = () => {
            this.foldBackoffUntil = undefined;
            this.foldAbortedAtSnapshotSV = undefined;
            this.foldAbortReported = false;
        };
        this.beginFoldBackoff = () => {
            this.foldBackoffUntil = Date.now() + FOLD_BACKOFF_MS;
            this.foldAbortedAtSnapshotSV = this.lastPersistedSV;
        };
        this.shouldSkipFold = () => {
            if (this.foldBackoffUntil === undefined)
                return false;
            if (Date.now() >= this.foldBackoffUntil) {
                this.foldBackoffUntil = undefined;
                return false;
            }
            return true;
        };
        this.emitCompactRequired = (byteLength) => {
            const err = Object.assign(new Error("y-fire: snapshot exceeds Firestore 1 MiB limit; compact required"), { reason: "compact-required" });
            if (!this.foldAbortReported) {
                this.foldAbortReported = true;
                if (this.onSaveError) {
                    this.onSaveError(err, this.saveContext(byteLength, "compact-required"));
                }
            }
            return err;
        };
        this.applyFoldSuccess = (fold, listed) => {
            if (fold.kind === "warn" && this.onSaveWarning) {
                this.onSaveWarning(this.saveContext(fold.byteLength, "size-warn"));
            }
            Y.applyUpdate(this.doc, fold.snapshot, "origin:firebase/update");
            // Persist the written snapshot's SV, not the live doc: concurrent local
            // edits during the fold await must remain unpersisted for the next append.
            this.lastPersistedSV = mergeStateVectors(this.lastPersistedSV, stateVectorFromUpdate(fold.snapshot));
            const foldedIds = new Set(listed.map((item) => item.id));
            this.listedUpdates = this.listedUpdates.filter((u) => !foldedIds.has(u.id));
            this.updateDocCount = this.listedUpdates.length;
            this.updateTotalBytes = this.listedUpdates.reduce((sum, u) => sum + u.update.byteLength, 0);
            for (const item of listed) {
                this.appliedUpdateIds.delete(item.id);
            }
            this.clearFoldBackoff();
        };
        this.writeForcedSnapshot = (localUpdate) => __awaiter(this, void 0, void 0, function* () {
            const listed = this.updatesAccessDenied
                ? []
                : this.listedUpdates.length > 0
                    ? this.listedUpdates.slice()
                    : yield listUpdates(this.db, this.documentPath);
            const fold = yield foldUpdates({
                db: this.db,
                documentPath: this.documentPath,
                listed,
                localUpdate,
                documentMapper: this.documentMapper,
                maxContentBytes: this.maxContentBytes,
                force: true,
                snapshotStore: this.snapshotStore,
            });
            if (fold.status === "abort") {
                this.beginFoldBackoff();
                throw this.emitCompactRequired(fold.byteLength);
            }
            if (fold.status !== "ok")
                return;
            this.applyFoldSuccess(fold, listed);
        });
        this.writeFirstSnapshot = (localUpdate) => __awaiter(this, void 0, void 0, function* () {
            const svAtEncode = Y.encodeStateVector(this.doc);
            if (!this.snapshotStore) {
                const kind = contentSizeKind(localUpdate.byteLength, this.maxContentBytes);
                if (kind === "abort") {
                    this.abortSize(localUpdate.byteLength, "y-fire: encoded content exceeds Firestore 1 MiB limit");
                }
                if (kind === "warn" && this.onSaveWarning) {
                    this.onSaveWarning(this.saveContext(localUpdate.byteLength, "size-warn"));
                }
            }
            const outcome = yield this.awaitWithSaveTimeout(writeSnapshot({
                db: this.db,
                documentPath: this.documentPath,
                content: localUpdate,
                documentMapper: this.documentMapper,
                snapshotStore: this.snapshotStore,
            }));
            if (outcome === "exists") {
                this.hasRemoteContent = true;
                yield this.appendDelta(localUpdate);
                return;
            }
            this.hasRemoteContent = true;
            this.lastPersistedSV = mergeStateVectors(this.lastPersistedSV, svAtEncode);
        });
        this.appendDelta = (localUpdate) => __awaiter(this, void 0, void 0, function* () {
            if (this.updatesAccessDenied) {
                yield this.writeForcedSnapshot(localUpdate);
                return;
            }
            const svAtEncode = Y.encodeStateVector(this.doc);
            const delta = Y.encodeStateAsUpdate(this.doc, this.lastPersistedSV);
            if (delta.byteLength <= EMPTY_YJS_UPDATE_MAX_BYTES) {
                return;
            }
            const kind = contentSizeKind(delta.byteLength, this.maxContentBytes);
            if (kind === "abort") {
                yield this.writeForcedSnapshot(localUpdate);
                return;
            }
            const seq = this.lastSeq + 1;
            let result;
            try {
                result = yield this.awaitWithSaveTimeout(appendUpdate(this.db, this.documentPath, {
                    update: delta,
                    seq,
                    clientId: this.uid,
                }));
            }
            catch (error) {
                // Create already committed / lost ack.
                if (!isAlreadyExistsError(error))
                    throw error;
                const id = updateIdFromAlreadyExistsError(error);
                result = id ? { id } : undefined;
            }
            this.lastSeq = seq;
            if (result === null || result === void 0 ? void 0 : result.id)
                this.appliedUpdateIds.add(result.id);
            this.lastPersistedSV = mergeStateVectors(this.lastPersistedSV, svAtEncode);
            return localUpdate;
        });
        this.scheduleFold = (localUpdate) => {
            if (this.foldInFlight) {
                this.foldQueued = true;
                this.pendingFoldLocal = localUpdate;
                return;
            }
            this.foldInFlight = true;
            enqueueTabFold(() => __awaiter(this, void 0, void 0, function* () {
                var _a;
                try {
                    yield this.maybeFold(localUpdate);
                }
                finally {
                    this.foldInFlight = false;
                    if (this.foldQueued) {
                        this.foldQueued = false;
                        const next = (_a = this.pendingFoldLocal) !== null && _a !== void 0 ? _a : Y.encodeStateAsUpdate(this.doc);
                        this.pendingFoldLocal = undefined;
                        this.scheduleFold(next);
                    }
                }
            }));
        };
        this.maybeFold = (localUpdate) => __awaiter(this, void 0, void 0, function* () {
            if (this.epochReplaced)
                return;
            if (this.shouldSkipFold())
                return;
            const bytesThreshold = Math.floor(this.maxContentBytes * this.foldBytesFraction);
            if (this.updateDocCount < this.foldUpdateThreshold &&
                this.updateTotalBytes < bytesThreshold) {
                return;
            }
            try {
                const listed = this.listedUpdates.slice();
                const fold = yield foldUpdates({
                    db: this.db,
                    documentPath: this.documentPath,
                    listed,
                    localUpdate,
                    documentMapper: this.documentMapper,
                    maxContentBytes: this.maxContentBytes,
                    snapshotStore: this.snapshotStore,
                });
                if (fold.status === "abort") {
                    this.beginFoldBackoff();
                    this.emitCompactRequired(fold.byteLength);
                    return;
                }
                if (fold.status !== "ok")
                    return;
                this.applyFoldSuccess(fold, listed);
            }
            catch (error) {
                this.consoleHandler("foldUpdates error", error);
            }
        });
        this.sendToFirestoreQueue = () => {
            var _a;
            if (this.onSaving)
                this.onSaving(true);
            if (this.scheduledFirstAt === undefined) {
                this.scheduledFirstAt = Date.now();
            }
            if (this.saveInFlight) {
                this.saveQueued = true;
                return;
            }
            const now = Date.now();
            const elapsedSinceScheduled = now - ((_a = this.scheduledFirstAt) !== null && _a !== void 0 ? _a : now);
            if (this.serverReady && elapsedSinceScheduled > this.maxFirestoreDeferral) {
                if (this.firestoreTimeout) {
                    clearTimeout(this.firestoreTimeout);
                    this.firestoreTimeout = undefined;
                }
                void this.saveToFirestore();
                return;
            }
            if (this.firestoreTimeout)
                clearTimeout(this.firestoreTimeout);
            this.firestoreTimeout = setTimeout(() => {
                var _a;
                const tickNow = Date.now();
                const elapsedSinceLastFirebaseUpdate = tickNow - this.firebaseDataLastUpdatedAt;
                const elapsedSinceScheduledTick = tickNow - ((_a = this.scheduledFirstAt) !== null && _a !== void 0 ? _a : tickNow);
                const shouldSave = this.serverReady &&
                    (elapsedSinceLastFirebaseUpdate > this.maxFirestoreWait ||
                        elapsedSinceScheduledTick > this.maxFirestoreDeferral);
                if (shouldSave) {
                    this.saveToFirestore();
                }
                else {
                    this.sendToFirestoreQueue();
                }
            }, this.maxFirestoreWait);
        };
        this.sendCache = (from) => {
            this.sendDataToPeers({
                from,
                message: null,
                data: this.cache,
            });
            this.cache = null;
            this.cacheUpdateCount = 0;
            this.sendToFirestoreQueue();
        };
        this.sendToQueue = ({ from, update }) => {
            if (from === this.uid) {
                if (this.cacheTimeout)
                    clearTimeout(this.cacheTimeout);
                this.cache = this.cache ? Y.mergeUpdates([this.cache, update]) : update;
                this.cacheUpdateCount++;
                if (this.cacheUpdateCount >= this.maxCacheUpdates) {
                    // if the cache was already merged 20 times (this.maxCacheUpdates), send
                    // the updates in cache to the peers
                    this.sendCache(from);
                }
                else {
                    // Wait to see if the user make other changes
                    // if the user does not make changes for the next 500ms
                    // send updates in cache to the peers
                    this.cacheTimeout = setTimeout(() => {
                        this.sendCache(from);
                    }, this.maxRTCWait);
                }
            }
            else {
                // this update was from a peer, not this user
                this.sendDataToPeers({
                    from,
                    message: null,
                    data: update,
                });
            }
        };
        this.updateHandler = (update, origin) => {
            // Origin can be of the following types
            // 1. User typed something -> origin: object
            // 2. User loaded something from local store -> origin: object
            // 3. User received update from a peer -> origin: string = peer uid
            // 4. User received update from Firestore -> origin: string = 'origin:firebase/update'
            // 5. Update triggered because user applied updates from the above sources -> origin: string = uid
            if (origin !== this.uid) {
                // We will not allow no. 5. to propagate any further
                // Apply updates received from no. 1 to 4. -> triggers no. 5
                Y.applyUpdate(this.doc, update, this.uid); // the third parameter sets the transaction-origin
                // Convert no. 1 and 2 to uid, because we want these to eventually trigger 'save' to Firestore
                // sendToQueue method will either:
                // 1. save origin:uid to Firestore (and send to peers through WebRtc)
                // 2. send updates from other origins through WebRtc only
                this.sendToQueue({
                    from: typeof origin === "string" ? origin : this.uid,
                    update,
                });
                this.scheduleSaveToLocal();
            }
        };
        this.awarenessUpdateHandler = ({ added, updated, removed, }, origin) => {
            const changedClients = added.concat(updated).concat(removed);
            this.sendDataToPeers({
                from: origin !== "local" ? origin : this.uid,
                message: "awareness",
                data: awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients),
            });
        };
        this.flushOnHide = () => {
            if (!this.serverReady) {
                void this.flushSaveToLocal();
                return;
            }
            if (this.firestoreTimeout || this.cache) {
                void this.saveToFirestore();
                return;
            }
            void this.flushSaveToLocal();
        };
        this.onVisibilityChange = () => {
            if (document.visibilityState === "hidden") {
                this.flushOnHide();
            }
            else if (document.visibilityState === "visible") {
                if (this.dataListenerPaused) {
                    this.trackData();
                }
            }
        };
        this.onPageShow = () => {
            if (this.dataListenerPaused) {
                this.trackData();
            }
        };
        this.consoleHandler = (message, data = null) => {
            console.log("Provider:", this.documentPath, `this client: ${this.uid}`, message, data);
        };
        // use destroy directly if you don't need arguements
        // otherwise use kill
        this.destroy = () => {
            // we have to create a separate function here
            // because beforeunload only takes this.destroy
            // and not this.destroy() or with this.destroy(args)
            void this.kill();
        };
        // Initializing values
        this.firebaseApp = firebaseApp;
        this.db = getFirestore(this.firebaseApp);
        this.doc = ydoc;
        this.documentPath = path;
        if (docMapper)
            this.documentMapper = docMapper;
        if (maxUpdatesThreshold)
            this.maxCacheUpdates = maxUpdatesThreshold;
        if (maxWaitTime)
            this.maxRTCWait = maxWaitTime;
        if (maxWaitFirestoreTime)
            this.maxFirestoreWait = maxWaitFirestoreTime;
        if (maxFirestoreDeferral)
            this.maxFirestoreDeferral = maxFirestoreDeferral;
        if (maxContentBytes)
            this.maxContentBytes = maxContentBytes;
        if (foldUpdateThreshold)
            this.foldUpdateThreshold = foldUpdateThreshold;
        if (foldBytesFraction)
            this.foldBytesFraction = foldBytesFraction;
        if (epochField)
            this.epochField = epochField;
        if (saveTimeoutMs !== undefined)
            this.saveTimeoutMs = saveTimeoutMs;
        if (snapshotStore)
            this.snapshotStore = snapshotStore;
        this.persistenceMode = persistence !== null && persistence !== void 0 ? persistence : "indexeddb";
        this.persistenceAdapter = createPersistenceAdapter(this.persistenceMode);
        this.awareness = new awarenessProtocol.Awareness(this.doc);
        // Initialize the provider
        const init = this.init();
    }
}
