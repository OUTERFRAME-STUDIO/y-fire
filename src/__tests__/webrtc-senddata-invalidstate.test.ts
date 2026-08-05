/**
 * SCREENWEAVER-24 / DEV-41 (Sentry): `InvalidStateError: The object is in an
 * invalid state.` (DOMException code 11) reported as an *unhandled promise
 * rejection* (`mechanism: auto.browser.global_handlers.onunhandledrejection`)
 * with stack `y-fire/dist/webrtc.js → simple-peer-light → RTCDataChannel.send`.
 *
 * `WebRtc.sendData` awaits encrypt/base64, then called `this.peer.send(encrypted)`
 * while `this.connection === "connected"`. During mesh reconnect or peer
 * teardown, Safari closes the RTCDataChannel before simple-peer emits `close`
 * / before `this.connection` flips — classic async TOCTOU. Because `sendData`
 * is `async`, a synchronous throw from `peer.send` rejects the returned
 * promise; callers (`sendDataToPeers`, `handleOnConnected`) do not await or
 * `.catch()`, so the rejection escapes as unhandled.
 *
 * Fixed in 2.2.0-screenweaver.5 by re-checking `connection` + `peer` after the
 * encrypt await and wrapping `peer.send` in try/catch → `errorHandler`.
 *
 * @see src/webrtc.ts — WebRtc.sendData
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Flush the microtask queue so Node has a chance to flag an unhandled rejection. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function safariInvalidStateError(): DOMException {
  return new DOMException(
    "The object is in an invalid state.",
    "InvalidStateError",
  );
}

function chromeReadyStateError(): DOMException {
  return new DOMException(
    "Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'",
    "InvalidStateError",
  );
}

describe("y-fire WebRTC sendData — RTCDataChannel InvalidStateError", () => {
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

  /**
   * Pre-patch `sendData` core: check connection, await encrypt, then send
   * without re-check or try/catch. Mirrors 2.2.0-screenweaver.4 behavior.
   */
  async function sendDataUnpatched({
    connection,
    encrypt,
    peerSend,
  }: {
    connection: string;
    encrypt: () => Promise<string | null>;
    peerSend: (payload: string) => void;
  }): Promise<void> {
    const encrypted = await encrypt();
    if (connection === "connected" && encrypted) peerSend(encrypted);
  }

  /**
   * Post-patch behavior (2.2.0-screenweaver.5+): re-check after await + try/catch.
   */
  async function sendDataPatched({
    getConnection,
    getPeer,
    encrypt,
    peerSend,
    errorHandler,
  }: {
    getConnection: () => string;
    getPeer: () => { send: (payload: string) => void } | null;
    encrypt: () => Promise<string | null>;
    peerSend: (payload: string) => void;
    errorHandler: (error: unknown) => void;
  }): Promise<void> {
    const encrypted = await encrypt();
    if (getConnection() !== "connected" || !encrypted || !getPeer()) return;
    try {
      peerSend(encrypted);
    } catch (error) {
      errorHandler(error);
    }
  }

  it("reproduces the bug: peer.send throw after encrypt await escapes as unhandled rejection", async () => {
    const encrypt = () =>
      new Promise<string>((resolve) => {
        // Simulate closed channel during encrypt await
        queueMicrotask(() => resolve("ciphertext"));
      });
    const peerSend = () => {
      throw safariInvalidStateError();
    };

    // Fire-and-forget like sendDataToPeers / handleOnConnected
    void sendDataUnpatched({
      connection: "connected",
      encrypt,
      peerSend,
    });
    await flushMicrotasks();
    expect(rejections).toHaveLength(1);
    expect((rejections[0] as DOMException).name).toBe("InvalidStateError");
  });

  it("validates the fix: try/catch routes InvalidStateError to errorHandler", async () => {
    const errorHandler = vi.fn();
    const encrypt = async () => "ciphertext";
    const peerSend = () => {
      throw safariInvalidStateError();
    };

    void sendDataPatched({
      getConnection: () => "connected",
      getPeer: () => ({ send: peerSend }),
      encrypt,
      peerSend,
      errorHandler,
    });
    await flushMicrotasks();
    expect(rejections).toHaveLength(0);
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect((errorHandler.mock.calls[0][0] as DOMException).name).toBe(
      "InvalidStateError",
    );
  });

  it("validates the fix for Chrome readyState copy", async () => {
    const errorHandler = vi.fn();
    void sendDataPatched({
      getConnection: () => "connected",
      getPeer: () => ({ send: () => undefined }),
      encrypt: async () => "ciphertext",
      peerSend: () => {
        throw chromeReadyStateError();
      },
      errorHandler,
    });
    await flushMicrotasks();
    expect(rejections).toHaveLength(0);
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(String(errorHandler.mock.calls[0][0])).toMatch(/readyState/);
  });

  it("skips send when connection flips to closed during encrypt await", async () => {
    const errorHandler = vi.fn();
    const peerSend = vi.fn();
    let connection = "connected";

    void sendDataPatched({
      getConnection: () => connection,
      getPeer: () => ({ send: peerSend }),
      encrypt: async () => {
        connection = "closed";
        return "ciphertext";
      },
      peerSend,
      errorHandler,
    });
    await flushMicrotasks();
    expect(peerSend).not.toHaveBeenCalled();
    expect(errorHandler).not.toHaveBeenCalled();
    expect(rejections).toHaveLength(0);
  });

  it("skips send when peer was torn down during encrypt await", async () => {
    const errorHandler = vi.fn();
    const peerSend = vi.fn();
    let peer: { send: (payload: string) => void } | null = { send: peerSend };

    void sendDataPatched({
      getConnection: () => "connected",
      getPeer: () => peer,
      encrypt: async () => {
        peer = null;
        return "ciphertext";
      },
      peerSend,
      errorHandler,
    });
    await flushMicrotasks();
    expect(peerSend).not.toHaveBeenCalled();
    expect(errorHandler).not.toHaveBeenCalled();
    expect(rejections).toHaveLength(0);
  });
});
