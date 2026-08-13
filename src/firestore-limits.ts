/** Firestore rejects documents larger than 1 MiB. */
export const FIRESTORE_CONTENT_MAX_BYTES = 1_048_576;

/** Warn (but still write) when encoded `content` reaches this size. */
export const FIRESTORE_CONTENT_WARN_BYTES = Math.floor(
  FIRESTORE_CONTENT_MAX_BYTES * 0.7,
);

/** Empty Yjs updates are typically two zero var-uints. */
export const EMPTY_YJS_UPDATE_MAX_BYTES = 2;

export type ContentSizeKind = "ok" | "warn" | "abort";

export function contentSizeKind(
  byteLength: number,
  maxBytes: number = FIRESTORE_CONTENT_MAX_BYTES,
): ContentSizeKind {
  if (byteLength > maxBytes) return "abort";
  if (byteLength >= Math.floor(maxBytes * 0.7)) return "warn";
  return "ok";
}
