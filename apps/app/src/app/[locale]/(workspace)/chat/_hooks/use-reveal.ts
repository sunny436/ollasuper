"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Reveal streamed text smoothly, without ever fighting the stream.
 *
 * WHY NOT A TYPEWRITER OVER THE WHOLE STRING
 * The obvious implementation animates a complete string character by character
 * and resets on change. That is wrong here: the text is ALREADY arriving
 * incrementally (message-list.tsx throttles it to ~16 updates/sec), so a reset
 * on every change would restart the reply from empty ~16 times a second and it
 * would never finish rendering.
 *
 * WHY NOT A FIXED chars/sec
 * Measured against real generations on this deployment, output lands between
 * 39 and 268 chars/sec (haiku: 961 chars in 3754ms; opus-5: 170 in 4345ms). A
 * fixed 60 chars/sec would still be typing out a 961-character reply sixteen
 * seconds after the model had stopped. No single rate is right for that range.
 *
 * SO: EXPONENTIAL CONVERGENCE. Each frame closes a fixed FRACTION of whatever
 * is outstanding, which self-corrects at any speed — the visible text trails
 * the stream by a roughly constant ~150ms whether the model emits 40 or 400
 * chars/sec. A 1000-character burst is >99% revealed within ~0.5s; a slow
 * trickle still appears character by character.
 *
 * Monotonic by construction: `revealed` only ever increases and is clamped to
 * what has actually arrived, so this cannot restart, flicker, or invent text.
 */

/** Fraction of the outstanding backlog to close per 60fps-frame of ELAPSED time. */
const K = 0.12;
/** Always make progress, so a 1-2 char backlog cannot stall on rounding. */
const MIN_STEP = 1;
/** One 60fps frame, the time-unit K is defined against. */
const BASE_FRAME_MS = 1000 / 60;
/** Cap React commits at ~30/sec — indistinguishable to the eye, half the renders
 *  and half the markdown reparses of a fast stream. rAF still drives scheduling;
 *  only the state commit is throttled, and K is scaled by real elapsed time so
 *  the visual convergence rate is unchanged from the old per-frame version. */
const COMMIT_MS = 1000 / 30;

export function useReveal(text: string, active: boolean): string {
  const [revealed, setRevealed] = useState(() => (active ? 0 : text.length));
  const frame = useRef<number | null>(null);
  const count = useRef(revealed);
  const lastCommit = useRef<number | null>(null);

  // Reduced motion is a preference, not a nicety: skip the animation entirely.
  // Read in an effect (not during render) — matchMedia does not exist on the
  // server, and a render-time read is a hydration mismatch, which React
  // reports via console.error and every e2e script fails the run on.
  const [instant, setInstant] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setInstant(mq.matches);
    const onChange = () => setInstant(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    // Not streaming any more (finalize, stop, error) — show everything. With
    // convergence the outstanding backlog at this point is only ~150ms of
    // text, so this reads as the last few characters landing rather than as a
    // jump, which keeps the stream->settled handoff seamless.
    if (!active || instant) {
      count.current = text.length;
      setRevealed(text.length);
      return;
    }

    // A shorter string means a different message is now in this slot (a retry,
    // or a new turn). Start it from zero rather than showing a stale tail.
    if (text.length < count.current) {
      count.current = 0;
      setRevealed(0);
      lastCommit.current = null;
    }

    const step = (now: number) => {
      const backlog = text.length - count.current;
      if (backlog <= 0) {
        frame.current = null;
        return;
      }
      const last = lastCommit.current;
      // Throttle the COMMIT to ~30/sec; keep the rAF loop alive so a later frame
      // lands the commit. Nothing is skipped — only coalesced.
      if (last !== null && now - last < COMMIT_MS) {
        frame.current = requestAnimationFrame(step);
        return;
      }
      // Close a fraction of the backlog scaled by the REAL elapsed time, so a
      // 30Hz commit closes as much as two old 60Hz frames did — same convergence.
      const elapsed = last === null ? BASE_FRAME_MS : now - last;
      const effectiveK = 1 - (1 - K) ** (elapsed / BASE_FRAME_MS);
      count.current = Math.min(
        text.length,
        count.current + Math.max(MIN_STEP, Math.ceil(backlog * effectiveK)),
      );
      lastCommit.current = now;
      setRevealed(count.current);
      frame.current = requestAnimationFrame(step);
    };

    if (frame.current === null) frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [text, active, instant]);

  // slice() rather than storing a substring: the source string is the single
  // source of truth, so a re-render can never show text that was never sent.
  return revealed >= text.length ? text : text.slice(0, revealed);
}
