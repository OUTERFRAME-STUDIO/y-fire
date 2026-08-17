import { FirebaseApp } from "@firebase/app";
import {
  getFirestore,
  Firestore,
  Unsubscribe,
  onSnapshot,
  doc,
  collection,
  type Bytes,
} from "@firebase/firestore";
import * as Y from "yjs";
import { ObservableV2 } from "lib0/observable";
import * as awarenessProtocol from "y-protocols/awareness";
import { deleteInstance, initiateInstance, refreshPeers } from "./utils";
import { WebRtc } from "./webrtc";
import { createGraph } from "./graph";
import {
  createPersistenceAdapter,
  decodeEpochMeta,
  encodeEpochMeta,
  PersistenceAdapter,
  PersistenceMode,
  persistenceMetaKey,
} from "./persistence";
import {
  EMPTY_YJS_UPDATE_MAX_BYTES,
  FIRESTORE_CONTENT_MAX_BYTES,
  contentSizeKind,
} from "./firestore-limits";
import {
  appendUpdate,
  DEFAULT_EPOCH_FIELD,
  DEFAULT_FOLD_BYTES_FRACTION,
  DEFAULT_FOLD_UPDATE_THRESHOLD,
  foldUpdates,
  listUpdates,
  readBytes,
  readSnapshotMeta,
  updatesCollectionPath,
  writeSnapshot,
} from "./append-store";
import { mergeStateVectors, stateVectorCovers, stateVectorFromUpdate } from "./state-vector";

export type FireSaveReason =
  | "save-failed"
  | "size-abort"
  | "size-warn"
  | "shrink"
  | "compact-required";

export interface FireSaveContext {
  documentPath: string;
  byteLength: number;
  code?: string;
  fromCache: boolean;
  ready: boolean;
  serverReady: boolean;
  reason: FireSaveReason;
}

export interface EpochReplaceEvent {
  from: number;
  to: number;
}

export interface Parameters {
  firebaseApp: FirebaseApp;
  ydoc: Y.Doc;
  path: string;
  docMapper?: (bytes: Bytes) => object;
  maxUpdatesThreshold?: number;
  maxWaitTime?: number;
  maxWaitFirestoreTime?: number;
  maxFirestoreDeferral?: number;
  persistence?: PersistenceMode;
  /** Override Firestore `content` size cap (bytes). Defaults to 1 MiB. */
  maxContentBytes?: number;
  /** Fold `updates/*` when count reaches this (default 20). */
  foldUpdateThreshold?: number;
  /** Fold when update bytes reach this fraction of the content cap (default 0.5). */
  foldBytesFraction?: number;
  /** Epoch field name; defaults to `contentGeneration`. */
  epochField?: string;
}

interface PeersRTC {
  receivers: {
    [key: string]: WebRtc;
  };
  senders: {
    [key: string]: WebRtc;
  };
}

const SNAPSHOT_BACKOFF_BASE_MS = 500;
const SNAPSHOT_BACKOFF_MAX_MS = 16_000;
const FOLD_BACKOFF_MS = 30_000;

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
export class FireProvider extends ObservableV2<any> {
  readonly doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  readonly documentPath: string;
  readonly firebaseApp: FirebaseApp;
  readonly db: Firestore;
  uid: string;
  timeOffset: number = 0; // offset to server time in mili seconds

  clients: string[] = [];
  peersReceivers: Set<string> = new Set([]);
  peersSenders: Set<string> = new Set([]);

  peersRTC: PeersRTC = {
    receivers: {},
    senders: {},
  };

  documentMapper: (bytes: Bytes) => object = (bytes) => ({ content: bytes });

  cache: Uint8Array | null;
  maxCacheUpdates: number = 20;
  cacheUpdateCount: number = 0;
  cacheTimeout: string | number | NodeJS.Timeout;
  maxRTCWait: number = 100;
  firestoreTimeout: string | number | NodeJS.Timeout;
  maxFirestoreWait: number = 3000;
  maxFirestoreDeferral: number = 10_000;
  maxContentBytes: number = FIRESTORE_CONTENT_MAX_BYTES;
  scheduledFirstAt?: number;

  firebaseDataLastUpdatedAt: number = new Date().getTime();

