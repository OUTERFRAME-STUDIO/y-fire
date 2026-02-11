import { FirebaseApp } from "@firebase/app";
import {
  getFirestore,
  Firestore,
  Unsubscribe,
  onSnapshot,
  doc,
  setDoc,
  Bytes,
} from "@firebase/firestore";
import { collection } from "firebase/firestore";
import * as Y from "yjs";
import { ObservableV2 } from "lib0/observable";
import * as awarenessProtocol from "y-protocols/awareness";
import { get as getLocal, set as setLocal, del as delLocal } from "idb-keyval";
import { deleteInstance, initiateInstance, refreshPeers } from "./utils";
import { WebRtc } from "./webrtc";
import { createGraph } from "./graph";

export interface Parameters {
  firebaseApp: FirebaseApp;
  ydoc: Y.Doc;
  path: string;
  docMapper?: (bytes: Bytes) => object;
  maxUpdatesThreshold?: number;
  maxWaitTime?: number;
  maxWaitFirestoreTime?: number;
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

  firebaseDataLastUpdatedAt: number = new Date().getTime();

  instanceConnection: ObservableV2<any> = new ObservableV2();
  recreateTimeout: string | number | NodeJS.Timeout;

  private unsubscribeData?: Unsubscribe;
  private unsubscribeMesh?: Unsubscribe;

  get clientTimeOffset() {
    return this.timeOffset;
  }

