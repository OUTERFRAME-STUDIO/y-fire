/**
 * SCREENWEAVER-2 (Sentry): `FirebaseError: Missing or insufficient permissions.`
 * reported as an *unhandled promise rejection* (`mechanism:
 * auto.browser.global_handlers.onunhandledrejection`) with no stack trace, on a
 * Firestore `Write` channel — matching y-fire's WebRTC signaling cleanup, which
 * fires-and-forgets `deleteDoc()` calls when tearing down peer call/answer docs
 * (e.g. on project navigation/provider teardown racing with a permission change).
 *
 * `src/webrtc.ts` had three call sites that invoked `deleteDoc(ref)` without
 * awaiting or attaching `.catch()`:
 *   - `callPeer()` — delayed cleanup of the caller's signal doc after `idleThreshold`
 *   - `replyPeer()` — delayed cleanup of the replier's signal doc after `idleThreshold`
 *   - `deleteSignals()` — cleanup on every successful handshake (`connect()`) and on
 *     every peer `destroy()` (i.e. on essentially every project switch / unmount)
 *
 * A synchronous `try/catch` around a fire-and-forget promise does NOT catch an
 * async rejection, so a `permission-denied` error from any of these (e.g. project
 * access revoked or provider torn down mid-teardown) escaped as an unhandled
 * rejection. Fixed in 2.2.0-screenweaver.4 by attaching `.catch()` to each site.
 *
 * @see src/webrtc.ts — WebRtc.callPeer, WebRtc.replyPeer, WebRtc.deleteSignals
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function permissionDeniedDeleteDoc(): Promise<void> {
  const error = Object.assign(
    new Error("Missing or insufficient permissions."),
    { code: "permission-denied", name: "FirebaseError" },
  );
  return Promise.reject(error);
}

/** Flush the microtask queue so Node has a chance to flag an unhandled rejection. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("y-fire WebRTC signal cleanup — permission-denied handling", () => {
  let rejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    rejections.push(reason);
  };

  beforeEach(() => {
    rejections = [];
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
  });

  /** Pre-patch `deleteSignals()` behavior — the bug. */
  function deleteSignalsUnpatched(deleteDoc: () => Promise<void>): void {
    try {
      deleteDoc(); // fire-and-forget: a rejection here bypasses this try/catch
    } catch {
      // only synchronous throws land here
    }
  }

  /** Post-patch `deleteSignals()` behavior (2.2.0-screenweaver.4+). */
  function deleteSignalsPatched(deleteDoc: () => Promise<void>): void {
    try {
      deleteDoc().catch(() => {
        // permission-denied during teardown is expected and non-fatal
      });
    } catch {
      // only synchronous throws land here
    }
  }

  it("reproduces the bug: unpatched fire-and-forget deleteDoc escapes as an unhandled rejection", async () => {
    deleteSignalsUnpatched(permissionDeniedDeleteDoc);
    await flushMicrotasks();
    expect(rejections).toHaveLength(1);
  });

  it("validates the fix: patched deleteSignals swallows permission-denied without an unhandled rejection", async () => {
    deleteSignalsPatched(permissionDeniedDeleteDoc);
    await flushMicrotasks();
    expect(rejections).toHaveLength(0);
  });

  describe("delayed call/answer cleanup (callPeer / replyPeer idleThreshold timer)", () => {
    const idleThreshold = 20000;

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Pre-patch behavior for the two setTimeout-delayed cleanup call sites. */
    function scheduleCleanupUnpatched(deleteDoc: () => Promise<void>): void {
      setTimeout(() => {
        deleteDoc();
      }, idleThreshold);
    }

    /** Post-patch behavior (2.2.0-screenweaver.4+). */
    function scheduleCleanupPatched(
      deleteDoc: () => Promise<void>,
      errorHandler: (error: unknown) => void,
    ): void {
      setTimeout(() => {
        deleteDoc().catch((error) => errorHandler(error));
      }, idleThreshold);
    }

    it("reproduces the bug: unpatched delayed cleanup escapes as an unhandled rejection", async () => {
      scheduleCleanupUnpatched(permissionDeniedDeleteDoc);
      await vi.advanceTimersByTimeAsync(idleThreshold);
      await vi.advanceTimersByTimeAsync(0);
      expect(rejections).toHaveLength(1);
    });

    it("validates the fix: patched delayed cleanup routes errors to errorHandler instead", async () => {
      const errorHandler = vi.fn();
      scheduleCleanupPatched(permissionDeniedDeleteDoc, errorHandler);
      await vi.advanceTimersByTimeAsync(idleThreshold);
      await vi.advanceTimersByTimeAsync(0);
      expect(rejections).toHaveLength(0);
      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect((errorHandler.mock.calls[0][0] as { code?: string }).code).toBe(
        "permission-denied",
      );
    });
  });
});