  instanceConnection: ObservableV2<any> = new ObservableV2();
  recreateTimeout: string | number | NodeJS.Timeout;

  private unsubscribeData?: Unsubscribe;
  private unsubscribeMesh?: Unsubscribe;
  private persistenceAdapter: PersistenceAdapter;
  private persistenceMode: PersistenceMode;
  private snapshotRetryAttempt: number = 0;
  private meshRetryAttempt: number = 0;
  private snapshotRetryTimeout?: ReturnType<typeof setTimeout>;
  private meshRetryTimeout?: ReturnType<typeof setTimeout>;
  private saveRetryTimeout?: ReturnType<typeof setTimeout>;
  private dataListenerPaused: boolean = false;
  private pendingSyncLocal: boolean = false;
  private lastPersistedSV?: Uint8Array;
  private lastSnapshotFromCache: boolean = true;
  private hasRemoteContent: boolean = false;
  private hydratedEpoch?: number;
  private epochReplaced: boolean = false;
  private appliedUpdateIds: Set<string> = new Set();
  private lastSeq: number = 0;
  private docServerSnapshot: boolean = false;
  private updatesServerSnapshot: boolean = false;
  private foldUpdateThreshold: number = DEFAULT_FOLD_UPDATE_THRESHOLD;
  private foldBytesFraction: number = DEFAULT_FOLD_BYTES_FRACTION;
  private epochField: string = DEFAULT_EPOCH_FIELD;
  private updateDocCount: number = 0;
  private updateTotalBytes: number = 0;
  private foldBackoffUntil?: number;
  private foldAbortedAtSnapshotSV?: Uint8Array;
  private foldAbortReported: boolean = false;
  private updatesAccessDenied: boolean = false;
  private updatesDeniedWarned: boolean = false;

  get clientTimeOffset() {
    return this.timeOffset;
  }

  ready: boolean = false;
  serverReady: boolean = false;
  public onReady: () => void;
  public onServerReady: () => void;
  public onDeleted: () => void;
  public onSaving: (status: boolean) => void;
  public onSaveError: (error: unknown, ctx: FireSaveContext) => void;
  public onSaveWarning: (ctx: FireSaveContext) => void;
  public onEpochReplace: (event: EpochReplaceEvent) => void;

  init = async () => {
    this.trackData(); // initiate this before creating instance, so that users with read permissions can also view the document
    // Attach update handler immediately so writes (and onSaving) work even when
    // initiateInstance() fails or hangs offline. this.uid stays from previous session until we get a new one.
    this.initiateHandler();
    try {
      const data = await initiateInstance(this.db, this.documentPath);
      this.instanceConnection.on("closed", this.trackConnections);
      this.uid = data.uid;
      this.timeOffset = data.offset;
      addEventListener("beforeunload", this.destroy);
      addEventListener("pagehide", this.destroy);
      addEventListener("visibilitychange", this.onVisibilityChange);
      addEventListener("pageshow", this.onPageShow);
    } catch (error) {
      this.consoleHandler("Could not connect to a peer network.");
      // this.uid stays from previous session; update handler already attached above
    }
  };