  ready: boolean = false;
  public onReady: () => void;
  public onDeleted: () => void;
  public onSaving: (status: boolean) => void;

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
      addEventListener("beforeunload", this.destroy); // destroy instance on window close
    } catch (error) {
      this.consoleHandler("Could not connect to a peer network.");
      // this.uid stays from previous session; update handler already attached above
    }
  };

  syncLocal = async () => {
    try {
      const local = await getLocal(this.documentPath);
      if (local) Y.applyUpdate(this.doc, local, { key: "local-sync" });
    } catch (e) {
      this.consoleHandler("get local error", e);
    }
  };

  saveToLocal = async () => {
    try {
      const currentDoc = Y.encodeStateAsUpdate(this.doc);
      setLocal(this.documentPath, currentDoc);
    } catch (e) {
      this.consoleHandler("set local error", e);
    }
  };

  deleteLocal = async () => {
    try {
      delLocal(this.documentPath);
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
    this.syncLocal(); // if there's any data in indexedDb, get and apply
  };

  trackData = () => {
    // Whenever there are changes to the firebase document
    // pull the changes and merge them to the current
    // yjs document
    if (this.unsubscribeData) this.unsubscribeData();
    this.unsubscribeData = onSnapshot(
      doc(this.db, this.documentPath),
      (doc) => {
        if (doc.exists()) {
          const data = doc.data();
          if (data && data.content) {
            const now = new Date().getTime();
            this.firebaseDataLastUpdatedAt = now;
            this.consoleHandler(
              "[Firestore save] trackData: firebaseDataLastUpdatedAt set to",
              { firebaseDataLastUpdatedAt: now }
            );
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
      },
      (error) => {
        this.consoleHandler("Firestore sync error", error);
        if (error.code === "permission-denied") {
          if (this.onDeleted) this.onDeleted();
        }
      }
    );
  };

  trackMesh = () => {
    if (this.unsubscribeMesh) this.unsubscribeMesh();
    this.unsubscribeMesh = onSnapshot(
      collection(this.db, `${this.documentPath}/instances`),
      (snapshot) => {
        this.clients = [];
        snapshot.forEach((doc) => {
          this.clients.push(doc.id);
        });
        const mesh = createGraph(this.clients);

        // a -> b, c; a is the sender and b, c are receivers
        const receivers: string[] = mesh[this.uid]; // this user's receivers
        const senders: string[] = Object.keys(mesh).filter(
          (v, i) => mesh[v] && mesh[v].length && mesh[v].includes(this.uid)
        ); // this user's senders

        this.peersReceivers = this.connectToPeers(
          receivers,
          this.peersReceivers,
          true
        );
        this.peersSenders = this.connectToPeers(
          senders,
          this.peersSenders,
          false
        );
      },
      (error) => {
        this.consoleHandler("Creating peer mesh error", error);
      }
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
          receiver.destroy()
        );
        this.peersRTC.receivers = {};
      }
      if (this.peersRTC.senders) {
        Object.values(this.peersRTC.senders).forEach((sender) =>
          sender.destroy()
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
    isCaller: boolean
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

  saveToFirestore = async () => {
    this.consoleHandler("[Firestore save] saveToFirestore: ENTRY", null);
    try {
      const ref = doc(this.db, this.documentPath);
      this.consoleHandler("[Firestore save] saveToFirestore: calling setDoc", {
        documentPath: this.documentPath,
      });
      await setDoc(
        ref,
        this.documentMapper(
          Bytes.fromUint8Array(Y.encodeStateAsUpdate(this.doc))
        ),
        { merge: true }
      );
      this.consoleHandler("[Firestore save] saveToFirestore: setDoc resolved", null);
      this.deleteLocal(); // We have successfully saved to Firestore, empty indexedDb for now
      this.consoleHandler("[Firestore save] saveToFirestore: deleteLocal done", null);
    } catch (error) {
      this.consoleHandler("[Firestore save] saveToFirestore: CAUGHT error", error);
    } finally {
      this.consoleHandler("[Firestore save] saveToFirestore: finally, calling onSaving(false)", null);
      if (this.onSaving) this.onSaving(false);
    }
  };

  sendToFirestoreQueue = () => {
    this.consoleHandler("[Firestore save] sendToFirestoreQueue: ENTRY", {
      firebaseDataLastUpdatedAt: this.firebaseDataLastUpdatedAt,
      maxFirestoreWait: this.maxFirestoreWait,
      hadExistingTimeout: !!this.firestoreTimeout,
    });
    if (this.firestoreTimeout) clearTimeout(this.firestoreTimeout);
    if (this.onSaving) this.onSaving(true);
    const scheduledAt = new Date().getTime();
    this.firestoreTimeout = setTimeout(() => {
      const now = new Date().getTime();
      const elapsedSinceLastFirebaseUpdate = now - this.firebaseDataLastUpdatedAt;
      const shouldSave =
        elapsedSinceLastFirebaseUpdate > this.maxFirestoreWait;
      this.consoleHandler(
        "[Firestore save] sendToFirestoreQueue: timeout fired",
        {
          now,
          firebaseDataLastUpdatedAt: this.firebaseDataLastUpdatedAt,
          elapsedSinceLastFirebaseUpdate,
          maxFirestoreWait: this.maxFirestoreWait,
          shouldSave,
          scheduledAt,
        }
      );
      if (shouldSave) {
        this.consoleHandler("[Firestore save] sendToFirestoreQueue: calling saveToFirestore", null);
        this.saveToFirestore();
      } else {
        this.consoleHandler(
          "[Firestore save] sendToFirestoreQueue: rescheduling (peer recently saved)",
          null
        );
        this.sendToFirestoreQueue();
      }
    }, this.maxFirestoreWait);
    this.consoleHandler("[Firestore save] sendToFirestoreQueue: scheduled timeout", {
      delayMs: this.maxFirestoreWait,
      firebaseDataLastUpdatedAt: this.firebaseDataLastUpdatedAt,
    });
  };

  sendCache = (from: string) => {
    this.consoleHandler("[Firestore save] sendCache: ENTRY", {
      from,
      cacheUpdateCount: this.cacheUpdateCount,
    });
    this.sendDataToPeers({
      from,
      message: null,
      data: this.cache,
    });
    this.cache = null;
    this.cacheUpdateCount = 0;
    this.consoleHandler("[Firestore save] sendCache: calling sendToFirestoreQueue", null);
    this.sendToFirestoreQueue();
  };

  sendToQueue = ({ from, update }: { from: unknown; update: Uint8Array }) => {
    if (from === this.uid) {
      this.consoleHandler("[Firestore save] sendToQueue: update from this user (will eventually trigger Firestore save)", {
        from,
        thisUid: this.uid,
        cacheUpdateCount: this.cacheUpdateCount + 1,
        maxCacheUpdates: this.maxCacheUpdates,
      });
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
    origin: unknown
  ) => {
    const changedClients = added.concat(updated).concat(removed);
    this.sendDataToPeers({
      from: origin !== "local" ? origin : this.uid,
      message: "awareness",
      data: awarenessProtocol.encodeAwarenessUpdate(
        this.awareness,
        changedClients
      ),
    });
  };

  consoleHandler = (message: any, data: any = null) => {
    console.log(
      "Provider:",
      this.documentPath,
      `this client: ${this.uid}`,
      message,
      data
    );
  };

  // use destroy directly if you don't need arguements
  // otherwise use kill
  destroy = () => {
    // we have to create a separate function here
    // because beforeunload only takes this.destroy
    // and not this.destroy() or with this.destroy(args)
    this.kill();
  };

  kill = (keepReadOnly: boolean = false) => {
    this.instanceConnection.destroy();
    removeEventListener("beforeunload", this.destroy);
    if (this.recreateTimeout) clearTimeout(this.recreateTimeout);
    if (this.cacheTimeout) clearTimeout(this.cacheTimeout);
    if (this.firestoreTimeout) clearTimeout(this.firestoreTimeout);
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
          receiver.destroy()
        );
      }
      if (this.peersRTC.senders) {
        Object.values(this.peersRTC.senders).forEach((sender) =>
          sender.destroy()
        );
      }
    }
    this.ready = false;
    super.destroy();
  };

  constructor({
    firebaseApp,
    ydoc,
    path,
    docMapper,
    maxUpdatesThreshold,
    maxWaitTime,
    maxWaitFirestoreTime,
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
    this.awareness = new awarenessProtocol.Awareness(this.doc);

    // Initialize the provider
    const init = this.init();
  }
}
