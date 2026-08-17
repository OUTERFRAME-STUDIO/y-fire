# y-fire

A database and connection provider for Yjs based on Firestore.

y-fire is a Firestore (Firebase) and WebRTC-based provider, built especially for serverless infrastructure, that offers real-time capabilities to your Yjs-based applications. y-fire is built with efficiency in mind to reduce the number of calls that the application makes to and from Firestore. With y-fire, Firestore will act as both 1. persistent storage and 2. a peer discovery platform for WebRTC connections. This means that real-time updates are shared through a peer-to-peer network, thus reducing connections to Firestore. y-fire was inspired by [yjs-firestore-provider](https://github.com/gmcfall/yjs-firestore-provider) but implements few things differently.

https://github.com/podraven/y-fire/assets/2324523/3aa27a40-6cfb-4b93-b043-4e0fa57c96d4

# Features

1. Utilizes a peer-to-peer network to exchange real-time data and awareness.
2. Utilizes Firestore as persistent storage and syncs with Firestore periodically to maintain persistent data state. Each shard document stores a compacted Yjs **snapshot** in `content` plus an append-only `updates/*` subcollection of small deltas. A flush writes one small update document (do not flush per keystroke — the existing debounce still applies). After each successful append, `lastPersistedSV` is advanced from the document state vector captured at encode time (and remote updates merge an exact per-client `max(clock + length)` from `Y.decodeUpdate` structs, ignoring `Skip`). Do **not** use `Y.encodeStateVectorFromUpdate` for deltas: it drops any client whose structs do not start at clock 0, which would re-encode the whole post-snapshot tail on every flush. A **fold** rewrites `content` to the union of the snapshot, the update docs that were read, and local state, then deletes only those read ids. Fold does **not** bump `contentGeneration` (the epoch): a fold snapshot is a strict superset, so peers apply it as a normal Yjs update. The epoch is reserved for compact/replace, where the new bytes are not a superset. `{ merge: true }` only merges Firestore *fields* — it does not merge CRDT state by itself. Applying `updates/*` in any order converges (`Y.applyUpdate` buffers missing deps); `seq` is for fold windows and debugging only.
3. Utilizes Firestore as a peer discovery platform. Once peers are connected to each other, real-time updates are shared without accessing Firestore, thus reducing costs.
4. Instead of connecting all peers to each other, y-fire creates clusters of clients. Clients within a cluster are connected to each other, and clusters are connected to each other through one common client. If clients leave or new clients join, clusters are recreated. Limiting client connections to limited number of peers thus improves performance. (Discussion: [WebRTC: peer connections limit](https://stackoverflow.com/questions/16015304/webrtc-peer-connections-limit))
5. You can set wait times and thresholds.

# Installation

#### Prerequisites:

Make sure you have the following dependencies already installed in your project (skip the following steps if you already have these installed):

```
npm install yjs firebase --save
```

Some editor bindings, including `y-prosemirror`, `TipTap`, and `y-quill`, have an explicit dependency on the `y-protocols` module. If you are using one of these bindings, you don't need to install `y-protocols` separately.

```
npm install y-protocols --save
```

#### Install y-fire

Once you have installed all the dependencies, you can install the `y-fire` library:

```
npm install y-fire --save
```

[![npm version](https://badge.fury.io/js/y-fire.svg)](https://npmjs.org/y-fire)

# Usage

```
import * as Y from "yjs";
import { FireProvider } from "y-fire";
import { app } from "path-to-firebase-client";  // ex. app = initializeApp(config)

export const yProvider = (documentPath) => {
  const firebaseApp = app;
  const ydoc = new Y.Doc();
  return new FireProvider({ firebaseApp, ydoc, path: documentPath });
};
```

Tiptap example:

```
const provider = yProvider("path/to/your/firestore/document");

provider.onReady = () => {
  // cache or server snapshot exists
};
provider.onServerReady = () => {
  // safe to seed / flush; the shard doc has a server snapshot, and either
  // the updates collection has too or updates/ access was denied (degraded)
};
provider.onEpochReplace = ({ from, to }) => {
  // compact/replace landed; remount a fresh Y.Doc instead of unioning
};
provider.onDeleted = () => {
  // do something
};
provider.onSaving = (status) => {
  // do something
};
provider.onSaveError = (error, ctx) => {
  // persist failed — keep unsaved UI
};

...

const editor = new Editor({
  extensions: [
    StarterKit.configure({
      // The Collaboration extension comes with its own history handling
      history: false,
    }),
    // Register the document with Tiptap
    Collaboration.configure({
      document: provider.doc,
    })
    // Register the collaboration cursor extension
    CollaborationCursor.configure({
        provider,
        user: {
            name: "username",
            color: "some color"	// color implementation based on username?
        }
    })
  ],
})
```

# Firestore layout

```
{documentPath}                         // e.g. projects/{pid}/shards/{docId}
  content            Bytes             // compacted snapshot
  contentGeneration  number            // epoch; bumped ONLY on replacement
  snapshotSV         Bytes             // state vector of `content`
  updatedAt          timestamp
{documentPath}/updates/{autoId}
  update             Bytes             // Y.encodeStateAsUpdate(doc, lastPersistedSV)
  seq                number            // debug / fold window only
  clientId           string?           // omitted when the WebRTC uid is not yet known
  createdAt          timestamp
{documentPath}/instances/*             // WebRTC signaling, unchanged
```

Hydrate = apply `content`, then every `updates/*` doc (order-independent). The first write on a shard with no `content` writes the snapshot directly so older readers keep working. After that, each debounced flush appends one update document. Fold **decision** uses the live `updates` listener (doc count and total bytes) — a normal append does not `getDocs` the collection. When count ≥ `foldUpdateThreshold` (default 20) or total update bytes ≥ `foldBytesFraction` of the 1 MiB cap (default 0.5), the client folds: `getDocs(updates)` only for that fold, then a transaction writes `content = union(server content, local doc, read update bytes)` and deletes **only** the ids that were read. Concurrent appends that land during the fold are left in place and replay harmlessly. Empty deltas are skipped. A delta above 1 MiB does **not** abort: the client force-folds a union snapshot instead (including when `updates/` is empty). If that union also exceeds 1 MiB, the provider reports `compact-required` once, backs off further fold attempts (appends keep flowing), and the shard needs DEV-66 compaction. `size-warn` (≥ 70% of the cap) applies to snapshot and fold writes only, not to a large-but-under-cap delta.

`serverReady` normally waits until **both** the shard-document listener **and** the `updates` collection listener have delivered a non-cache snapshot, so a flush cannot append before remote deltas are known. If the `updates` listener is `permission-denied`, the provider does **not** treat the shard as deleted: it reaches `serverReady` from the document listener alone, warns once, and degrades to full-snapshot writes until `updates/` is readable again.

IndexedDB keeps the full local snapshot at `documentPath` plus a sibling `{documentPath}#meta` record holding the epoch. Full-doc `encodeStateAsUpdate` + `setLocal` is trailing-debounced at 500 ms (`LOCAL_PERSIST_DEBOUNCE_MS`) so typing does not rewrite the whole blob on every keystroke. Hide, destroy, and Firestore save flush immediately (the local-only crash window is at most 500 ms, smaller than the 3 s Firestore debounce). After a replacement that happened while the tab was closed, the stale local copy is dropped instead of unioned.

# Firestore rules

You need to grant **read and write** permissions to the document `/path/to/your/document` and its children `/path/to/your/document/{document=**}` for this module to function properly. y-fire reads and writes the `content` / `contentGeneration` / `snapshotSV` fields and the `updates/*` subcollection, and creates `instances/*` documents for peer discovery. Editors must be allowed to create and delete `updates/*` documents (append + fold).

# APIs

#### Configuration

- **firebaseApp**: FirebaseApp (required)
- **ydoc**: Y.Doc (required)
- **path**: path to your **document** (required) ex. users/username/tasks/task-1
- **docMapper**: Custom structure for your document (saves to the `content` field by default)
- **maxUpdatesThreshold**: Number of updates before triggering real-time data share, defaults to 20
- **maxWaitTime**: Time in milliseconds before triggering real-time data share, defaults to 100
- **maxWaitFirestoreTime**: Time in milliseconds before triggering persistent data sync to Firestore, defaults to 3000
- **foldUpdateThreshold**: Number of `updates/*` docs before folding them into `content`, defaults to 20
- **foldBytesFraction**: Fold when total update bytes reach this fraction of the content cap, defaults to 0.5
- **epochField**: Firestore field used as the replacement epoch, defaults to `contentGeneration`

Example:

```
new FireProvider({
  firebaseApp,
  ydoc,
  path: "username/tasks/taskuid",
  maxUpdatesThreshold: 10,
  maxWaitTime: 90,
  maxWaitFirestoreTime: 500
});
```

docMapper example with custom document structure

```
new FireProvider({
  firebaseApp,
  ydoc,
  path: "username/tasks/taskuid",
  docMapper: (bytes) => ({
    title: "Custom title",
    file: { filename: "file.docx", content: bytes },  // "bytes" contains your yjs data
  }),
});
```

#### Methods

- **destroy**: Destroys the y-fire instance. You may want to destroy the y-fire instance when navigating out of the page to avoid the initialization of duplicate instances. Use `provider.destroy();` to destroy the instance.
- ~~**destroyHandler**: Destroys the y-fire instance. You may want to destroy the y-fire instance when navigating out of the page to avoid the initialization of duplicate instances. Use `provider.destroyHandler();` to destroy the instance.~~ (Replaced with **destroy**)

#### Events

- **onReady**: Triggered after the first snapshot in which the Firestore document `exists()` (may be the persistent cache).
- **onServerReady**: Triggered once the shard document has delivered a snapshot with `metadata.fromCache === false`. The `updates` collection must also have a server snapshot **unless** that listener failed with `permission-denied` (degraded mode: snapshot writes, not treated as deleted). IndexedDB `syncLocal` and hide/unload flushes wait for this.
- **onEpochReplace**: Triggered when `contentGeneration` (or `epochField`) on the shard document is higher than the epoch this provider hydrated with. The new `content` is **not** applied (it is not a superset). The provider stops writing, drops IndexedDB, and the host should remount a fresh `Y.Doc`. Equal or absent epoch → apply `content` as a normal Yjs update. Re-applying `content` is skipped when `snapshotSV` is already covered by the last persisted state vector.
- **onDeleted**: Triggered if the instance was deleted (e.g., no permission to read/write the **document**). A `permission-denied` error on the `updates` collection does **not** fire this — the provider degrades to snapshot writes instead.
- **onSaving**: Triggered when the sync to Firestore is in process (e.g., you may want to alert users not to close the window). `onSaving(false)` runs only after a **successful** write.
- **onSaveError**: Triggered when an append/snapshot write fails (`save-failed`), a first snapshot exceeds 1 MiB (`size-abort`), or a fold/forced-snapshot union exceeds 1 MiB (`compact-required`, once per episode). `compact-required` does not block later appends that still fit; the shard needs compaction. The UI should treat this as unsaved; y-fire retries failed network writes and never falls back to last-write-wins `setDoc`.
- **onSaveWarning**: Triggered when a snapshot or fold write is ≥ 70% of 1 MiB (`size-warn`). Large deltas under the cap do not warn.

Example:

```
provider.onReady = () => {
  // do something
};
```

[1.1]: http://i.imgur.com/wWzX9uB.png "twitter icon without padding"

# Contributors

Made possible by **[Pod Raven](https://podraven.com)**, with special contributions from: **[deathg0d](https://github.com/deathg0d)**, **[dorkysamurai](https://github.com/lachana)**, **[arbitraryvector](https://x.com/arbitraryvector)**

##### Follow Us

- [![alt text][1.1] @pod_raven](https://x.com/pod_raven)
- [![alt text][1.1] @arbitraryvector](https://x.com/arbitraryvector)

# Licensing and Attribution

This module is licensed under the MIT License. You are generally free to reuse or extend upon this code as you see fit. Just include copies of the [y-fire](https://github.com/podraven/y-fire/blob/main/LICENSE) license.
