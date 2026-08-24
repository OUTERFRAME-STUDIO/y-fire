import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import {
  addDocCalls,
  deleteDocCalls,
  emitSnapshot,
  emitUpdatesSnapshot,
  firestoreCollections,
  firestoreDocs,
  seedFirestoreUpdate,
  updatesPath,
} from "./_mocks/firestore";
import {
  createTestProvider,
  flushMicrotasks,
  markServerReady,
  TEST_PATH,
  whenTabFoldsIdle,
  FireProvider,
} from "./helpers";
import {
  CONTENT_GZIP_BYTES_FIELD,
  CONTENT_RAW_BYTES_FIELD,
  CONTENT_STORAGE_GENERATION_FIELD,
  CONTENT_STORAGE_PATH_FIELD,
  SNAPSHOT_BACKEND_FIELD,
  readSnapshotMeta,
  type SnapshotStore,
} from "../append-store";
import { FIRESTORE_CONTENT_MAX_BYTES } from "../firestore-limits";

const LARGE_PAYLOAD_CHARS = Math.floor(FIRESTORE_CONTENT_MAX_BYTES * 1.5);

function createMemorySnapshotStore(opts?: {
  defaultPath?: string;
}): {
  blobs: Map<string, Uint8Array>;
  store: SnapshotStore;
  write: SnapshotStore["write"];
  read: SnapshotStore["read"];
  readDefault: NonNullable<SnapshotStore["readDefault"]>;
} {
  const blobs = new Map<string, Uint8Array>();
  const write = vi.fn(async (bytes: Uint8Array) => {
    const path = `snap/${blobs.size + 1}`;
    blobs.set(path, bytes);
    return {
      path,
      rawBytes: bytes.byteLength,
      gzipBytes: bytes.byteLength,
      generation: String(blobs.size),
    };
  });
  const read = vi.fn(async (meta: { path: string }) => {
    const b = blobs.get(meta.path);
    if (!b) throw new Error("missing snapshot " + meta.path);
    return b;
  });
  const readDefault = vi.fn(async (args?: { epoch?: number | null }) => {
    const candidates: string[] = [];
    if (args?.epoch != null && args.epoch > 0) {
      candidates.push(`snap/${args.epoch}`);
    }
    if (opts?.defaultPath) candidates.push(opts.defaultPath);
    for (const path of candidates) {
      const bytes = blobs.get(path);
      if (bytes) {
        return { bytes, meta: { path, rawBytes: bytes.byteLength } };
      }
    }
    return null;
  });
  return { blobs, store: { write, read, readDefault }, write, read, readDefault };
}

function shardHasContentField(data: Record<string, unknown> | undefined) {
  return data !== undefined && Object.prototype.hasOwnProperty.call(data, "content");
}

function seedStorageShard(
  path: string,
  meta: {
    path: string;
    generation?: string;
    gzipBytes?: number;
    rawBytes?: number;
  },
  extra?: { epoch?: number; snapshotSV?: Uint8Array },
) {
  const data: Record<string, unknown> = {
    [SNAPSHOT_BACKEND_FIELD]: "storage",
    [CONTENT_STORAGE_PATH_FIELD]: meta.path,
  };
  if (meta.generation !== undefined) {
    data[CONTENT_STORAGE_GENERATION_FIELD] = meta.generation;
  }
  if (meta.gzipBytes !== undefined) {
    data[CONTENT_GZIP_BYTES_FIELD] = meta.gzipBytes;
  }
  if (meta.rawBytes !== undefined) {
    data[CONTENT_RAW_BYTES_FIELD] = meta.rawBytes;
  }
  if (extra?.epoch !== undefined) {
    data.contentGeneration = extra.epoch;
  }
  if (extra?.snapshotSV) {
    data.snapshotSV = { toUint8Array: () => extra.snapshotSV };
  }
  firestoreDocs.set(path, data);
  return data;
}

