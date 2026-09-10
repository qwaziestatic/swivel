/**
 * src/sidepanel/usePort.ts — the panel's long-lived Port to the hub.
 *
 * During a run, per-step updates stream over a chrome.runtime.Port instead
 * of one-off messages. The worker can die mid-run (Charter Law 1), which
 * disconnects the Port; this hook reconnects with EXPONENTIAL BACKOFF so a
 * revived worker resumes the stream without the panel busy-looping.
 *
 * Phase 4 stands up the transport; the first real step stream arrives in
 * Phase 6. Phase 8 hardens this further (runId in the Port name, idempotent
 * replay). The backoff math is factored out as a pure function so it can be
 * unit-tested without a live Port.
 */

import { useEffect, useRef } from "react";
import { isSwivelMessage, type SwivelMessage } from "../shared/messages";

const PORT_NAME = "swivel-panel";

/** Exponential backoff with a cap: base·2^attempt, clamped. Pure — tested. */
export function nextBackoffMs(attempt: number, baseMs = 500, capMs = 15_000): number {
  const raw = baseMs * 2 ** attempt;
  return Math.min(capMs, raw);
}

/**
 * Connect to the hub and deliver typed messages to `onMessage`. Returns
 * nothing — the connection lifecycle (including reconnect) is fully managed
 * internally and torn down on unmount. `onMessage` is held in a ref so a
 * changing callback identity never forces a reconnect.
 */
export function usePort(onMessage: (message: SwivelMessage) => void): void {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let port: chrome.runtime.Port | null = null;

    const connect = () => {
      if (disposed) return;
      port = chrome.runtime.connect({ name: PORT_NAME });

      port.onMessage.addListener((msg: unknown) => {
        // A successful message proves the link is healthy — reset backoff.
        attempt = 0;
        if (isSwivelMessage(msg)) onMessageRef.current(msg);
      });

      port.onDisconnect.addListener(() => {
        port = null;
        if (disposed) return;
        // Worker went away (idle eviction or crash). Schedule a reconnect;
        // each successive failure widens the gap up to the cap.
        const delay = nextBackoffMs(attempt);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      });
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      port?.disconnect();
    };
  }, []);
}
