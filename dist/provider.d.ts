/// <reference types="node" />
import { FirebaseApp } from "@firebase/app";
import { Firestore, Bytes } from "@firebase/firestore";
import * as Y from "yjs";
import { ObservableV2 } from "lib0/observable";
import * as awarenessProtocol from "y-protocols/awareness";
import { WebRtc } from "./webrtc";
import { PersistenceMode } from "./persistence";
export type FireSaveReason = "save-failed" | "size-abort" | "size-warn" | "shrink";
export interface FireSaveContext {
    documentPath: string;
    byteLength: number;
    code?: string;
    fromCache: boolean;
    ready: boolean;
    serverReady: boolean;
    reason: FireSaveReason;
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
}
interface PeersRTC {
    receivers: {
        [key: string]: WebRtc;
    };
    senders: {
        [key: string]: WebRtc;
    };
}
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
    firebaseDataLastUpdatedAt: number;
    instanceConnection: ObservableV2<any>;
    recreateTimeout: string | number | NodeJS.Timeout;
    private unsubscribeData?;
    private unsubscribeMesh?;
    private persistenceAdapter;
    private persistenceMode;
    private snapshotRetryAttempt;
    private meshRetryAttempt;
    private snapshotRetryTimeout?;
    private meshRetryTimeout?;
    private saveRetryTimeout?;
    private dataListenerPaused;
    private pendingSyncLocal;
    private lastServerStateVector?;
    private lastSnapshotFromCache;
    get clientTimeOffset(): number;
    ready: boolean;
    serverReady: boolean;
    onReady: () => void;
    onServerReady: () => void;
    onDeleted: () => void;
    onSaving: (status: boolean) => void;
    onSaveError: (error: unknown, ctx: FireSaveContext) => void;
    onSaveWarning: (ctx: FireSaveContext) => void;
    init: () => Promise<void>;
    syncLocal: () => Promise<void>;
    saveToLocal: () => Promise<void>;
    deleteLocal: () => Promise<void>;
    initiateHandler: () => void;
    private scheduleSnapshotRetry;
    private scheduleMeshRetry;
    trackData: () => void;
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
    saveToFirestore: () => Promise<void>;
    sendToFirestoreQueue: () => void;
    sendCache: (from: string) => void;
    sendToQueue: ({ from, update }: {
        from: unknown;
        update: Uint8Array;
    }) => void;
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
    constructor({ firebaseApp, ydoc, path, docMapper, maxUpdatesThreshold, maxWaitTime, maxWaitFirestoreTime, maxFirestoreDeferral, persistence, maxContentBytes, }: Parameters);
}
export {};
//# sourceMappingURL=provider.d.ts.map