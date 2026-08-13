/** Firestore rejects documents larger than 1 MiB. */
export declare const FIRESTORE_CONTENT_MAX_BYTES = 1048576;
/** Warn (but still write) when encoded `content` reaches this size. */
export declare const FIRESTORE_CONTENT_WARN_BYTES: number;
/** Empty Yjs updates are typically two zero var-uints. */
export declare const EMPTY_YJS_UPDATE_MAX_BYTES = 2;
export type ContentSizeKind = "ok" | "warn" | "abort";
export declare function contentSizeKind(byteLength: number, maxBytes?: number): ContentSizeKind;
//# sourceMappingURL=firestore-limits.d.ts.map