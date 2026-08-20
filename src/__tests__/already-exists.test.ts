import { describe, it, expect } from "vitest";
import {
  isAlreadyExistsError,
  updateIdFromAlreadyExistsError,
} from "../append-store";

const LIVE_SHAPED_MESSAGE =
  "FirebaseError: Document already exists: projects/example-project/databases/(default)/documents/projects/test/doc/updates/Jyg4o06ryGIRmQXbLHDo";

describe("isAlreadyExistsError", () => {
  it("is true for already-exists", () => {
    expect(
      isAlreadyExistsError(
        Object.assign(new Error(LIVE_SHAPED_MESSAGE), { code: "already-exists" }),
      ),
    ).toBe(true);
  });

  it("is true for firestore/already-exists", () => {
    expect(
      isAlreadyExistsError({
        code: "firestore/already-exists",
        message: LIVE_SHAPED_MESSAGE,
      }),
    ).toBe(true);
  });

  it("is false for unavailable", () => {
    expect(
      isAlreadyExistsError(
        Object.assign(new Error("unavailable"), { code: "unavailable" }),
      ),
    ).toBe(false);
  });

  it("is false when code is missing", () => {
    expect(isAlreadyExistsError(new Error(LIVE_SHAPED_MESSAGE))).toBe(false);
    expect(isAlreadyExistsError({ message: LIVE_SHAPED_MESSAGE })).toBe(false);
  });

  it("is false for non-objects", () => {
    expect(isAlreadyExistsError(undefined)).toBe(false);
    expect(isAlreadyExistsError(null)).toBe(false);
    expect(isAlreadyExistsError("already-exists")).toBe(false);
    expect(isAlreadyExistsError(409)).toBe(false);
  });
});

describe("updateIdFromAlreadyExistsError", () => {
  it("extracts the id from a full live-shaped resource path", () => {
    expect(
      updateIdFromAlreadyExistsError(new Error(LIVE_SHAPED_MESSAGE)),
    ).toBe("Jyg4o06ryGIRmQXbLHDo");
  });

  it("extracts the id from a short updates path", () => {
    expect(
      updateIdFromAlreadyExistsError({
        message: "projects/test/doc/updates/abc123",
      }),
    ).toBe("abc123");
  });

  it("returns undefined when the message has no /updates/ segment", () => {
    expect(
      updateIdFromAlreadyExistsError(
        new Error("FirebaseError: Document already exists"),
      ),
    ).toBeUndefined();
  });

  it("trims trailing whitespace before parsing the id", () => {
    expect(
      updateIdFromAlreadyExistsError(
        new Error(`${LIVE_SHAPED_MESSAGE}  \n`),
      ),
    ).toBe("Jyg4o06ryGIRmQXbLHDo");
  });
});
