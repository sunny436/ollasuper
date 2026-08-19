"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Speech-to-text for the composer, via the Web Speech API.
 *
 * Progressive enhancement: `supported` is false where the browser has no
 * SpeechRecognition (Firefox, some WebViews), and the caller hides the mic
 * entirely rather than showing a dead control. Every failure path — no API,
 * denied permission, network/no-speech errors — is swallowed silently: the chat
 * e2e suites assert zero console errors, so this must never log.
 *
 * The API is non-standard, so it is absent from TypeScript's lib.dom.d.ts; the
 * minimal shapes it actually uses are declared below.
 */

// --- minimal Web Speech typings (not in lib.dom.d.ts) ---
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/**
 * @param onText  called with each FINAL transcript chunk, to append to the
 *                composer. Interim results are ignored so the textarea does not
 *                flicker with half-recognised words.
 */
export function useDictation(onText: (chunk: string) => void) {
  // Compute support after mount to avoid an SSR/client mismatch (window is
  // undefined on the server, so the first client render must agree: start false).
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => {
    setSupported(getCtor() !== null);
    return () => {
      try {
        recRef.current?.abort();
      } catch {}
      recRef.current = null;
    };
  }, []);

  const toggle = useCallback(() => {
    if (listening) {
      try {
        recRef.current?.stop();
      } catch {}
      return;
    }
    const Ctor = getCtor();
    if (!Ctor) return;
    try {
      const rec = new Ctor();
      rec.lang =
        typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";
      rec.continuous = false;
      rec.interimResults = false;
      rec.onresult = (e) => {
        let out = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r?.isFinal) out += r[0]?.transcript ?? "";
        }
        const text = out.trim();
        if (text) onTextRef.current(text);
      };
      rec.onend = () => {
        setListening(false);
        recRef.current = null;
      };
      // Denied permission / no-speech / network — go quiet, never console.error.
      rec.onerror = () => {
        setListening(false);
      };
      recRef.current = rec;
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }, [listening]);

  return { supported, listening, toggle };
}