function emitServerStorageSnapshot(
  path: string,
  extra?: { fromCache?: boolean; emitUpdates?: boolean },
) {
  const data = firestoreDocs.get(path) ?? {};
  emitSnapshot(path, {
    exists: () => true,
    data: () => data,
    metadata: {
      fromCache: extra?.fromCache === true,
      hasPendingWrites: false,
    },
  });
  if (extra?.emitUpdates !== false) {
    emitUpdatesSnapshot(path, {
      fromCache: extra?.fromCache === true,
      hasPendingWrites: false,
    });
  }
}

async function waitUntil(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("snapshotStore persistence", () => {
  let provider: FireProvider | undefined;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    provider = undefined;
  });

  afterEach(async () => {
    await whenTabFoldsIdle();
    if (provider) {
      await provider.kill();
      provider = undefined;
    }
    vi.mocked(console.log).mockRestore();
  });

  it("readSnapshotMeta returns storage metadata fields", () => {
    const sv = new Uint8Array([0, 0]);
    const meta = readSnapshotMeta({
      [SNAPSHOT_BACKEND_FIELD]: "storage",
      [CONTENT_STORAGE_PATH_FIELD]: "snap/1",
      [CONTENT_STORAGE_GENERATION_FIELD]: "1",
      [CONTENT_GZIP_BYTES_FIELD]: 10,
      [CONTENT_RAW_BYTES_FIELD]: 20,
      snapshotSV: { toUint8Array: () => sv },
      contentGeneration: 3,
    });
    expect(meta.content).toBeUndefined();
    expect(meta.snapshotBackend).toBe("storage");
    expect(meta.contentStoragePath).toBe("snap/1");
    expect(meta.contentStorageGeneration).toBe("1");
    expect(meta.contentGzipBytes).toBe(10);
    expect(meta.contentRawBytes).toBe(20);
    expect(meta.epoch).toBe(3);
    expect(meta.snapshotSV).toEqual(sv);
  });

  it("does not write snapshotStore when Firestore already has contentStoragePath", async () => {
    const { store, write } = createMemorySnapshotStore();
    const created = await createTestProvider({ snapshotStore: store });
    provider = created.provider;
    await markServerReady(TEST_PATH);
    expect(write).toHaveBeenCalledTimes(0);

    const packed = new Y.Doc();
    packed.getText("t").insert(0, "packed-payload");
    const snapshot = Y.encodeStateAsUpdate(packed);
    const meta = await store.write(snapshot);
    write.mockClear();
    seedStorageShard(TEST_PATH, meta);

    created.ydoc.getMap("bodies");
    await provider.saveToFirestore();
    expect(write).not.toHaveBeenCalled();
  });

  it("adoptPersistedSnapshot does not first-write a >1 MiB pack (empty hydrate fallback)", async () => {
    const source = new Y.Doc();
    source.getText("t").insert(0, "x".repeat(LARGE_PAYLOAD_CHARS));
    const bytes = Y.encodeStateAsUpdate(source);
    expect(bytes.byteLength).toBeGreaterThan(FIRESTORE_CONTENT_MAX_BYTES);

    const { store, write } = createMemorySnapshotStore();
    const created = await createTestProvider({ snapshotStore: store });
    provider = created.provider;
    const onSaveError = vi.fn();
    provider.onSaveError = onSaveError;
    await markServerReady(TEST_PATH);

    provider.adoptPersistedSnapshot(bytes);
    expect(created.ydoc.getText("t").toString().length).toBe(LARGE_PAYLOAD_CHARS);

    await provider.saveToFirestore();
    expect(write).not.toHaveBeenCalled();
    expect(addDocCalls.length).toBe(0);
    expect(
      onSaveError.mock.calls.map((c) => (c[1] as { reason?: string })?.reason),
    ).not.toContain("size-abort");

    created.ydoc.getText("t").insert(LARGE_PAYLOAD_CHARS, "!");
    await provider.saveToFirestore();
    expect(write).not.toHaveBeenCalled();
    expect(addDocCalls.length).toBe(1);
    expect(
      onSaveError.mock.calls.map((c) => (c[1] as { reason?: string })?.reason),
    ).not.toContain("size-abort");
  });

  it("a local applyUpdate of a >1 MiB pack size-aborts without adoptPersistedSnapshot", async () => {
    const source = new Y.Doc();
    source.getText("t").insert(0, "x".repeat(LARGE_PAYLOAD_CHARS));
    const bytes = Y.encodeStateAsUpdate(source);

    const created = await createTestProvider();
    provider = created.provider;
    const onSaveError = vi.fn();
    provider.onSaveError = onSaveError;
    await markServerReady(TEST_PATH);

    Y.applyUpdate(created.ydoc, bytes);
    await provider.saveToFirestore();

    expect(
      onSaveError.mock.calls.map((c) => (c[1] as { reason?: string })?.reason),
    ).toContain("size-abort");
    expect(String(onSaveError.mock.calls[0]?.[0])).toContain(
      "encoded content exceeds Firestore 1 MiB limit",
    );
  });

  it("readDefault hydrates a >1 MiB pack when contentStoragePath is missing", async () => {
    const source = new Y.Doc();
    source.getText("t").insert(0, "x".repeat(LARGE_PAYLOAD_CHARS));
    const bytes = Y.encodeStateAsUpdate(source);
    const { store, write, blobs, readDefault } = createMemorySnapshotStore({
      defaultPath: "snap/0",
    });
    blobs.set("snap/0", bytes);

    const created = await createTestProvider({ snapshotStore: store });
    provider = created.provider;
    const onSaveError = vi.fn();
    provider.onSaveError = onSaveError;
    firestoreDocs.set(TEST_PATH, { contentGeneration: 1 });
    emitServerStorageSnapshot(TEST_PATH);
    await waitUntil(
      () => created.ydoc.getText("t").toString().length === LARGE_PAYLOAD_CHARS,
      "readDefault hydrate",
    );
    expect(readDefault).toHaveBeenCalled();
    expect(readDefault.mock.calls[0]?.[0]).toMatchObject({ epoch: 1 });
    await waitUntil(
      () =>
        typeof firestoreDocs.get(TEST_PATH)?.[CONTENT_STORAGE_PATH_FIELD] ===
        "string",
      "stamp contentStoragePath after readDefault",
    );
    expect(firestoreDocs.get(TEST_PATH)?.[CONTENT_STORAGE_PATH_FIELD]).toBe(
      "snap/0",
    );

    await provider.saveToFirestore();
    expect(write).not.toHaveBeenCalled();
    expect(addDocCalls.length).toBe(0);
    expect(
      onSaveError.mock.calls.map((c) => (c[1] as { reason?: string })?.reason),
    ).not.toContain("size-abort");

    created.ydoc.getText("t").insert(LARGE_PAYLOAD_CHARS, "!");
    await provider.saveToFirestore();
    expect(write).not.toHaveBeenCalled();
    expect(addDocCalls.length).toBe(1);
  });

  it("readDefault prefers the shard epoch object over epoch 0", async () => {
    const stale = new Y.Doc();
    stale.getText("t").insert(0, "stale");
    const fresh = new Y.Doc();
    fresh.getText("t").insert(0, "fresh-epoch");
    const { store, blobs, readDefault } = createMemorySnapshotStore({
      defaultPath: "snap/0",
    });
    blobs.set("snap/0", Y.encodeStateAsUpdate(stale));
    blobs.set("snap/9", Y.encodeStateAsUpdate(fresh));

    const created = await createTestProvider({ snapshotStore: store });
    provider = created.provider;
    firestoreDocs.set(TEST_PATH, { contentGeneration: 9 });
    emitServerStorageSnapshot(TEST_PATH);
    await waitUntil(
      () => created.ydoc.getText("t").toString() === "fresh-epoch",
      "readDefault hydrates the stamped epoch",
    );
    expect(readDefault.mock.calls[0]?.[0]).toMatchObject({ epoch: 9 });
    stale.destroy();
    fresh.destroy();
  });

  it("exists first-write applies the remote snapshot when local is empty", async () => {
    const source = new Y.Doc();
    source.getText("t").insert(0, "remote-pack");
    const bytes = Y.encodeStateAsUpdate(source);
    const { store, write } = createMemorySnapshotStore();
    const created = await createTestProvider({ snapshotStore: store });
    provider = created.provider;
    const meta = await store.write(bytes);
    write.mockClear();
    seedStorageShard(TEST_PATH, meta, {
      snapshotSV: Y.encodeStateVector(source),
    });
    await markServerReady(TEST_PATH);

    created.ydoc.getText("t").insert(0, "local-only");
    await provider.saveToFirestore();

    expect(created.ydoc.getText("t").toString()).toContain("remote-pack");
    expect(write).not.toHaveBeenCalled();
    source.destroy();
  });

  it("exists first-write uses snapshotSV so a local pack apply is not a WAL dump", async () => {
    const source = new Y.Doc();
    source.getText("t").insert(0, "x".repeat(LARGE_PAYLOAD_CHARS));
    const bytes = Y.encodeStateAsUpdate(source);
    const snapshotSV = Y.encodeStateVector(source);
    const { store, write } = createMemorySnapshotStore();
    const created = await createTestProvider({ snapshotStore: store });
    provider = created.provider;
    const meta = await store.write(bytes);
    write.mockClear();
    seedStorageShard(TEST_PATH, meta, { snapshotSV });
    const onSaveError = vi.fn();
    provider.onSaveError = onSaveError;
    await markServerReady(TEST_PATH);

    Y.applyUpdate(created.ydoc, bytes);
    await provider.saveToFirestore();

    expect(write).not.toHaveBeenCalled();
    expect(addDocCalls.length).toBe(0);
    expect(
      onSaveError.mock.calls.map((c) => (c[1] as { reason?: string })?.reason),
    ).not.toContain("size-abort");
  });

  it("writes a ~1.5MB first snapshot via the store without a content field or size-abort", async () => {
    const { store, write } = createMemorySnapshotStore();
    const created = await createTestProvider({ snapshotStore: store });
    provider = created.provider;
    const onSaveError = vi.fn();
    provider.onSaveError = onSaveError;

    created.ydoc.getText("t").insert(0, "x".repeat(LARGE_PAYLOAD_CHARS));
    const encoded = Y.encodeStateAsUpdate(created.ydoc);
    expect(encoded.byteLength).toBeGreaterThan(FIRESTORE_CONTENT_MAX_BYTES);

    await markServerReady(TEST_PATH);
    await provider.saveToFirestore();

    expect(write).toHaveBeenCalledTimes(1);
    expect(addDocCalls.length).toBe(0);
    const saved = firestoreDocs.get(TEST_PATH);
    expect(saved?.[SNAPSHOT_BACKEND_FIELD]).toBe("storage");
    expect(typeof saved?.[CONTENT_STORAGE_PATH_FIELD]).toBe("string");
    expect(saved?.[CONTENT_STORAGE_PATH_FIELD]).toBe("snap/1");
    expect(shardHasContentField(saved)).toBe(false);
    expect(onSaveError.mock.calls.map((c) => (c[1] as { reason?: string })?.reason)).not.toContain(
      "size-abort",
    );
    expect(onSaveError.mock.calls.map((c) => (c[1] as { reason?: string })?.reason)).not.toContain(
      "compact-required",
    );
  });

  it("hydrates text and maps from stored snapshot bytes plus updates/*", async () => {
    const { store } = createMemorySnapshotStore();
    const source = new Y.Doc();
    source.getText("t").insert(0, "hello");
    source.getMap("m").set("k", "v");
    const snapshot = Y.encodeStateAsUpdate(source);
    const snapshotSV = Y.encodeStateVector(source);
    const meta = await store.write(snapshot);

    const sv = Y.encodeStateVector(source);
    source.getText("t").insert(5, " world");
    source.getMap("m").set("n", 7);
    const update = Y.encodeStateAsUpdate(source, sv);

    const created = await createTestProvider({ snapshotStore: store });
    provider = created.provider;
    seedStorageShard(TEST_PATH, meta, { snapshotSV });
    seedFirestoreUpdate(TEST_PATH, "u1", update, { seq: 1 });
    emitServerStorageSnapshot(TEST_PATH);
    await waitUntil(
      () => created.ydoc.getText("t").toString() === "hello world",
      "storage hydrate",
    );

    expect(created.ydoc.getText("t").toString()).toBe("hello world");
    expect(created.ydoc.getMap("m").get("k")).toBe("v");
    expect(created.ydoc.getMap("m").get("n")).toBe(7);
    expect(provider.serverReady).toBe(true);
    expect(shardHasContentField(firestoreDocs.get(TEST_PATH))).toBe(false);
  });

  it("appends updates/* on small edits without rewriting the snapshot", async () => {
    const { store, write } = createMemorySnapshotStore();
    const created = await createTestProvider({ snapshotStore: store });
    provider = created.provider;
    created.ydoc.getText("t").insert(0, "snapshot-base");
    await markServerReady(TEST_PATH);
    await provider.saveToFirestore();

    expect(write).toHaveBeenCalledTimes(1);
    expect(addDocCalls.length).toBe(0);
    const pathAfterSnapshot = firestoreDocs.get(TEST_PATH)?.[CONTENT_STORAGE_PATH_FIELD];

    created.ydoc.getText("t").insert(13, "!");
    await provider.saveToFirestore();

    expect(write).toHaveBeenCalledTimes(1);
    expect(addDocCalls.length).toBe(1);
    expect(firestoreDocs.get(TEST_PATH)?.[CONTENT_STORAGE_PATH_FIELD]).toBe(
      pathAfterSnapshot,
    );
    expect(shardHasContentField(firestoreDocs.get(TEST_PATH))).toBe(false);
  });

  it("folds through the store for a >1 MiB snapshot without writing content or aborting", async () => {
    const { store, write, blobs } = createMemorySnapshotStore();
    const created = await createTestProvider({
      snapshotStore: store,
      foldUpdateThreshold: 2,
    });
    provider = created.provider;
    const onSaveError = vi.fn();
    provider.onSaveError = onSaveError;

    created.ydoc.getText("t").insert(0, "x".repeat(LARGE_PAYLOAD_CHARS));
    await markServerReady(TEST_PATH);
    await provider.saveToFirestore();
    expect(write).toHaveBeenCalledTimes(1);
    expect(Y.encodeStateAsUpdate(created.ydoc).byteLength).toBeGreaterThan(
      FIRESTORE_CONTENT_MAX_BYTES,
    );

    created.ydoc.getText("t").insert(LARGE_PAYLOAD_CHARS, "A");
    await provider.saveToFirestore();
    expect(addDocCalls.length).toBe(1);
    expect(write).toHaveBeenCalledTimes(1);

    created.ydoc.getText("t").insert(LARGE_PAYLOAD_CHARS + 1, "B");
    await provider.saveToFirestore();
    await whenTabFoldsIdle();

    expect(write).toHaveBeenCalledTimes(2);
    expect(firestoreCollections.get(updatesPath(TEST_PATH))?.size ?? 0).toBe(0);
    expect(deleteDocCalls.length).toBeGreaterThanOrEqual(2);

    const saved = firestoreDocs.get(TEST_PATH);
    expect(saved?.[SNAPSHOT_BACKEND_FIELD]).toBe("storage");
    expect(saved?.[CONTENT_STORAGE_PATH_FIELD]).toBe("snap/2");
    expect(shardHasContentField(saved)).toBe(false);
    expect(saved?.contentGeneration).toBeUndefined();

    const folded = blobs.get("snap/2");
    expect(folded).toBeDefined();
    expect(folded!.byteLength).toBeGreaterThan(FIRESTORE_CONTENT_MAX_BYTES);
    const foldedDoc = new Y.Doc();
    Y.applyUpdate(foldedDoc, folded!);
    expect(foldedDoc.getText("t").toString().endsWith("AB")).toBe(true);
    expect(foldedDoc.getText("t").length).toBe(LARGE_PAYLOAD_CHARS + 2);

    expect(onSaveError.mock.calls.map((c) => (c[1] as { reason?: string })?.reason)).not.toContain(
      "size-abort",
    );
    expect(onSaveError.mock.calls.map((c) => (c[1] as { reason?: string })?.reason)).not.toContain(
      "compact-required",
    );
  });
});