  syncLocal = async () => {
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
      const local = await this.persistenceAdapter.getLocal(this.documentPath);
      const metaBytes = await this.persistenceAdapter.getLocal(
        persistenceMetaKey(this.documentPath),
      );
      const localEpoch = decodeEpochMeta(metaBytes);
      if (local && (this.hydratedEpoch ?? 0) > localEpoch) {
        await this.deleteLocal();
        return;
      }
      if (local) {
        Y.applyUpdate(this.doc, local, { key: "local-sync" });
        if (this.persistenceMode !== "none") {
          this.sendToFirestoreQueue();
        }
      }
    } catch (e) {
      this.consoleHandler("get local error", e);
    }
  };

  saveToLocal = async () => {
    try {
      const currentDoc = Y.encodeStateAsUpdate(this.doc);
      await this.persistenceAdapter.setLocal(this.documentPath, currentDoc);
      await this.persistenceAdapter.setLocal(
        persistenceMetaKey(this.documentPath),
        encodeEpochMeta(this.hydratedEpoch ?? 0),
      );
    } catch (e) {
      this.consoleHandler("set local error", e);
    }
  };

  deleteLocal = async () => {
    try {
      await this.persistenceAdapter.deleteLocal(this.documentPath);
      await this.persistenceAdapter.deleteLocal(
        persistenceMetaKey(this.documentPath),
      );
    } catch (e) {
      this.consoleHandler("del local error", e);
    }
  };

  initiateHandler = () => {
    this.consoleHandler("FireProvider initiated!");
    this.awareness.on("update", this.awarenessUpdateHandler);
    // We will track the mesh document on Firestore to
    // keep track of selected peers
    this.trackMesh();
    this.doc.on("update", this.updateHandler);
    this.pendingSyncLocal = this.persistenceMode !== "none";
  };

  private scheduleSnapshotRetry = () => {
    const delay = Math.min(
      SNAPSHOT_BACKOFF_BASE_MS * Math.pow(2, this.snapshotRetryAttempt),
      SNAPSHOT_BACKOFF_MAX_MS,
    );
    this.snapshotRetryAttempt++;
    this.consoleHandler(
      "Scheduling trackData retry",
      `attempt ${this.snapshotRetryAttempt}, delay ${delay}ms`,
    );
    if (this.snapshotRetryTimeout) clearTimeout(this.snapshotRetryTimeout);
    this.snapshotRetryTimeout = setTimeout(() => {
      this.trackData();
    }, delay);
  };

  private scheduleMeshRetry = () => {
    const delay = Math.min(
      SNAPSHOT_BACKOFF_BASE_MS * Math.pow(2, this.meshRetryAttempt),
      SNAPSHOT_BACKOFF_MAX_MS,
    );
    this.meshRetryAttempt++;
    this.consoleHandler(
      "Scheduling trackMesh retry",
      `attempt ${this.meshRetryAttempt}, delay ${delay}ms`,
    );
    if (this.meshRetryTimeout) clearTimeout(this.meshRetryTimeout);
    this.meshRetryTimeout = setTimeout(() => {
      this.trackMesh();
    }, delay);
  };

  private maybeBecomeServerReady = () => {
    if (this.serverReady) return;
    if (!this.docServerSnapshot) return;
    if (!this.updatesServerSnapshot && !this.updatesAccessDenied) return;
    this.serverReady = true;
    if (this.onServerReady) this.onServerReady();
    void this.syncLocal();
  };

  private applyRemoteUpdateBytes = (bytes: Uint8Array) => {
    this.firebaseDataLastUpdatedAt = new Date().getTime();
    Y.applyUpdate(this.doc, bytes, "origin:firebase/update");
    this.lastPersistedSV = mergeStateVectors(
      this.lastPersistedSV,
      stateVectorFromUpdate(bytes),
    );
  };

  trackData = () => {
    // Whenever there are changes to the firebase document
    // pull the changes and merge them to the current
    // yjs document
    if (this.unsubscribeData) this.unsubscribeData();
    if (this.snapshotRetryTimeout) {
      clearTimeout(this.snapshotRetryTimeout);
      delete this.snapshotRetryTimeout;
    }
    this.dataListenerPaused = false;
    const unsubDoc = onSnapshot(
      doc(this.db, this.documentPath),
      { includeMetadataChanges: true },
      (snap) => {
        this.snapshotRetryAttempt = 0;
        const fromCache = snap.metadata?.fromCache === true;
        this.lastSnapshotFromCache = fromCache;
        if (snap.exists()) {
          const data = snap.data() as Record<string, unknown> | undefined;
          const meta = readSnapshotMeta(data, this.epochField);
          if (
            this.hydratedEpoch !== undefined &&
            meta.epoch > this.hydratedEpoch
          ) {
            if (!this.epochReplaced) {
              const from = this.hydratedEpoch;
              this.epochReplaced = true;
              void this.deleteLocal();
              if (this.onEpochReplace) {
                this.onEpochReplace({ from, to: meta.epoch });
              }
            }
          } else {
            if (meta.content) {
              this.hasRemoteContent = true;
              const skipApply =
                !!meta.snapshotSV &&
                stateVectorCovers(this.lastPersistedSV, meta.snapshotSV);
              if (!skipApply) {
                this.clearFoldBackoff();
                this.firebaseDataLastUpdatedAt = new Date().getTime();
                Y.applyUpdate(this.doc, meta.content, "origin:firebase/update");
                this.lastPersistedSV = mergeStateVectors(
                  this.lastPersistedSV,
                  meta.snapshotSV ?? stateVectorFromUpdate(meta.content),
                );
              }
            }
            this.hydratedEpoch = meta.epoch;
          }
          if (!this.ready) {
            if (this.onReady) {
              this.onReady();
              this.ready = true;
            }
          }
        }
        if (!fromCache) {
          this.docServerSnapshot = true;
          this.maybeBecomeServerReady();
        }
      },
      (error) => {
        this.consoleHandler("Firestore sync error", error);
        if (error.code === "permission-denied") {
          if (this.onDeleted) this.onDeleted();
          return;
        }
        this.scheduleSnapshotRetry();
      },
    );
    const unsubUpdates = onSnapshot(
      collection(this.db, updatesCollectionPath(this.documentPath)),
      { includeMetadataChanges: true },
      (snap) => {
        this.snapshotRetryAttempt = 0;
        const fromCache = snap.metadata?.fromCache === true;
        this.updatesAccessDenied = false;
        this.updateDocCount = 0;
        this.updateTotalBytes = 0;
        if (!this.epochReplaced && typeof snap.forEach === "function") {
          snap.forEach(
            (d: { id: string; data?: () => unknown }) => {
              const data = (
                typeof d.data === "function" ? d.data() : undefined
              ) as Record<string, unknown> | undefined;
              const bytes = readBytes(data?.update);
              if (!bytes) return;
              this.updateDocCount++;
              this.updateTotalBytes += bytes.byteLength;
              if (this.appliedUpdateIds.has(d.id)) return;
              this.appliedUpdateIds.add(d.id);
              if (typeof data?.seq === "number" && data.seq > this.lastSeq) {
                this.lastSeq = data.seq;
              }
              this.applyRemoteUpdateBytes(bytes);
            },
          );
        }
        if (!fromCache) {
          this.updatesServerSnapshot = true;
          this.maybeBecomeServerReady();
        }
      },
      (error) => {
        this.consoleHandler("Firestore updates sync error", error);
        if (error.code === "permission-denied") {
          this.updatesAccessDenied = true;
          if (!this.updatesDeniedWarned) {
            this.updatesDeniedWarned = true;
            this.consoleHandler(
              "Updates collection permission-denied; writing full snapshots until access is restored",
            );
          }
          this.maybeBecomeServerReady();
          return;
        }
        this.scheduleSnapshotRetry();
      },
    );
    this.unsubscribeData = () => {
      unsubDoc();
      unsubUpdates();
    };
  };

  trackMesh = () => {
    if (this.unsubscribeMesh) this.unsubscribeMesh();
    if (this.meshRetryTimeout) {
      clearTimeout(this.meshRetryTimeout);
      delete this.meshRetryTimeout;
    }
    this.unsubscribeMesh = onSnapshot(
      collection(this.db, `${this.documentPath}/instances`),
      (snapshot) => {
        this.meshRetryAttempt = 0;
        this.clients = [];
        snapshot.forEach((doc) => {
          this.clients.push(doc.id);
        });
        const mesh = createGraph(this.clients);

        // a -> b, c; a is the sender and b, c are receivers
        const receivers: string[] = mesh[this.uid]; // this user's receivers
        const senders: string[] = Object.keys(mesh).filter(
          (v, i) => mesh[v] && mesh[v].length && mesh[v].includes(this.uid),
        ); // this user's senders

        this.peersReceivers = this.connectToPeers(
          receivers,
          this.peersReceivers,
          true,
        );
        this.peersSenders = this.connectToPeers(
          senders,
          this.peersSenders,
          false,
        );
      },
      (error) => {
        this.consoleHandler("Creating peer mesh error", error);
        if (error.code === "permission-denied") {
          if (this.onDeleted) this.onDeleted();
          return;
        }
        this.scheduleMeshRetry();
      },
    );
  };

  reconnect = () => {
    if (this.recreateTimeout) clearTimeout(this.recreateTimeout);
    this.recreateTimeout = setTimeout(async () => {
      this.consoleHandler("triggering reconnect", this.uid);
      // Soft reconnect: tear down mesh and instance only. Do NOT call destroy() so we keep
      // doc update handler and trackData — Firestore writes and onSaving keep working when offline.
      if (this.cacheTimeout) clearTimeout(this.cacheTimeout);
      if (this.firestoreTimeout) clearTimeout(this.firestoreTimeout);
      if (this.unsubscribeMesh) {
        this.unsubscribeMesh();
        delete this.unsubscribeMesh;
      }
      await deleteInstance(this.db, this.documentPath, this.uid);
      if (this.peersRTC.receivers) {
        Object.values(this.peersRTC.receivers).forEach((receiver) =>
          receiver.destroy(),
        );
        this.peersRTC.receivers = {};
      }
      if (this.peersRTC.senders) {
        Object.values(this.peersRTC.senders).forEach((sender) =>
          sender.destroy(),
        );
        this.peersRTC.senders = {};
      }
      this.clients = [];
      this.peersReceivers = new Set([]);
      this.peersSenders = new Set([]);
      try {
        const data = await initiateInstance(this.db, this.documentPath);
        this.uid = data.uid;
        this.timeOffset = data.offset;
        this.trackMesh();
        // instanceConnection "closed" listener was never removed, no need to re-add
      } catch (error) {
        this.consoleHandler("Could not connect to a peer network.");
      }
    }, 200);
  };

  trackConnections = async () => {
    const clients = this.clients.length;
    let connected = 0;
    Object.values(this.peersRTC.receivers).forEach((receiver) => {
      if (receiver.connection !== "closed") connected++;
    });
    Object.values(this.peersRTC.senders).forEach((sender) => {
      if (sender.connection !== "closed") connected++;
    });
    if (clients > 1 && connected <= 0) {
      // we have lost connection with all peers
      // trigger re-generation of the graph/mesh
      this.reconnect();
    }
  };

  connectToPeers = (
    newPeers: string[],
    oldPeers: Set<string>,
    isCaller: boolean,
  ) => {
    if (!newPeers) return new Set([]);
    // We must:
    // 1. remove obselete peers
    // 2. add new peers
    // 3. no change to same peers
    const getNewPeers = refreshPeers(newPeers, oldPeers);
    const peersType = isCaller ? "receivers" : "senders";
    if (!this.peersRTC[peersType]) this.peersRTC[peersType] = {};
    if (getNewPeers.obselete && getNewPeers.obselete.length) {
      // Old peers, remove them
      getNewPeers.obselete.forEach(async (peerUid) => {
        if (this.peersRTC[peersType][peerUid]) {
          await this.peersRTC[peersType][peerUid].destroy();
          delete this.peersRTC[peersType][peerUid];
        }
      });
    }
    if (getNewPeers.new && getNewPeers.new.length) {
      // New peers, initiate new connection to them
      getNewPeers.new.forEach(async (peerUid) => {
        if (this.peersRTC[peersType][peerUid]) {
          await this.peersRTC[peersType][peerUid].destroy();
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
      });
    }
    return new Set(newPeers);
  };

  sendDataToPeers = ({
    from,
    message,
    data,
  }: {
    from: unknown;
    message: unknown;
    data: Uint8Array | null;
  }) => {
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

  private saveContext(
    byteLength: number,
    reason: FireSaveReason,
    extra?: { code?: string },
  ): FireSaveContext {
    return {
      documentPath: this.documentPath,
      byteLength,
      code: extra?.code,
      fromCache: this.lastSnapshotFromCache,
      ready: this.ready,
      serverReady: this.serverReady,
      reason,
    };
  }

  private scheduleSaveRetry = () => {
    if (this.saveRetryTimeout) return;
    this.saveRetryTimeout = setTimeout(() => {
      this.saveRetryTimeout = undefined;
      if (this.serverReady) this.sendToFirestoreQueue();
    }, this.maxFirestoreWait);
  };

  saveToFirestore = async () => {
    if (!this.serverReady || this.epochReplaced) {
      return;
    }
    if (this.firestoreTimeout) {
      clearTimeout(this.firestoreTimeout);
      this.firestoreTimeout = undefined;
    }
    const localUpdate = Y.encodeStateAsUpdate(this.doc);
    try {
      if (!this.hasRemoteContent) {
        await this.writeFirstSnapshot(localUpdate);
      } else {
        await this.appendDelta(localUpdate);
      }
      this.scheduledFirstAt = undefined;
      await this.deleteLocal();
      if (this.onSaving) this.onSaving(false);
    } catch (error) {
      this.consoleHandler("saveToFirestore: CAUGHT error", error);
      const reason =
        error && typeof error === "object" && "reason" in error
          ? (error as { reason?: string }).reason
          : undefined;
      if (reason === "size-abort" || reason === "compact-required") {
        return;
      }
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : undefined;
      if (this.onSaveError) {
        this.onSaveError(
          error,
          this.saveContext(localUpdate.byteLength, "save-failed", { code }),
        );
      }
      this.scheduleSaveRetry();
    }
  };

  private abortSize = (byteLength: number, message: string) => {
    const err = Object.assign(new Error(message), {
      reason: "size-abort" as const,
    });
    if (this.onSaveError) {
      this.onSaveError(err, this.saveContext(byteLength, "size-abort"));
    }
    throw err;
  };

  private clearFoldBackoff = () => {
    this.foldBackoffUntil = undefined;
    this.foldAbortedAtSnapshotSV = undefined;
    this.foldAbortReported = false;
  };

  private beginFoldBackoff = () => {
    this.foldBackoffUntil = Date.now() + FOLD_BACKOFF_MS;
    this.foldAbortedAtSnapshotSV = this.lastPersistedSV;
  };

  private shouldSkipFold = () => {
    if (this.foldBackoffUntil === undefined) return false;
    if (Date.now() >= this.foldBackoffUntil) {
      this.foldBackoffUntil = undefined;
      return false;
    }
    return true;
  };

  private emitCompactRequired = (byteLength: number) => {
    const err = Object.assign(
      new Error(
        "y-fire: snapshot exceeds Firestore 1 MiB limit; compact required",
      ),
      { reason: "compact-required" as const },
    );
    if (!this.foldAbortReported) {
      this.foldAbortReported = true;
      if (this.onSaveError) {
        this.onSaveError(err, this.saveContext(byteLength, "compact-required"));
      }
    }
    return err;
  };

  private applyFoldSuccess = (
    fold: { snapshot: Uint8Array; byteLength: number; kind: "ok" | "warn" },
    listed: { id: string }[],
  ) => {
    if (fold.kind === "warn" && this.onSaveWarning) {
      this.onSaveWarning(this.saveContext(fold.byteLength, "size-warn"));
    }
    Y.applyUpdate(this.doc, fold.snapshot, "origin:firebase/update");
    this.lastPersistedSV = mergeStateVectors(
      this.lastPersistedSV,
      stateVectorFromUpdate(fold.snapshot),
    );
    for (const item of listed) {
      this.appliedUpdateIds.delete(item.id);
    }
    this.clearFoldBackoff();
  };

  private writeForcedSnapshot = async (localUpdate: Uint8Array) => {
    const listed = this.updatesAccessDenied
      ? []
      : await listUpdates(this.db, this.documentPath);
    const fold = await foldUpdates({
      db: this.db,
      documentPath: this.documentPath,
      listed,
      localUpdate,
      documentMapper: this.documentMapper,
      maxContentBytes: this.maxContentBytes,
      force: true,
    });
    if (fold.status === "abort") {
      this.beginFoldBackoff();
      throw this.emitCompactRequired(fold.byteLength);
    }
    if (fold.status !== "ok") return;
    this.applyFoldSuccess(fold, listed);
  };

  private writeFirstSnapshot = async (localUpdate: Uint8Array) => {
    const kind = contentSizeKind(localUpdate.byteLength, this.maxContentBytes);
    if (kind === "abort") {
      this.abortSize(
        localUpdate.byteLength,
        "y-fire: encoded content exceeds Firestore 1 MiB limit",
      );
    }
    if (kind === "warn" && this.onSaveWarning) {
      this.onSaveWarning(this.saveContext(localUpdate.byteLength, "size-warn"));
    }
    const outcome = await writeSnapshot({
      db: this.db,
      documentPath: this.documentPath,
      content: localUpdate,
      documentMapper: this.documentMapper,
    });
    if (outcome === "exists") {
      this.hasRemoteContent = true;
      await this.appendDelta(localUpdate);
      return;
    }
    this.hasRemoteContent = true;
    this.lastPersistedSV = mergeStateVectors(
      this.lastPersistedSV,
      stateVectorFromUpdate(localUpdate),
    );
  };

  private appendDelta = async (localUpdate: Uint8Array) => {
    if (this.updatesAccessDenied) {
      await this.writeForcedSnapshot(localUpdate);
      return;
    }
    const delta = Y.encodeStateAsUpdate(this.doc, this.lastPersistedSV);
    if (delta.byteLength <= EMPTY_YJS_UPDATE_MAX_BYTES) {
      return;
    }
    const kind = contentSizeKind(delta.byteLength, this.maxContentBytes);
    if (kind === "abort") {
      await this.writeForcedSnapshot(localUpdate);
      return;
    }
    const seq = this.lastSeq + 1;
    const result = await appendUpdate(this.db, this.documentPath, {
      update: delta,
      seq,
      clientId: this.uid,
    });
    this.lastSeq = seq;
    if (result?.id) this.appliedUpdateIds.add(result.id);
    this.lastPersistedSV = mergeStateVectors(
      this.lastPersistedSV,
      stateVectorFromUpdate(delta),
    );
    await this.maybeFold(localUpdate);
  };

  private maybeFold = async (localUpdate: Uint8Array) => {
    if (this.shouldSkipFold()) return;
    const bytesThreshold = Math.floor(
      this.maxContentBytes * this.foldBytesFraction,
    );
    if (
      this.updateDocCount < this.foldUpdateThreshold &&
      this.updateTotalBytes < bytesThreshold
    ) {
      return;
    }
    try {
      const listed = await listUpdates(this.db, this.documentPath);
      const fold = await foldUpdates({
        db: this.db,
        documentPath: this.documentPath,
        listed,
        localUpdate,
        documentMapper: this.documentMapper,
        maxContentBytes: this.maxContentBytes,
      });
      if (fold.status === "abort") {
        this.beginFoldBackoff();
        this.emitCompactRequired(fold.byteLength);
        return;
      }
      if (fold.status !== "ok") return;
      this.applyFoldSuccess(fold, listed);
    } catch (error) {
      this.consoleHandler("foldUpdates error", error);
    }
  };

  sendToFirestoreQueue = () => {
    if (this.firestoreTimeout) clearTimeout(this.firestoreTimeout);
    if (this.onSaving) this.onSaving(true);
    if (this.scheduledFirstAt === undefined) {
      this.scheduledFirstAt = Date.now();
    }
    this.firestoreTimeout = setTimeout(() => {
      const now = Date.now();
      const elapsedSinceLastFirebaseUpdate =
        now - this.firebaseDataLastUpdatedAt;
      const elapsedSinceScheduled = now - (this.scheduledFirstAt ?? now);
      const shouldSave =
        this.serverReady &&
        (elapsedSinceLastFirebaseUpdate > this.maxFirestoreWait ||
          elapsedSinceScheduled > this.maxFirestoreDeferral);
      if (shouldSave) {
        this.saveToFirestore();
      } else {
        this.sendToFirestoreQueue();
      }
    }, this.maxFirestoreWait);
  };

  sendCache = (from: string) => {
    this.sendDataToPeers({
      from,
      message: null,
      data: this.cache,
    });
    this.cache = null;
    this.cacheUpdateCount = 0;
    this.sendToFirestoreQueue();
  };

  sendToQueue = ({ from, update }: { from: unknown; update: Uint8Array }) => {
    if (from === this.uid) {
      if (this.cacheTimeout) clearTimeout(this.cacheTimeout);

      this.cache = this.cache ? Y.mergeUpdates([this.cache, update]) : update;
      this.cacheUpdateCount++;

      if (this.cacheUpdateCount >= this.maxCacheUpdates) {
        // if the cache was already merged 20 times (this.maxCacheUpdates), send
        // the updates in cache to the peers
        this.sendCache(from);
      } else {
        // Wait to see if the user make other changes
        // if the user does not make changes for the next 500ms
        // send updates in cache to the peers
        this.cacheTimeout = setTimeout(() => {
          this.sendCache(from);
        }, this.maxRTCWait);
      }
    } else {
      // this update was from a peer, not this user
      this.sendDataToPeers({
        from,
        message: null,
        data: update,
      });
    }
  };

  updateHandler = (update: Uint8Array, origin: any) => {
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

  awarenessUpdateHandler = (
    {
      added,
      updated,
      removed,
    }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    const changedClients = added.concat(updated).concat(removed);
    this.sendDataToPeers({
      from: origin !== "local" ? origin : this.uid,
      message: "awareness",
      data: awarenessProtocol.encodeAwarenessUpdate(
        this.awareness,
        changedClients,
      ),
    });
  };

  flushOnHide = () => {
    if (!this.serverReady) return;
    if (this.firestoreTimeout || this.cache) {
      void this.saveToFirestore();
    }
  };

  onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      this.flushOnHide();
    } else if (document.visibilityState === "visible") {
      if (this.dataListenerPaused) {
        this.trackData();
      }
    }
  };

  onPageShow = () => {
    if (this.dataListenerPaused) {
      this.trackData();
    }
  };

  consoleHandler = (message: any, data: any = null) => {
    console.log(
      "Provider:",
      this.documentPath,
      `this client: ${this.uid}`,
      message,
      data,
    );
  };

  // use destroy directly if you don't need arguements
  // otherwise use kill
  destroy = () => {
    // we have to create a separate function here
    // because beforeunload only takes this.destroy
    // and not this.destroy() or with this.destroy(args)
    void this.kill();
  };

  async kill(keepReadOnly: boolean = false) {
    if (this.serverReady && (this.firestoreTimeout || this.cache)) {
      try {
        await this.saveToFirestore();
      } catch (error) {
        this.consoleHandler("kill: flush error", error);
      }
    }
    this.instanceConnection.destroy();
    removeEventListener("beforeunload", this.destroy);
    removeEventListener("pagehide", this.destroy);
    removeEventListener("visibilitychange", this.onVisibilityChange);
    removeEventListener("pageshow", this.onPageShow);
    if (this.recreateTimeout) clearTimeout(this.recreateTimeout);
    if (this.cacheTimeout) clearTimeout(this.cacheTimeout);
    if (this.firestoreTimeout) clearTimeout(this.firestoreTimeout);
    if (this.snapshotRetryTimeout) clearTimeout(this.snapshotRetryTimeout);
    if (this.meshRetryTimeout) clearTimeout(this.meshRetryTimeout);
    if (this.saveRetryTimeout) clearTimeout(this.saveRetryTimeout);
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
        Object.values(this.peersRTC.receivers).forEach((receiver) =>
          receiver.destroy(),
        );
      }
      if (this.peersRTC.senders) {
        Object.values(this.peersRTC.senders).forEach((sender) =>
          sender.destroy(),
        );
      }
    }
    this.ready = false;
    this.serverReady = false;
    super.destroy();
  }

  constructor({
    firebaseApp,
    ydoc,
    path,
    docMapper,
    maxUpdatesThreshold,
    maxWaitTime,
    maxWaitFirestoreTime,
    maxFirestoreDeferral,
    persistence,
    maxContentBytes,
    foldUpdateThreshold,
    foldBytesFraction,
    epochField,
  }: Parameters) {
    super();

    // Initializing values
    this.firebaseApp = firebaseApp;
    this.db = getFirestore(this.firebaseApp);
    this.doc = ydoc;
    this.documentPath = path;
    if (docMapper) this.documentMapper = docMapper;
    if (maxUpdatesThreshold) this.maxCacheUpdates = maxUpdatesThreshold;
    if (maxWaitTime) this.maxRTCWait = maxWaitTime;
    if (maxWaitFirestoreTime) this.maxFirestoreWait = maxWaitFirestoreTime;
    if (maxFirestoreDeferral) this.maxFirestoreDeferral = maxFirestoreDeferral;
    if (maxContentBytes) this.maxContentBytes = maxContentBytes;
    if (foldUpdateThreshold) this.foldUpdateThreshold = foldUpdateThreshold;
    if (foldBytesFraction) this.foldBytesFraction = foldBytesFraction;
    if (epochField) this.epochField = epochField;
    this.persistenceMode = persistence ?? "indexeddb";
    this.persistenceAdapter = createPersistenceAdapter(this.persistenceMode);
    this.awareness = new awarenessProtocol.Awareness(this.doc);

    // Initialize the provider
    const init = this.init();
  }
}
