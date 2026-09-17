/**
 * Real-device performance probe — opt-in via `?perf=1`, loaded by
 * perf-probe-loader.tsx only when enabled.
 *
 * WHY THIS EXISTS: emulation cannot reproduce a phone's GPU, thermal state or
 * radio, and the people who see the slowness test on their own phones without a
 * cable. This measures on the device itself and hands back numbers ("Copy
 * results") instead of impressions.
 *
 * WHAT IT MUST NOT DO:
 *  - change what it measures: no React (no extra renders), no backdrop-filter or
 *    animation in its own UI, the frame sampler runs only inside activity windows
 *    (input / scroll / streaming) and stops when the page is idle, the status line
 *    repaints at most once a second;
 *  - leak anything: no network request, no message text, conversation ids scrubbed.
 *
 * Every API used works in iOS Safari; Long Tasks, Event Timing and
 * performance.memory are Chromium-only and are reported as null elsewhere.
 */

import { frameBudget, isDropped, scrubPath, type Stat, summarize } from "./metrics";

const VERSION = 1;

/** Mirrors e2e/perf-checklist.md, in order. */
export const STEPS = [
  "cold-open",
  "type",
  "send-short",
  "send-long",
  "menus-dialogs",
  "scroll-long-thread",
  "background-return",
  "offline-return",
  "network-switch",
  "free",
] as const;

type FrameWindow = { frames: number; dropped: number; stalls: number[] };
type Send = { at: number; firstTokenMs: number | null; completeMs: number | null };

type StepData = {
  name: string;
  startedAt: number;
  taps: number[];
  typing: number[];
  eventTiming: number[];
  longTasks: number[];
  menus: number[];
  sends: Send[];
  scroll: FrameWindow;
  streaming: FrameWindow;
  other: FrameWindow;
};

const SEL_STOP = 'button[aria-label="Stop generating"]';
const SEL_SEND = 'button[aria-label="Send message"]';
/** The streaming assistant text (StreamingText sets aria-busy only while streaming). */
const SEL_STREAM_TEXT = '[aria-live="polite"][aria-busy="true"]';
const SEL_OPENED =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[aria-modal="true"],nav[aria-label="Conversations"]';

const newWindow = (): FrameWindow => ({ frames: 0, dropped: 0, stalls: [] });
const newStep = (name: string): StepData => ({
  name,
  startedAt: performance.now(),
  taps: [],
  typing: [],
  eventTiming: [],
  longTasks: [],
  menus: [],
  sends: [],
  scroll: newWindow(),
  streaming: newWindow(),
  other: newWindow(),
});

/** Time from an input event's creation until the frame after its handlers ran. */
function afterNextFrame(eventTimeStamp: number, record: (ms: number) => void) {
  requestAnimationFrame(() => {
    setTimeout(() => record(performance.now() - eventTimeStamp), 0);
  });
}

type ProbeWindow = Window & { __ollasuperPerfProbe?: boolean };

