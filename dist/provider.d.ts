/// <reference types="node" />
import { FirebaseApp } from "@firebase/app";
import { Firestore, type Bytes } from "@firebase/firestore";
import * as Y from "yjs";
import { ObservableV2 } from "lib0/observable";
import * as awarenessProtocol from "y-protocols/awareness";
import { WebRtc } from "./webrtc";
import { PersistenceMode } from "./persistence";
import { type SnapshotStore } from "./append-store";
export type { SnapshotMeta, SnapshotStore } from "./append-store";
export type FireSaveReason = "save-failed" | "save-timeout" | "size-abort" | "size-warn" | "shrink" | "compact-required";
/** Default budget for `appendUpdate` / first-snapshot Firestore writes. */
export declare const DEFAULT_SAVE_TIMEOUT_MS = 15000;
export type FireSavePhase = "local-flush" | "encode" | "write";
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
/**
 * The doc listener reported the shard as missing from the server
 * (`exists() === false`, `fromCache === false`) and a direct server read
 * disagreed or failed (DEV-421). A stale Firestore cache entry causes it.
 * - `listener-missing-doc-exists`: the doc exists; hydrated from that read.
 * - `missing-verify-failed`: the read failed; not server-ready, retrying.
 */
export interface SnapshotAnomalyEvent {
    documentPath: string;
    kind: "listener-missing-doc-exists" | "missing-verify-failed";
}
/** Synchronous main-thread work the provider does on a shard. */
export type MainThreadWorkPhase = 
/** Full-doc encode for the IndexedDB copy. */
"local-encode"
/** Full-doc encode for a snapshot write or a fold. */
 | "full-encode"
/** Re-encode of a near-cap full encode through a fresh doc (DEV-137). */
 | "collect-encode"
/** Delta encode for an `updates/*` append. */
 | "delta-encode"
/** Applying Firestore bytes, including the doc's observers. */
 | "remote-apply";
export interface MainThreadWorkEvent {
    documentPath: string;
    phase: MainThreadWorkPhase;
    ms: number;
    bytes: number;
}
/**
 * Firestore bytes threw while being applied to the doc. Usually a Y observer
 * of the host (an editor binding) threw after Yjs integrated the bytes
 * (`integrated: true`): the doc is current, only the observer missed it.
 * `integrated: false` means the bytes did not apply (malformed update).
 * The provider keeps going either way and does not resubscribe.
 */
export interface RemoteApplyErrorEvent {
    documentPath: string;
    /** `update`: an `updates/*` doc; `snapshot`: the snapshot or inline `content`. */
    source: "update" | "snapshot";
    /** The `updates/*` doc id when `source` is `update`. */
    updateId?: string;
    integrated: boolean;
    error: unknown;
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
    /**
     * Max milliseconds to wait for `appendUpdate` / first-snapshot writes
     * (default 15s). On timeout the provider reports `save-timeout` and
     * retries; the underlying Firestore write is not aborted.
     */
    saveTimeoutMs?: number;
    /**
     * Optional external snapshot blob store. When set, the provider does not
     * read or write Firestore `content` Bytes; snapshots live in the store and
     * the shard doc holds metadata only. WAL `updates/*` is unchanged.
     */
    snapshotStore?: SnapshotStore;
    /**
     * Called after each encode or remote apply with its duration, so a host
     * can log the work that blocks the main thread on large shards.
     */
    onMainThreadWork?: (event: MainThreadWorkEvent) => void;
}
interface PeersRTC {
    receivers: {
        [key: string]: WebRtc;
    };
    senders: {
        [key: string]: WebRtc;
    };
}
/** Trailing debounce for full-doc IndexedDB encodes after local updates. */
export declare const LOCAL_PERSIST_DEBOUNCE_MS = 500;
/**
 * Delay before caching remote (Firestore / peer) updates in IndexedDB. The
 * server already holds them, so the local copy only warms the next open;
 * each save is a full-doc encode on the main thread, which on a multi-MB
 * shard costs hundreds of ms per remote update (DEV-358). A local edit or a
 * hide / kill flush still saves them sooner.
 */
