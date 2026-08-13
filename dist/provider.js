var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { getFirestore, onSnapshot, doc, runTransaction, Bytes, } from "@firebase/firestore";
import { collection } from "firebase/firestore";
import * as Y from "yjs";
import { ObservableV2 } from "lib0/observable";
import * as awarenessProtocol from "y-protocols/awareness";
import { deleteInstance, initiateInstance, refreshPeers } from "./utils";
import { WebRtc } from "./webrtc";
import { createGraph } from "./graph";
import { createPersistenceAdapter, } from "./persistence";
import { EMPTY_YJS_UPDATE_MAX_BYTES, FIRESTORE_CONTENT_MAX_BYTES, contentSizeKind, } from "./firestore-limits";
const SNAPSHOT_BACKOFF_BASE_MS = 500;
const SNAPSHOT_BACKOFF_MAX_MS = 16000;
/**
 * FireProvider class that handles firestore data sync and awareness
 * based on webRTC.
 * @param firebaseApp Firestore instance
 * @param ydoc ydoc
 * @param path path to the firestore document (ex. collection/documentuid)
 * @param maxUpdatesThreshold maximum number of updates to wait for before sending updates to peers
 * @param maxWaitTime maximum miliseconds to wait before sending updates to peers
 * @param maxWaitFirestoreTime miliseconds to wait before syncing this client's update to firestore
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
    kill(keepReadOnly = false) {
        const _super = Object.create(null, {
            destroy: { get: () => super.destroy }
        });
        return __awaiter(this, void 0, void 0, function* () {
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
    constructor({ firebaseApp, ydoc, path, docMapper, maxUpdatesThreshold, maxWaitTime, maxWaitFirestoreTime, maxFirestoreDeferral, persistence, maxContentBytes, }) {
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
        this.firebaseDataLastUpdatedAt = new Date().getTime();
        this.instanceConnection = new ObservableV2();
        this.snapshotRetryAttempt = 0;
        this.meshRetryAttempt = 0;
        this.dataListenerPaused = false;
        this.pendingSyncLocal = false;
        this.lastSnapshotFromCache = true;
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
            if (!this.serverReady) {
                this.pendingSyncLocal = true;
                return;
            }
            this.pendingSyncLocal = false;
            try {
                const local = yield this.persistenceAdapter.getLocal(this.documentPath);
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
            try {
                const currentDoc = Y.encodeStateAsUpdate(this.doc);
                yield this.persistenceAdapter.setLocal(this.documentPath, currentDoc);
            }
            catch (e) {
                this.consoleHandler("set local error", e);
            }
        });
        this.deleteLocal = () => __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.persistenceAdapter.deleteLocal(this.documentPath);
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
            this.unsubscribeData = onSnapshot(doc(this.db, this.documentPath), { includeMetadataChanges: true }, (snap) => {
                var _a;
                this.snapshotRetryAttempt = 0;
                const fromCache = ((_a = snap.metadata) === null || _a === void 0 ? void 0 : _a.fromCache) === true;
                this.lastSnapshotFromCache = fromCache;
                if (snap.exists()) {
                    const data = snap.data();
                    if (data && data.content) {
                        const now = new Date().getTime();
                        this.firebaseDataLastUpdatedAt = now;
                        const content = data.content.toUint8Array();
                        const origin = "origin:firebase/update"; // make sure this does not coincide with UID
                        Y.applyUpdate(this.doc, content, origin);
                    }
                    if (!this.ready) {
                        if (this.onReady) {
                            this.onReady();
                            this.ready = true;
                        }
                    }
                }
                if (!fromCache) {
                    this.lastServerStateVector = Y.encodeStateVector(this.doc);
                    const wasReady = this.serverReady;
                    this.serverReady = true;
                    if (!wasReady) {
                        if (this.onServerReady)
                            this.onServerReady();
                        void this.syncLocal();
                    }
                }
            }, (error) => {
                this.consoleHandler("Firestore sync error", error);
                if (error.code === "permission-denied") {
                    if (this.onDeleted)
                        this.onDeleted();
                    return;
                }
                this.scheduleSnapshotRetry();
            });
        };
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
            if (!this.serverReady) {
                return;
            }
            if (this.firestoreTimeout) {
                clearTimeout(this.firestoreTimeout);
                this.firestoreTimeout = undefined;
            }
            const localUpdate = Y.encodeStateAsUpdate(this.doc);
            try {
                const ref = doc(this.db, this.documentPath);
                let written = null;
                yield runTransaction(this.db, (tx) => __awaiter(this, void 0, void 0, function* () {
                    var _a;
                    const snap = yield tx.get(ref);
                    const merged = new Y.Doc();
                    try {
                        const raw = snap.exists() ? (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.content : undefined;
                        const remoteBytes = raw && typeof raw.toUint8Array === "function"
                            ? raw.toUint8Array()
                            : undefined;
                        if (remoteBytes && remoteBytes.length > 0) {
                            Y.applyUpdate(merged, remoteBytes);
                        }
                        Y.applyUpdate(merged, localUpdate);
                        if (this.lastServerStateVector) {
                            const missing = Y.encodeStateAsUpdate(merged, Y.encodeStateVector(this.doc));
                            if (missing.byteLength > EMPTY_YJS_UPDATE_MAX_BYTES) {
                                if (this.onSaveWarning) {
                                    this.onSaveWarning(this.saveContext(missing.byteLength, "shrink"));
                                }
                            }
                        }
                        const out = Y.encodeStateAsUpdate(merged);
                        const kind = contentSizeKind(out.byteLength, this.maxContentBytes);
                        if (kind === "abort") {
                            const err = Object.assign(new Error("y-fire: encoded content exceeds Firestore 1 MiB limit"), { reason: "size-abort" });
                            if (this.onSaveError) {
                                this.onSaveError(err, this.saveContext(out.byteLength, "size-abort"));
                            }
                            throw err;
                        }
                        if (kind === "warn" && this.onSaveWarning) {
                            this.onSaveWarning(this.saveContext(out.byteLength, "size-warn"));
                        }
                        tx.set(ref, this.documentMapper(Bytes.fromUint8Array(out)), { merge: true });
                        written = out;
                    }
                    finally {
                        merged.destroy();
                    }
                }));
                if (written) {
                    Y.applyUpdate(this.doc, written, "origin:firebase/update");
                    this.lastServerStateVector = Y.encodeStateVector(this.doc);
                }
                this.scheduledFirstAt = undefined;
                yield this.deleteLocal();
                if (this.onSaving)
                    this.onSaving(false);
            }
            catch (error) {
                this.consoleHandler("saveToFirestore: CAUGHT error", error);
                const reason = error && typeof error === "object" && "reason" in error
                    ? error.reason
                    : undefined;
                if (reason === "size-abort") {
                    return;
                }
                const code = error && typeof error === "object" && "code" in error
                    ? String(error.code)
                    : undefined;
                if (this.onSaveError) {
                    this.onSaveError(error, this.saveContext(localUpdate.byteLength, "save-failed", { code }));
                }
                this.scheduleSaveRetry();
            }
        });
        this.sendToFirestoreQueue = () => {
            if (this.firestoreTimeout)
                clearTimeout(this.firestoreTimeout);
            if (this.onSaving)
                this.onSaving(true);
            if (this.scheduledFirstAt === undefined) {
                this.scheduledFirstAt = Date.now();
            }
            this.firestoreTimeout = setTimeout(() => {
                var _a;
                const now = Date.now();
                const elapsedSinceLastFirebaseUpdate = now - this.firebaseDataLastUpdatedAt;
                const elapsedSinceScheduled = now - ((_a = this.scheduledFirstAt) !== null && _a !== void 0 ? _a : now);
                const shouldSave = this.serverReady &&
                    (elapsedSinceLastFirebaseUpdate > this.maxFirestoreWait ||
                        elapsedSinceScheduled > this.maxFirestoreDeferral);
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
                this.saveToLocal(); // save data to local indexedDb
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
            if (!this.serverReady)
                return;
            if (this.firestoreTimeout || this.cache) {
                void this.saveToFirestore();
            }
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
        this.persistenceMode = persistence !== null && persistence !== void 0 ? persistence : "indexeddb";
        this.persistenceAdapter = createPersistenceAdapter(this.persistenceMode);
        this.awareness = new awarenessProtocol.Awareness(this.doc);
        // Initialize the provider
        const init = this.init();
    }
}
