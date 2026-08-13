import { describe, it, expect } from "vitest";
import {
  FIRESTORE_CONTENT_MAX_BYTES,
  FIRESTORE_CONTENT_WARN_BYTES,
  contentSizeKind,
} from "../firestore-limits";

describe("contentSizeKind", () => {
  it("returns ok below the warn threshold", () => {
    expect(contentSizeKind(FIRESTORE_CONTENT_WARN_BYTES - 1)).toBe("ok");
  });

  it("returns warn at 70% of 1 MiB", () => {
    expect(contentSizeKind(FIRESTORE_CONTENT_WARN_BYTES)).toBe("warn");
    expect(contentSizeKind(FIRESTORE_CONTENT_MAX_BYTES)).toBe("warn");
  });

  it("returns abort above 1 MiB", () => {
    expect(contentSizeKind(FIRESTORE_CONTENT_MAX_BYTES + 1)).toBe("abort");
  });
});
