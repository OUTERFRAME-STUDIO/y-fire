import { vi } from "vitest";
import * as Y from "yjs";
import type { FirebaseApp } from "@firebase/app";
import {
  emitSnapshot,
  emitUpdatesSnapshot,
  resetFirestoreMock,
  seedFirestoreContent,
  seedFirestoreShard,
  seedFirestoreUpdate,
  updatesPath,
} from "./_mocks/firestore";
import { resetIdbMock } from "./_mocks/idb";

vi.mock("@firebase/firestore", async () => {
  const mock = await import("./_mocks/firestore");
  return mock;
});

vi.mock("firebase/firestore", async () => {
  const mock = await import("./_mocks/firestore");
  return { collection: mock.collection };
});

vi.mock("idb-keyval", async () => {
  const mock = await import("./_mocks/idb");
  return mock;
});

vi.mock("../utils", () => ({
  initiateInstance: vi.fn(async () => ({ uid: "test-uid", offset: 0 })),
  deleteInstance: vi.fn(async () => {}),
  refreshPeers: vi.fn((newPeers: string[]) => ({
    new: newPeers,
    obselete: [],
  })),
}));

vi.mock("../webrtc", () => ({
  WebRtc: vi.fn(function WebRtcMock() {
    return {
      destroy: vi.fn(),
      sendData: vi.fn(),
      connection: "open",
    };
  }),
}));

vi.mock("../graph", () => ({
  createGraph: vi.fn(() => ({})),
}));

import { FireProvider } from "../provider";
import type { Parameters } from "../provider";

const TEST_PATH = "projects/test/doc";

export async function createTestProvider(
  overrides: Partial<Parameters> = {},
) {
  resetFirestoreMock();
  resetIdbMock();

  const ydoc = overrides.ydoc ?? new Y.Doc();
  const provider = new FireProvider({
    firebaseApp: {} as FirebaseApp,
    path: TEST_PATH,
    maxWaitTime: 10,
    ...overrides,
    ydoc,
  });

  await flushMicrotasks();
  return { provider, ydoc, path: TEST_PATH };
}

export async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

export function emitEmptyDocSnapshot(path: string) {
  emitSnapshot(path, {
    exists: () => true,
    data: () => ({}),
    metadata: { fromCache: false, hasPendingWrites: false },
  });
  emitUpdatesSnapshot(path, { fromCache: false, hasPendingWrites: false });
}

export function emitRemoteUpdate(path: string, content: Uint8Array) {
  emitServerUpdate(path, content);
}

export function emitCacheUpdate(
  path: string,
  content: Uint8Array,
  extra?: { epoch?: number; snapshotSV?: Uint8Array },
) {
  emitSnapshot(path, {
    exists: () => true,
    data: () => shardData(content, extra),
    metadata: { fromCache: true, hasPendingWrites: false },
  });
  emitUpdatesSnapshot(path, { fromCache: true, hasPendingWrites: false });
}

function shardData(
  content: Uint8Array,
  extra?: { epoch?: number; snapshotSV?: Uint8Array },
) {
  const data: Record<string, unknown> = {
    content: {
      toUint8Array: () => content,
    },
  };
  if (extra?.epoch !== undefined) {
    data.contentGeneration = extra.epoch;
  }
  if (extra?.snapshotSV) {
    data.snapshotSV = {
      toUint8Array: () => extra.snapshotSV,
    };
  }
  return data;
}

export function emitServerUpdate(
  path: string,
  content: Uint8Array,
  extra?: { epoch?: number; snapshotSV?: Uint8Array; emitUpdates?: boolean },
) {
  seedFirestoreShard(path, content, extra);
  emitSnapshot(path, {
    exists: () => true,
    data: () => shardData(content, extra),
    metadata: { fromCache: false, hasPendingWrites: false },
  });
  if (extra?.emitUpdates !== false) {
    emitUpdatesSnapshot(path, { fromCache: false, hasPendingWrites: false });
  }
}

export function emitDocSnapshotOnly(
  path: string,
  content: Uint8Array,
  extra?: { epoch?: number; snapshotSV?: Uint8Array; fromCache?: boolean },
) {
  seedFirestoreShard(path, content, extra);
  emitSnapshot(path, {
    exists: () => true,
    data: () => shardData(content, extra),
    metadata: {
      fromCache: extra?.fromCache === true,
      hasPendingWrites: false,
    },
  });
}

export async function emitServerMissing(path: string) {
  emitSnapshot(path, {
    exists: () => false,
    data: () => undefined,
    metadata: { fromCache: false, hasPendingWrites: false },
  });
  emitUpdatesSnapshot(path, { fromCache: false, hasPendingWrites: false });
  await flushMicrotasks();
}

export async function markServerReady(path: string) {
  await emitServerMissing(path);
}

export function emitEmptyMeshSnapshot(path: string) {
  emitSnapshot(path, {
    exists: () => true,
    data: () => ({}),
    forEach: () => {},
  });
}

export function decodeSavedDoc(saved: unknown): Y.Doc {
  const data = saved as { content: { toUint8Array: () => Uint8Array } };
  const doc = new Y.Doc();
  Y.applyUpdate(doc, data.content.toUint8Array());
  return doc;
}

export function decodeUpdateBytes(saved: unknown): Uint8Array {
  const data = saved as { update: { toUint8Array: () => Uint8Array } };
  return data.update.toUint8Array();
}

export function hydrateControl(
  snapshot: Uint8Array,
  updates: Uint8Array[],
): Y.Doc {
  const doc = new Y.Doc();
  if (snapshot.byteLength > 0) Y.applyUpdate(doc, snapshot);
  for (const u of updates) {
    if (u.byteLength > 0) Y.applyUpdate(doc, u);
  }
  return doc;
}

export { FireProvider, TEST_PATH };
