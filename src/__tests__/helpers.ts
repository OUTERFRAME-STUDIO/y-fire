import { vi } from "vitest";
import * as Y from "yjs";
import type { FirebaseApp } from "@firebase/app";
import {
  emitSnapshot,
  resetFirestoreMock,
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

  const ydoc = new Y.Doc();
  const provider = new FireProvider({
    firebaseApp: {} as FirebaseApp,
    ydoc,
    path: TEST_PATH,
    maxWaitTime: 10,
    ...overrides,
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
  });
}

export function emitRemoteUpdate(path: string, content: Uint8Array) {
  emitSnapshot(path, {
    exists: () => true,
    data: () => ({
      content: {
        toUint8Array: () => content,
      },
    }),
  });
}

export function emitEmptyMeshSnapshot(path: string) {
  emitSnapshot(path, {
    exists: () => true,
    data: () => ({}),
    forEach: () => {},
  });
}

export { FireProvider, TEST_PATH };
