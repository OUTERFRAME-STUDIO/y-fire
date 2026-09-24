/// <reference types="node" />
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import { FirebaseApp } from "@firebase/app";
import { Firestore } from "@firebase/firestore";
import { ObservableV2 } from "lib0/observable";
import SimplePeer from "simple-peer-light";
interface Parameters {
    firebaseApp: FirebaseApp;
    ydoc: Y.Doc;
    awareness: awarenessProtocol.Awareness;
    instanceConnection: ObservableV2<any>;
    documentPath: string;
    uid: string;
    peerUid: string;
    isCaller: boolean;
    /** Sender/receiver epoch. Absent until the provider has hydrated. */
    localEpoch?: () => number | undefined;
}
/**
 * Numeric epochs must match. Payloads with no epoch are legacy peers and
 * still apply. A numeric epoch with no local epoch yet does not match.
 */
export declare function shouldApplyPeerUpdate(remoteEpoch: unknown, localEpoch: number | undefined): boolean;
export declare function applyPeerYjsUpdate(doc: Y.Doc, update: Uint8Array, origin: unknown, remoteEpoch: unknown, localEpoch: number | undefined): boolean;
export declare class WebRtc extends ObservableV2<any> {
    readonly doc: Y.Doc;
    awareness: awarenessProtocol.Awareness;
    instanceConnection: ObservableV2<any>;
    readonly documentPath: string;
    uid: string;
    peerUid: string;
    peer: SimplePeer.Instance;
    readonly db: Firestore;
    private unsubscribeHandshake?;
    isCaller: boolean;
    ice: {
        iceServers: {
            urls: string;
        }[];
    };
    peerKey: CryptoKey;
    localEpoch: () => number | undefined;
    connection: string;
    clock: string | number | NodeJS.Timeout;
    idleThreshold: number;
    constructor({ firebaseApp, ydoc, awareness, instanceConnection, documentPath, uid, peerUid, isCaller, localEpoch, }: Parameters);
    initPeer: () => void;
    startInitClock: () => void;
    createKey: () => Promise<void>;
    createPeer: (config: {
        initiator: boolean;
        config: {
            iceServers: {
                urls: string;
            }[];
        };
        trickle: boolean;
        channelName?: string;
    }) => void;
    callPeer: () => void;
    replyPeer: () => void;
    handshake: () => void;
    unsubHandshake: () => void;
    connect: (signal: SimplePeer.SignalData) => void;
    deleteSignals: () => void;
    handleOnConnected: () => void;
    handleOnClose: () => void;
    sendData: ({ message, data, epoch, }: {
        message: unknown;
        data: Uint8Array | null;
        epoch?: number;
    }) => Promise<void>;
    handleReceivingData: (data: any) => Promise<void>;
    consoleHandler: (message: any, data?: any) => void;
    errorHandler: (error: any) => void;
    destroy(): Promise<void>;
}
export {};
//# sourceMappingURL=webrtc.d.ts.map