export function startProbe(): void {
  const w = window as ProbeWindow;
  if (w.__ollasuperPerfProbe) return;
  w.__ollasuperPerfProbe = true;

  const startedAt = performance.now();
  // "App usable" is measured from THIS document's navigation start; the path says
  // which page that was (a client-side navigation afterwards does not reset it).
  const loadPath = scrubPath(location.pathname);
  let stepIndex = 0;
  const steps: StepData[] = [newStep(STEPS[0])];
  const current = () => steps[steps.length - 1] as StepData;

  const events: { t: number; step: string; what: string }[] = [];
  const logEvent = (what: string) =>
    events.push({ t: Math.round(performance.now()), step: current().name, what });

  const memory: { t: number; heapMB: number | null; domNodes: number }[] = [];

  // ---- app usable -----------------------------------------------------------
  let appUsableMs: number | null = null;
  let appUsableUpperBound = false;
  const composerReady = () =>
    document.querySelector("#chat-composer:not([disabled])") !== null;
  if (composerReady()) {
    appUsableMs = Math.round(performance.now());
    appUsableUpperBound = true; // the probe loaded after the composer was enabled
  }

  // ---- UI -------------------------------------------------------------------
  const root = document.createElement("div");
  root.setAttribute("data-perf-probe", "");
  root.setAttribute("aria-label", "Performance probe");
  Object.assign(root.style, {
    position: "fixed",
    top: "calc(env(safe-area-inset-top, 0px) + 60px)",
    right: "6px",
    zIndex: "2147483647",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "4px",
    maxWidth: "calc(100vw - 12px)",
    padding: "4px",
    borderRadius: "10px",
    background: "rgba(15,23,42,0.94)",
    color: "#fff",
    font: "12px/1.25 system-ui, -apple-system, sans-serif",
    boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
  } satisfies Partial<CSSStyleDeclaration>);

  const button = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    Object.assign(b.style, {
      minWidth: "40px",
      height: "40px",
      padding: "0 8px",
      border: "1px solid rgba(255,255,255,0.25)",
      borderRadius: "8px",
      background: "rgba(255,255,255,0.08)",
      color: "#fff",
      font: "inherit",
    } satisfies Partial<CSSStyleDeclaration>);
    b.addEventListener("click", onClick);
    return b;
  };

  const label = document.createElement("span");
  label.style.minWidth = "120px";
  label.style.padding = "0 4px";
  const status = document.createElement("span");
  status.style.flexBasis = "100%";
  status.style.padding = "2px 4px";
  status.style.opacity = "0.8";

  let collapsed = false;
  const body: HTMLElement[] = [];
  const setStep = (i: number) => {
    stepIndex = Math.max(0, Math.min(STEPS.length - 1, i));
    const name = STEPS[stepIndex] ?? "free";
    if (current().name !== name) steps.push(newStep(name));
    label.textContent = `${stepIndex + 1}/${STEPS.length} ${name}`;
  };
  const prev = button("◀", "Previous step", () => setStep(stepIndex - 1));
  const next = button("▶", "Next step", () => setStep(stepIndex + 1));
  const copy = button("Copy", "Copy results", () => void copyResults());
  const reset = button("Reset", "Reset results", () => {
    steps.length = 0;
    steps.push(newStep(STEPS[stepIndex] ?? "free"));
    events.length = 0;
    memory.length = 0;
  });
  const toggle = button("PERF", "Collapse or expand the probe", () => {
    collapsed = !collapsed;
    for (const el of body) el.style.display = collapsed ? "none" : "";
  });
  body.push(prev, label, next, copy, reset, status);
  root.append(toggle, ...body);
  setStep(0);
  document.body.appendChild(root);

  const fromProbe = (t: EventTarget | null) => t instanceof Node && root.contains(t);

  // ---- frame sampler (activity windows only) --------------------------------
  let samplerOn = false;
  let activeUntil = 0;
  let lastScrollAt = Number.NEGATIVE_INFINITY;
  let lastFrame = 0;
  // Recent frame deltas; the budget comes from their 10th percentile, not the
  // single shortest one, so one stray short frame cannot flip 60 Hz to 120 Hz.
  const recent: number[] = [];
  // The refresh interval does not change within a session, so keep the best
  // (shortest) typical interval seen — a page janky from the start must not
  // calibrate its own slow frames as "normal".
  let refreshMs = Number.POSITIVE_INFINITY;
  let streaming = false;
  let pendingSend: Send | null = null;
  let lastTapAt = Number.NEGATIVE_INFINITY;
  let liveBefore = new Set<Element>();

  const frame = (now: number) => {
    // The first callback after a wake has no previous frame to measure against.
    const delta = lastFrame < 0 ? -1 : now - lastFrame;
    lastFrame = now;
    if (delta > 0 && delta < 1000) {
      recent.push(delta);
      if (recent.length > 60) recent.shift();
      const sorted = [...recent].sort((a, b) => a - b);
      if (sorted.length >= 20) {
        refreshMs = Math.min(refreshMs, sorted[Math.floor(sorted.length * 0.1)] ?? delta);
      }
      streaming = document.querySelector(SEL_STOP) !== null;
      const step = current();
      const win =
        now - lastScrollAt < 200 ? step.scroll : streaming ? step.streaming : step.other;
      win.frames++;
      if (isDropped(delta, frameBudget(refreshMs))) win.dropped++;
      if (delta > 50) win.stalls.push(delta);
    }
    if (pendingSend && pendingSend.firstTokenMs !== null && !streaming) {
      pendingSend.completeMs = Math.round(now - pendingSend.at);
      pendingSend = null;
    }
    if (now < activeUntil || streaming || pendingSend) {
      requestAnimationFrame(frame);
    } else {
      samplerOn = false;
    }
  };
  const wake = (ms = 1200) => {
    activeUntil = Math.max(activeUntil, performance.now() + ms);
    if (samplerOn || document.visibilityState !== "visible") return;
    samplerOn = true;
    lastFrame = -1;
    requestAnimationFrame(frame);
  };

  // ---- input latency ---------------------------------------------------------
  const opts = { capture: true, passive: true } as const;
  document.addEventListener(
    "click",
    (e) => {
      if (fromProbe(e.target)) return;
      const step = current();
      lastTapAt = e.timeStamp;
      wake();
      afterNextFrame(e.timeStamp, (ms) => step.taps.push(ms));
      const t = e.target instanceof Element ? e.target.closest(SEL_SEND) : null;
      if (t) {
        pendingSend = { at: e.timeStamp, firstTokenMs: null, completeMs: null };
        step.sends.push(pendingSend);
        liveBefore = new Set(document.querySelectorAll(SEL_STREAM_TEXT));
        wake(120000);
      }
    },
    opts,
  );
  document.addEventListener(
    "input",
    (e) => {
      if (fromProbe(e.target)) return;
      const step = current();
      wake();
      afterNextFrame(e.timeStamp, (ms) => step.typing.push(ms));
    },
    opts,
  );
  const onScroll = () => {
    lastScrollAt = performance.now();
    wake(400);
  };
  document.addEventListener("scroll", onScroll, opts);
  document.addEventListener("touchmove", onScroll, opts);

  // ---- mutations: app usable, menus/dialogs, first token ---------------------
  const observer = new MutationObserver((records) => {
    const now = performance.now();
    if (appUsableMs === null && composerReady()) appUsableMs = Math.round(now);
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!(n instanceof Element) || root.contains(n)) continue;
        const opened = n.matches(SEL_OPENED) ? n : n.querySelector(SEL_OPENED);
        if (opened && now - lastTapAt < 3000) {
          // Count it only once it is actually on screen, timed at that frame —
          // components mount hidden dialogs/listboxes that no tap opened.
          const tapAt = lastTapAt;
          const step = current();
          requestAnimationFrame(() => {
            const r = opened.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && getComputedStyle(opened).visibility !== "hidden") {
              step.menus.push(performance.now() - tapAt);
              lastTapAt = Number.NEGATIVE_INFINITY;
            }
          });
        }
        if (n.matches(SEL_STOP) || n.querySelector(SEL_STOP)) wake();
      }
    }
    if (pendingSend && pendingSend.firstTokenMs === null) {
      for (const el of document.querySelectorAll(SEL_STREAM_TEXT)) {
        if (!liveBefore.has(el) && (el.textContent ?? "").trim().length > 0) {
          pendingSend.firstTokenMs = Math.round(now - pendingSend.at);
          break;
        }
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["disabled"],
  });

  // ---- Chromium-only observers ------------------------------------------------
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  if (supported.includes("longtask")) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) current().longTasks.push(e.duration);
    }).observe({ type: "longtask", buffered: false });
  }
  if (supported.includes("event")) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) current().eventTiming.push(e.duration);
    }).observe({ type: "event", buffered: false, durationThreshold: 16 } as PerformanceObserverInit);
  }

  // ---- lifecycle, network, memory ----------------------------------------------
  document.addEventListener("visibilitychange", () => logEvent(`visibility:${document.visibilityState}`));
  window.addEventListener("online", () => logEvent("online"));
  window.addEventListener("offline", () => logEvent("offline"));
  const sampleMemory = () => {
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    memory.push({
      t: Math.round(performance.now()),
      heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
      domNodes: document.getElementsByTagName("*").length,
    });
    if (memory.length > 360) memory.shift();
  };
  sampleMemory();
  setInterval(() => {
    if (document.visibilityState === "visible") sampleMemory();
  }, 10000);

  // ---- status + report -------------------------------------------------------
  setInterval(() => {
    if (collapsed || document.visibilityState !== "visible") return;
    const s = current();
    const drops = s.scroll.dropped + s.streaming.dropped + s.other.dropped;
    const frames = s.scroll.frames + s.streaming.frames + s.other.frames;
    const stalls = s.scroll.stalls.length + s.streaming.stalls.length + s.other.stalls.length;
    const tap = summarize(s.taps)?.p90 ?? "-";
    const typ = summarize(s.typing)?.p90 ?? "-";
    status.textContent = `tap p90 ${tap} · type p90 ${typ} · drop ${drops}/${frames} · stalls ${stalls} · sends ${s.sends.length}`;
  }, 1000);

  const windowReport = (win: FrameWindow) => ({
    frames: win.frames,
    dropped: win.dropped,
    droppedPct: win.frames ? Math.round((win.dropped / win.frames) * 1000) / 10 : null,
    stalls: summarize(win.stalls),
    stalledMs: Math.round(win.stalls.reduce((a, b) => a + b, 0)),
  });
  const statOrNull = (xs: number[]): Stat | null => summarize(xs);

  const report = () => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    const conn = (navigator as Navigator & {
      connection?: { effectiveType?: string; rtt?: number; downlink?: number };
    }).connection;
    const mainApp = [...document.scripts]
      .map((s) => s.src)
      .find((src) => src.includes("main-app-"));
    return {
      probe: VERSION,
      at: new Date().toISOString(),
      build: mainApp?.match(/main-app-([a-f0-9]+)/)?.[1] ?? null,
      ua: navigator.userAgent,
      dpr: window.devicePixelRatio,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      orientation: window.innerWidth > window.innerHeight ? "landscape" : "portrait",
      connection: conn
        ? { type: conn.effectiveType ?? null, rttMs: conn.rtt ?? null, downMbps: conn.downlink ?? null }
        : null,
      path: scrubPath(location.pathname),
      load: {
        loadPath,
        appUsableMs,
        appUsableUpperBound,
        probeLoadedMs: Math.round(startedAt),
        ttfbMs: nav ? Math.round(nav.responseStart) : null,
        fcpMs: fcp ? Math.round(fcp.startTime) : null,
        domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      },
      steps: steps
        .filter((s) => s.taps.length || s.typing.length || s.sends.length || s.scroll.frames || s.streaming.frames || s.other.frames || s.menus.length)
        .map((s) => ({
          step: s.name,
          tapLatency: statOrNull(s.taps),
          typingLatency: statOrNull(s.typing),
          eventTimingOver16ms: supported.includes("event") ? statOrNull(s.eventTiming) : "unsupported",
          longTasks: supported.includes("longtask") ? statOrNull(s.longTasks) : "unsupported",
          menuDialogOpenMs: statOrNull(s.menus),
          sends: s.sends.map((x) => ({ firstTokenMs: x.firstTokenMs, completeMs: x.completeMs })),
          scrollFrames: windowReport(s.scroll),
          streamingFrames: windowReport(s.streaming),
          otherFrames: windowReport(s.other),
        })),
      refreshMs: Number.isFinite(refreshMs) ? Math.round(refreshMs * 10) / 10 : null,
      memory: {
        heapMB: memory.some((m) => m.heapMB !== null)
          ? { first: memory[0]?.heapMB ?? null, max: Math.max(...memory.map((m) => m.heapMB ?? 0)), last: memory[memory.length - 1]?.heapMB ?? null }
          : "unsupported",
        domNodes: { first: memory[0]?.domNodes ?? null, max: Math.max(...memory.map((m) => m.domNodes)), last: memory[memory.length - 1]?.domNodes ?? null },
      },
      events,
    };
  };

  const copyResults = async () => {
    const text = JSON.stringify(report());
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Copied";
      setTimeout(() => {
        copy.textContent = "Copy";
      }, 1500);
    } catch {
      // Clipboard blocked: show the JSON selected so it can be copied by hand.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.readOnly = true;
      Object.assign(ta.style, {
        position: "fixed",
        inset: "10% 5%",
        zIndex: "2147483647",
        font: "11px monospace",
      } satisfies Partial<CSSStyleDeclaration>);
      ta.addEventListener("blur", () => ta.remove());
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
    }
  };
}