export declare const REMOTE_LOCAL_PERSIST_DELAY_MS = 10000;
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
export declare class FireProvider extends ObservableV2<any> {
    readonly doc: Y.Doc;
    awareness: awarenessProtocol.Awareness;
    readonly documentPath: string;
    readonly firebaseApp: FirebaseApp;
    readonly db: Firestore;
    uid: string;
    timeOffset: number;
    clients: string[];
    peersReceivers: Set<string>;
    peersSenders: Set<string>;
    peersRTC: PeersRTC;
    documentMapper: (bytes: Bytes) => object;
    cache: Uint8Array | null;
    maxCacheUpdates: number;
    cacheUpdateCount: number;
    cacheTimeout: string | number | NodeJS.Timeout;
    maxRTCWait: number;
    firestoreTimeout: string | number | NodeJS.Timeout;
    maxFirestoreWait: number;
    maxFirestoreDeferral: number;
    maxContentBytes: number;
    scheduledFirstAt?: number;
    saveTimeoutMs: number;
    saveInFlight: boolean;
    saveStartedAt?: number;
    savePhase?: FireSavePhase;
    saveWriteStartedAt?: number;
    lastLocalFlushMs: number | null;
    lastEncodeMs: number | null;
    lastLocalEncodeMs: number | null;
    onMainThreadWork?: (event: MainThreadWorkEvent) => void;
    /**
     * Called when Firestore bytes throw while being applied (DEV-455). When
     * unset the error is logged through `consoleHandler`.
     */
    onRemoteApplyError?: (event: RemoteApplyErrorEvent) => void;
    lastSaveDurationMs: number | null;
    private saveQueued;
    firebaseDataLastUpdatedAt: number;
    instanceConnection: ObservableV2<any>;
    recreateTimeout: string | number | NodeJS.Timeout;
    private unsubscribeData?;
    private unsubscribeMesh?;
    private persistenceAdapter;
    private persistenceMode;
    private snapshotRetryAttempt;
    private hydrateRetryAttempt;
    private meshRetryAttempt;
    private snapshotRetryTimeout?;
    private meshRetryTimeout?;
    private saveRetryTimeout?;
    private localPersistTimeout?;
    private localPersistDueAt?;
    /** Doc content not yet written to IndexedDB. */
    private localSaveDirty;
    /** A local edit (not a remote update) is among the unsaved content. */
    private localEditUnsaved;
    private dataListenerPaused;
    private pendingSyncLocal;
    private lastPersistedSV?;
    /**
     * Deletions made outside a Firestore apply (local edits, peers, IndexedDB)
     * that no successful write has carried yet. Appends ship these instead of
     * the doc's whole delete set (DEV-356).
     */
    private unpersistedDeletes;
    private lastSnapshotFromCache;
    private hasRemoteContent;
    private hydratedEpoch?;
    /** Latest epoch field value seen by the shard listener, including a replace. */
    private latestObservedEpoch?;
    private epochReplaced;
    private appliedUpdateIds;
    private lastSeq;
    private docServerSnapshot;
    private updatesServerSnapshot;
    private foldUpdateThreshold;
    private foldBytesFraction;
    private epochField;
    private updateDocCount;
    private updateTotalBytes;
    private listedUpdates;
    private foldInFlight;
    private foldQueued;
    private foldBackoffUntil?;
    private foldAbortedAtSnapshotSV?;
    private foldAbortReported;
    private updatesAccessDenied;
    private updatesDeniedWarned;
    private lastUpdatesSnapshot?;
    private snapshotStore?;
    private snapshotHydrateGen;
    get clientTimeOffset(): number;
    ready: boolean;
    serverReady: boolean;
    onReady: () => void;
    onServerReady: () => void;
    onDeleted: () => void;
    onSaving: (status: boolean) => void;
    onSaveError: (error: unknown, ctx: FireSaveContext) => void;
    onSaveWarning: (ctx: FireSaveContext) => void;
    onEpochReplace: (event: EpochReplaceEvent) => void;
    onSnapshotAnomaly: (event: SnapshotAnomalyEvent) => void;
    init: () => Promise<void>;
    syncLocal: () => Promise<void>;
    saveToLocal: () => Promise<void>;
    private clearLocalPersistTimer;
    /**
     * Local edits keep the trailing {@link LOCAL_PERSIST_DEBOUNCE_MS}
     * debounce. Remote updates wait {@link REMOTE_LOCAL_PERSIST_DELAY_MS} and
     * never push back a save that is already due sooner.
     */
    private scheduleSaveToLocal;
    /**
     * Write unsaved content to IndexedDB now. A no-op when nothing changed
     * since the last local save: every Firestore save flushes first, and a
     * second full-doc encode of an unchanged doc is pure main-thread cost
     * (DEV-358). `localEditsOnly` skips content that is only remote updates.
     */
    flushSaveToLocal: (options?: {
        localEditsOnly?: boolean;
    }) => Promise<void>;
    deleteLocal: () => Promise<void>;
    initiateHandler: () => void;
    private scheduleSnapshotRetry;
    private scheduleHydrateRetry;
    private scheduleMeshRetry;
    private maybeBecomeServerReady;
    private reportWork;
    private applyRemoteUpdateBytes;
    /**
     * Apply Firestore bytes. A throw is either a host observer failing after
     * Yjs integrated the bytes, or bytes Yjs cannot decode. Neither is a
     * Firestore failure, so report it and return whether the doc now holds
     * the bytes instead of rethrowing into the listener (DEV-455).
     */
    private applyFirestoreBytes;
    /**
     * Snapshot bytes that did not apply leave the replica without its base:
     * throw so the doc listener retries with backoff. An observer error after
     * the bytes integrated is only reported.
     */
    private applySnapshotBytes;
    private reportRemoteApplyError;
    private enterEpochReplace;
    /**
     * Server epoch when it is strictly newer than this replica's hydrate.
     * `null` means the epoch did not advance, or the server read failed —
     * the caller must rethrow the original append error.
     */
    private epochAdvancedOnServer;
    /**
     * Refuse Firestore content/update writes until a server snapshot has
     * pinned an epoch, and stop once this replica has been replaced.
     * A newer epoch observed by the doc listener takes the replace path
     * before any write.
     */
    private assertCanWriteFirestore;
    private replayObservedUpdates;
    private consumeUpdatesSnapshot;
    trackData: () => void;
    /**
     * Read the shard doc from the server, bypassing the persistent cache and
     * the listen target. `getDocFromServer` listens on the same target as
     * {@link trackData}, so a stale "missing" entry answers it too; a
     * transaction read goes to the backend directly. The read is kept when
     * only the commit fails (it verifies the read doc, which a read-only
     * user may be refused). `null` when nothing was read.
     */
    private readShardDocFromServer;
    private reportSnapshotAnomaly;
    private handleDocSnapshot;
    /**
     * Apply remote snapshot bytes. Returns false when a storage read failed
     * (retry scheduled) or a newer snapshot superseded this one.
     */
    private applyRemoteSnapshot;
    /**
     * Apply the inline `content` snapshot. `besideStore`: the shard also has a
     * Storage snapshot, so `snapshotSV` describes that one and cannot vouch for
     * these bytes (a replica without the store folded them there, DEV-353).
     * Apply them unconditionally: the merge is idempotent, and a state vector
     * cannot show a delete-only change. The next store fold removes them.
     */
    private applyInlineContent;
    trackMesh: () => void;
    reconnect: () => void;
    trackConnections: () => Promise<void>;
    connectToPeers: (newPeers: string[], oldPeers: Set<string>, isCaller: boolean) => Set<any>;
    sendDataToPeers: ({ from, message, data, }: {
        from: unknown;
        message: unknown;
        data: Uint8Array | null;
    }) => void;
    private saveContext;
    private scheduleSaveRetry;
    /**
     * Race a Firestore write against {@link saveTimeoutMs}. On timeout the
     * underlying promise is left running (Firestore cannot cancel `addDoc`);
     * a dangling `.then` swallows the late result so `lastPersistedSV` /
     * `lastSeq` stay with the caller that already threw.
     */
    private awaitWithSaveTimeout;
    /**
     * Adopt snapshot bytes that already live off-Firestore (client Storage
     * fallback after an empty hydrate). Applies as a remote update so the
     * pack is not queued as a local first-write, and advances
     * `lastPersistedSV` so the next save is a small `updates/*` delta.
     */
    adoptPersistedSnapshot: (bytes: Uint8Array) => void;
    saveToFirestore: () => Promise<void>;
    private abortSize;
    private clearFoldBackoff;
    private beginFoldBackoff;
    private shouldSkipFold;
    private emitCompactRequired;
    private applyFoldSuccess;
    private writeForcedSnapshot;
    private writeFirstSnapshot;
    /** Full-state encode, timed into {@link lastEncodeMs}. */
    private encodeFullState;
    /**
     * `localUpdate` without the text of deleted items this doc still keeps
     * (DEV-137). An UndoManager keeps deleted items so it can restore them, so
     * a long editing session carries every pasted-then-deleted block in the full
     * encode. A fresh doc garbage-collects them on apply. Only paid when the raw
     * encode is near the Firestore cap, and never for a snapshotStore shard.
     */
    private collectFullState;
    /** Returns true when the append landed and a fold may be due. */
    private appendDelta;
    private scheduleFold;
    private maybeFold;
    sendToFirestoreQueue: () => void;
    sendCache: (from: string) => void;
    sendToQueue: ({ from, update }: {
        from: unknown;
        update: Uint8Array;
    }) => void;
    private trackDeletes;
    /** Copy of {@link unpersistedDeletes}, taken when a write encodes the doc. */
    private snapshotUnpersistedDeletes;
    /** A write carrying `sent` landed: those deletions are persisted. */
    private markDeletesPersisted;
    updateHandler: (update: Uint8Array, origin: any) => void;
    awarenessUpdateHandler: ({ added, updated, removed, }: {
        added: number[];
        updated: number[];
        removed: number[];
    }, origin: unknown) => void;
    flushOnHide: () => void;
    onVisibilityChange: () => void;
    onPageShow: () => void;
    consoleHandler: (message: any, data?: any) => void;
    destroy: () => void;
    kill(keepReadOnly?: boolean): Promise<void>;
    constructor({ firebaseApp, ydoc, path, docMapper, maxUpdatesThreshold, maxWaitTime, maxWaitFirestoreTime, maxFirestoreDeferral, persistence, maxContentBytes, foldUpdateThreshold, foldBytesFraction, epochField, saveTimeoutMs, snapshotStore, onMainThreadWork, }: Parameters);
}
//# sourceMappingURL=provider.d.ts.map