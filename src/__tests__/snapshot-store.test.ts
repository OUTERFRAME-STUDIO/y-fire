import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import {
  addDocCalls,
  deleteDocCalls,
  emitSnapshot,
  emitUpdatesSnapshot,
  firestoreCollections,
  firestoreDocs,
  resetFirestoreMock,
  seedFirestoreContent,
  seedFirestoreShard,
  seedFirestoreUpdate,
  setRunTransactionBefore,
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
  SnapshotPointerChangedError,
  foldUpdates,
  readSnapshotMeta,
  type SnapshotStore,
} from "../append-store";
import { FIRESTORE_CONTENT_MAX_BYTES } from "../firestore-limits";
import { resetTabFoldScheduler } from "../fold-scheduler";
import { resetIdbMock } from "./_mocks/idb";

const LARGE_PAYLOAD_CHARS = Math.floor(FIRESTORE_CONTENT_MAX_BYTES * 1.5);

function createMemorySnapshotStore(opts?: {
  defaultPath?: string;
  inlineContent?: SnapshotStore["inlineContent"];
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
  const store: SnapshotStore = { write, read, readDefault };
  if (opts?.inlineContent) store.inlineContent = opts.inlineContent;
  return { blobs, store, write, read, readDefault };
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

describe("snapshotStore over a legacy inline snapshot (DEV-353)", () => {
  let provider: FireProvider | undefined;

  beforeEach(() => {
    // Seed before the provider exists, so reset here instead of in
    // createTestProvider.
    resetFirestoreMock();
    resetIdbMock();
    resetTabFoldScheduler();
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

  function inlineShard(text: string) {
    const source = new Y.Doc();
    source.getText("t").insert(0, text);
    const bytes = Y.encodeStateAsUpdate(source);
    const sv = Y.encodeStateVector(source);
    source.destroy();
    return { bytes, sv };
  }

  it("hydrates inline content plus updates/* without probing the store", async () => {
    const { store, readDefault, read } = createMemorySnapshotStore({
      defaultPath: "snap/0",
      inlineContent: "merge",
    });
    const base = new Y.Doc();
    base.getText("t").insert(0, "inline");
    const sv = Y.encodeStateVector(base);
    seedFirestoreShard(TEST_PATH, Y.encodeStateAsUpdate(base), {
      snapshotSV: sv,
    });
    base.getText("t").insert(6, "+wal");
    seedFirestoreUpdate(TEST_PATH, "u1", Y.encodeStateAsUpdate(base, sv), {
      seq: 1,
    });

    const created = await createTestProvider({ snapshotStore: store }, { reset: false });
    provider = created.provider;
    emitServerStorageSnapshot(TEST_PATH);
    await waitUntil(
      () => created.ydoc.getText("t").toString() === "inline+wal",
      "inline hydrate",
    );
    expect(readDefault).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    base.destroy();
  });

  it("does not first-write over inline content", async () => {
    const { store, write } = createMemorySnapshotStore({ inlineContent: "merge" });
    const { bytes, sv } = inlineShard("inline");
    seedFirestoreShard(TEST_PATH, bytes, { snapshotSV: sv });

    const created = await createTestProvider({ snapshotStore: store }, { reset: false });
    provider = created.provider;
    emitServerStorageSnapshot(TEST_PATH);
    await waitUntil(
      () => created.ydoc.getText("t").toString() === "inline",
      "inline hydrate",
    );
    created.ydoc.getText("t").insert(6, "!");
    await provider.saveToFirestore();

    expect(write).not.toHaveBeenCalled();
    expect(addDocCalls.length).toBe(1);
    expect(shardHasContentField(firestoreDocs.get(TEST_PATH))).toBe(true);
  });

  it("merges inline content that sits beside a Storage snapshot", async () => {
    const { store } = createMemorySnapshotStore({ inlineContent: "merge" });
    const stored = new Y.Doc();
    stored.getMap("m").set("fromStore", 1);
    const meta = await store.write(Y.encodeStateAsUpdate(stored));
    const older = new Y.Doc();
    older.getMap("m").set("fromInline", 2);
    seedStorageShard(TEST_PATH, meta, {
      snapshotSV: Y.encodeStateVector(stored),
    });
    seedFirestoreContent(TEST_PATH, Y.encodeStateAsUpdate(older));

    const created = await createTestProvider({ snapshotStore: store }, { reset: false });
    provider = created.provider;
    emitServerStorageSnapshot(TEST_PATH);
    await waitUntil(
      () => created.ydoc.getMap("m").size === 2,
      "store + inline hydrate",
    );
    expect(created.ydoc.getMap("m").toJSON()).toEqual({
      fromStore: 1,
      fromInline: 2,
    });
    stored.destroy();
    older.destroy();
  });

  it("ignores inline content when the store does not opt in", async () => {
    const { store } = createMemorySnapshotStore();
    const stored = new Y.Doc();
    stored.getMap("m").set("fromStore", 1);
    const meta = await store.write(Y.encodeStateAsUpdate(stored));
    const stray = new Y.Doc();
    stray.getMap("m").set("fromInline", 2);
    seedStorageShard(TEST_PATH, meta, {
      snapshotSV: Y.encodeStateVector(stored),
    });
    seedFirestoreContent(TEST_PATH, Y.encodeStateAsUpdate(stray));

    const created = await createTestProvider({ snapshotStore: store }, { reset: false });
    provider = created.provider;
    emitServerStorageSnapshot(TEST_PATH);
    await waitUntil(
      () => created.ydoc.getMap("m").size > 0,
      "store hydrate",
    );
    await flushMicrotasks();
    expect(created.ydoc.getMap("m").toJSON()).toEqual({ fromStore: 1 });
    stored.destroy();
    stray.destroy();
  });

  it("first fold moves inline content into the store and drops the field", async () => {
    const { store, write, blobs } = createMemorySnapshotStore({ inlineContent: "merge" });
    const { bytes, sv } = inlineShard("inline");
    seedFirestoreShard(TEST_PATH, bytes, { snapshotSV: sv });

    const created = await createTestProvider(
      { snapshotStore: store, foldUpdateThreshold: 2 },
      { reset: false },
    );
    provider = created.provider;
    emitServerStorageSnapshot(TEST_PATH);
    await waitUntil(
      () => created.ydoc.getText("t").toString() === "inline",
      "inline hydrate",
    );
    created.ydoc.getText("t").insert(6, "A");
    await provider.saveToFirestore();
    created.ydoc.getText("t").insert(7, "B");
    await provider.saveToFirestore();
    await whenTabFoldsIdle();

    expect(write).toHaveBeenCalledTimes(1);
    const saved = firestoreDocs.get(TEST_PATH);
    expect(saved?.[SNAPSHOT_BACKEND_FIELD]).toBe("storage");
    expect(saved?.[CONTENT_STORAGE_PATH_FIELD]).toBe("snap/1");
    expect(shardHasContentField(saved)).toBe(false);
    expect(firestoreCollections.get(updatesPath(TEST_PATH))?.size ?? 0).toBe(0);
    const folded = new Y.Doc();
    Y.applyUpdate(folded, blobs.get("snap/1")!);
    expect(folded.getText("t").toString()).toBe("inlineAB");
    folded.destroy();
  });
});

describe("foldUpdates with a store over inline content (DEV-353)", () => {
  beforeEach(() => {
    resetFirestoreMock();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.mocked(console.log).mockRestore();
  });

  it("unions inline content even when the local replica lacks it", async () => {
    const { store, blobs } = createMemorySnapshotStore({ inlineContent: "merge" });
    const remote = new Y.Doc();
    remote.getMap("m").set("inline", true);
    seedFirestoreShard(TEST_PATH, Y.encodeStateAsUpdate(remote));
    const local = new Y.Doc();
    local.getMap("m").set("local", true);

    const fold = await foldUpdates({
      db: {} as never,
      documentPath: TEST_PATH,
      listed: [],
      localUpdate: Y.encodeStateAsUpdate(local),
      documentMapper: (bytes) => ({ content: bytes }),
      maxContentBytes: FIRESTORE_CONTENT_MAX_BYTES,
      force: true,
      snapshotStore: store,
      expectedEpoch: 0,
    });
    expect(fold.status).toBe("ok");
    const folded = new Y.Doc();
    Y.applyUpdate(folded, blobs.get("snap/1")!);
    expect(folded.getMap("m").toJSON()).toEqual({ inline: true, local: true });
    expect(shardHasContentField(firestoreDocs.get(TEST_PATH))).toBe(false);
    remote.destroy();
    local.destroy();
    folded.destroy();
  });

  it("leaves inline content alone when the store does not opt in", async () => {
    const { store, blobs } = createMemorySnapshotStore();
    const stray = new Y.Doc();
    stray.getMap("m").set("stray", true);
    seedFirestoreShard(TEST_PATH, Y.encodeStateAsUpdate(stray));
    const local = new Y.Doc();
    local.getMap("m").set("local", true);

    const fold = await foldUpdates({
      db: {} as never,
      documentPath: TEST_PATH,
      listed: [],
      localUpdate: Y.encodeStateAsUpdate(local),
      documentMapper: (bytes) => ({ content: bytes }),
      maxContentBytes: FIRESTORE_CONTENT_MAX_BYTES,
      force: true,
      snapshotStore: store,
      expectedEpoch: 0,
    });
    expect(fold.status).toBe("ok");
    const folded = new Y.Doc();
    Y.applyUpdate(folded, blobs.get("snap/1")!);
    expect(folded.getMap("m").toJSON()).toEqual({ local: true });
    expect(shardHasContentField(firestoreDocs.get(TEST_PATH))).toBe(true);
    stray.destroy();
    local.destroy();
    folded.destroy();
  });

  it("does not commit or delete updates when another fold moved the pointer", async () => {
    const { store } = createMemorySnapshotStore({ inlineContent: "merge" });
    const base = new Y.Doc();
    base.getMap("m").set("a", 1);
    seedFirestoreShard(TEST_PATH, Y.encodeStateAsUpdate(base));
    const wal = new Y.Doc();
    wal.getMap("m").set("w", 1);
    const walBytes = Y.encodeStateAsUpdate(wal);
    seedFirestoreUpdate(TEST_PATH, "u1", walBytes);
    let calls = 0;
    setRunTransactionBefore(async () => {
      calls++;
      // The server's first fold commits its own object between our read and
      // our commit.
      if (calls === 2) {
        const existing = firestoreDocs.get(TEST_PATH) ?? {};
        firestoreDocs.set(TEST_PATH, {
          ...existing,
          [SNAPSHOT_BACKEND_FIELD]: "storage",
          [CONTENT_STORAGE_PATH_FIELD]: "server/1",
          [CONTENT_STORAGE_GENERATION_FIELD]: "77",
        });
      }
    });
    try {
      await expect(
        foldUpdates({
          db: {} as never,
          documentPath: TEST_PATH,
          listed: [{ id: "u1", update: walBytes, seq: 1 }],
          localUpdate: new Uint8Array([0, 0]),
          documentMapper: (bytes) => ({ content: bytes }),
          maxContentBytes: FIRESTORE_CONTENT_MAX_BYTES,
          force: true,
          snapshotStore: store,
          expectedEpoch: 0,
        }),
      ).rejects.toBeInstanceOf(SnapshotPointerChangedError);
    } finally {
      setRunTransactionBefore(async () => {});
    }
    const saved = firestoreDocs.get(TEST_PATH);
    expect(saved?.[CONTENT_STORAGE_PATH_FIELD]).toBe("server/1");
    expect(firestoreCollections.get(updatesPath(TEST_PATH))?.has("u1")).toBe(true);
    base.destroy();
    wal.destroy();
  });

  it("unions an object left at the target without a pointer", async () => {
    const { store, blobs, readDefault } = createMemorySnapshotStore({
      inlineContent: "merge",
    });
    const orphan = new Y.Doc();
    orphan.getMap("m").set("orphan", true);
    blobs.set("snap/3", Y.encodeStateAsUpdate(orphan));
    const inline = new Y.Doc();
    inline.getMap("m").set("inline", true);
    seedFirestoreShard(TEST_PATH, Y.encodeStateAsUpdate(inline), { epoch: 3 });

    const fold = await foldUpdates({
      db: {} as never,
      documentPath: TEST_PATH,
      listed: [],
      localUpdate: new Uint8Array([0, 0]),
      documentMapper: (bytes) => ({ content: bytes }),
      maxContentBytes: FIRESTORE_CONTENT_MAX_BYTES,
      force: true,
      snapshotStore: store,
      expectedEpoch: 3,
    });
    expect(fold.status).toBe("ok");
    expect(readDefault.mock.calls[0]?.[0]).toMatchObject({ epoch: 3 });
    const path = firestoreDocs.get(TEST_PATH)?.[CONTENT_STORAGE_PATH_FIELD] as string;
    const folded = new Y.Doc();
    Y.applyUpdate(folded, blobs.get(path)!);
    expect(folded.getMap("m").toJSON()).toEqual({ orphan: true, inline: true });
    orphan.destroy();
    inline.destroy();
    folded.destroy();
  });

  it("keeps inline content that changed after it was read", async () => {
    const { store } = createMemorySnapshotStore({ inlineContent: "merge" });
    const first = new Y.Doc();
    first.getMap("m").set("a", 1);
    seedFirestoreShard(TEST_PATH, Y.encodeStateAsUpdate(first));
    const replaced = new Y.Doc();
    replaced.getMap("m").set("b", 2);
    const replacedBytes = Y.encodeStateAsUpdate(replaced);
    let calls = 0;
    setRunTransactionBefore(async () => {
      calls++;
      // Second transaction = the commit: an older replica folded inline
      // content between the read and the commit.
      if (calls === 2) seedFirestoreContent(TEST_PATH, replacedBytes);
    });
    try {
      const fold = await foldUpdates({
        db: {} as never,
        documentPath: TEST_PATH,
        listed: [],
        localUpdate: Y.encodeStateAsUpdate(first),
        documentMapper: (bytes) => ({ content: bytes }),
        maxContentBytes: FIRESTORE_CONTENT_MAX_BYTES,
        force: true,
        snapshotStore: store,
        expectedEpoch: 0,
      });
      expect(fold.status).toBe("ok");
    } finally {
      setRunTransactionBefore(async () => {});
    }
    const saved = firestoreDocs.get(TEST_PATH);
    expect(saved?.[CONTENT_STORAGE_PATH_FIELD]).toBe("snap/1");
    expect(
      (saved?.content as { toUint8Array: () => Uint8Array }).toUint8Array(),
    ).toEqual(replacedBytes);
    first.destroy();
    replaced.destroy();
  });
});
