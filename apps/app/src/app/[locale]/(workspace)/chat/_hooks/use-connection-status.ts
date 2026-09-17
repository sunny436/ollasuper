"use client";

import { useConvex } from "convex/react";
import { useEffect, useState } from "react";

export type ConnectionStatus = "online" | "offline" | "reconnecting";

/** A drop shorter than this is a blip, not something to announce. */
const GRACE_MS = 2000;
/** convex 1.19 exposes connection state by polling only; this is the cadence. */
const POLL_MS = 2000;

/** Tracked across polls: whether the socket has ever connected, and since when it is down. */
export type SocketMemory = { everConnected: boolean; downSince: number | null };

/**
 * The status to show for one observation. Pure, so the rules are unit tested:
 * offline wins; a connected socket is online; before the first connection nothing
 * is announced (page load); a drop is announced only after GRACE_MS.
 */
export function nextStatus(
  browserOnline: boolean,
  socketConnected: boolean,
  now: number,
  memory: SocketMemory,
): ConnectionStatus {
  if (!browserOnline) return "offline";
  if (socketConnected) {
    memory.everConnected = true;
    memory.downSince = null;
    return "online";
  }
  if (!memory.everConnected) return "online";
  memory.downSince ??= now;
  return now - memory.downSince >= GRACE_MS ? "reconnecting" : "online";
}

/**
 * Whether messages can reach the server right now.
 *
 * WHY: measured on emulated phones against production (e2e/qa-mobile-perf.js
 * --mode network), a send made while offline or during a reconnect showed
 * nothing at all — no bubble, no message — and the first token arrived 6 s after
 * the network came back. To the user that is indistinguishable from a frozen app.
 *
 * `offline` comes from the browser's own online/offline events (instant).
 * `reconnecting` is Convex's socket being down for longer than GRACE_MS after it
 * had connected at least once, so the normal first connect on page load never
 * flashes a warning. Polling runs only while the page is visible.
 */
export function useConnectionStatus(): ConnectionStatus {
  const convex = useConvex();
  const [status, setStatus] = useState<ConnectionStatus>("online");

  useEffect(() => {
    const memory: SocketMemory = { everConnected: false, downSince: null };
    let timer: ReturnType<typeof setInterval> | undefined;

    const read = () =>
      setStatus(
        nextStatus(
          navigator.onLine,
          convex.connectionState().isWebSocketConnected,
          Date.now(),
          memory,
        ),
      );
    const poll = () => {
      clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== "visible") return;
      read();
      timer = setInterval(read, POLL_MS);
    };

    poll();
    window.addEventListener("online", read);
    window.addEventListener("offline", read);
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", read);
      window.removeEventListener("offline", read);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [convex]);

  return status;
}
