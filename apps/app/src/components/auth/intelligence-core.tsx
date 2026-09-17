"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

const VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vPosition;

  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec3 pos = position;
    float morph = sin(pos.y * 4.0 + uTime * 2.0) * 0.08;
    morph += cos(pos.x * 3.2 + uTime * 1.6) * 0.06;
    pos += normal * morph;
    vPosition = (modelMatrix * vec4(pos, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vPosition;

  void main() {
    vec3 viewDir = normalize(cameraPosition - vPosition);
    float fresnel = pow(clamp(1.0 - dot(viewDir, vNormal), 0.0, 1.0), 2.5);

    float time = uTime * 1.5;
    float wave1 = sin(vPosition.y * 3.5 + time + sin(vPosition.x * 2.5));
    float wave2 = cos(vPosition.z * 4.0 - time * 0.8);

    vec3 cyanGlow = vec3(0.06, 0.85, 0.98);
    vec3 purpleGlow = vec3(0.55, 0.22, 0.98);
    vec3 magentaGlow = vec3(0.98, 0.18, 0.65);
    vec3 goldGlow = vec3(1.0, 0.75, 0.2);

    vec3 color = mix(cyanGlow, purpleGlow, wave1 * 0.5 + 0.5);
    color = mix(color, magentaGlow, wave2 * 0.5 + 0.5);

    vec3 finalColor = mix(color, goldGlow, fresnel * 0.4);
    finalColor += vec3(1.0) * pow(fresnel, 3.0) * 0.6;
    gl_FragColor = vec4(finalColor, 0.96);
  }
`;

/**
 * The mask shape belongs to the caller: the auth panel wants a circle, the
 * workspace rail a rounded square. Everything else about the render is fixed.
 */
const DEFAULT_MASK =
  "relative flex h-full w-full items-center justify-center overflow-hidden rounded-full";

/**
 * The morphing WebGL sphere in the auth panel header.
 *
 * Loaded only through `next/dynamic(..., { ssr: false })` so three.js lands in
 * its own chunk and never enters the login route's first load. Everything below
 * is about surviving mount/unmount cleanly:
 *
 *  - The container is read BEFORE the renderer is constructed. The other way
 *    round, an early return leaks a WebGLRenderer with no cleanup to undo it —
 *    and browsers cap live WebGL contexts, so a few remounts stop rendering.
 *  - React 18 StrictMode mounts effects twice in dev. Cleanup must therefore
 *    remove the canvas it appended, or the second pass stacks a second one.
 *  - `forceContextLoss()` releases the GPU context immediately instead of
 *    waiting for GC to get around to it.
 *  - `prefers-reduced-motion` renders a single frame and never starts the loop.
 */
export function IntelligenceCore({ className }: { className?: string }) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 3.2);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      // A hint only — asks the driver not to spin up the discrete GPU for an
      // ambient decoration. antialias and pixelRatio are deliberately left
      // alone: both are visible in the render, unlike this.
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // updateStyle=false kept the canvas at its intrinsic size instead of filling
    // the circular mask, which is what made the sphere sit off-centre and clip.
    // Drive the CSS box explicitly and derive aspect from the real dimensions.
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";

    const resize = () => {
      const w = Math.max(container.clientWidth, 1);
      const h = Math.max(container.clientHeight, 1);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    resize();
    container.appendChild(renderer.domElement);

    const observer = new ResizeObserver(resize);
    observer.observe(container);

    const geometry = new THREE.SphereGeometry(1.05, 64, 64);
    // Held as its own const rather than reached through material.uniforms.uTime,
    // whose index signature is `IUniform | undefined` under strict mode.
    const uTime = { value: 0 };
    const material = new THREE.ShaderMaterial({
      uniforms: { uTime },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
    });
    const sphere = new THREE.Mesh(geometry, material);
    scene.add(sphere);

    let frameId: number | undefined;
    const clock = new THREE.Clock();

    const renderFrame = (elapsed: number) => {
      uTime.value = elapsed;
      sphere.rotation.y = elapsed * 0.45;
      sphere.rotation.x = elapsed * 0.22;
      renderer.render(scene, camera);
    };

    // Bounds on an ambient loop that used to run flat out for the life of the
    // page. Measured on an otherwise idle /chat: the main thread was 55% busy,
    // and hiding this one canvas took it to 10% — i.e. ~82% of all idle
    // main-thread work was this render loop. Neither bound changes how the orb
    // looks while it is on screen.
    //
    //   1. Cap the rate. The sphere turns at 0.45 rad/s, so 30fps and 60fps are
    //      indistinguishable, and it halves the fill cost.
    //   2. Do not render what nobody can see. The rail collapses to w-0 and is
    //      display:none on mobile, but the element stays in the DOM, and rAF
    //      keeps firing for a background tab too.
    //   3. On touch devices (battery, phone GPU), rest while nobody is engaging
    //      with it: while a text field has focus, and after IDLE_MS without a
    //      touch or scroll; either resumes it. Measured on /login (emulated
    //      phone): the live orb kept the main thread 57% busy at idle against
    //      10% hidden, and moved typing latency p50 from 11 to 39 ms (Chromium)
    //      and from 195 to 340 ms (WebKit). Fine pointers keep rules 1-2 only.
    const FRAME_MS = 1000 / 30;
    const IDLE_MS = 8000;
    let lastMs = Number.NEGATIVE_INFINITY;
    let onScreen = true;
    let pageVisible = true;
    let visibility: IntersectionObserver | undefined;
    let onVisibilityChange: (() => void) | undefined;
    let engaged = true;
    let typing = false;
    let removeEngagement: (() => void) | undefined;

    if (reduceMotion) {
      renderFrame(0);
    } else {
      const animate = () => {
        frameId = requestAnimationFrame(animate);
        const ms = clock.getElapsedTime() * 1000;
        if (ms - lastMs < FRAME_MS) return;
        lastMs = ms;
        renderFrame(ms / 1000);
      };
      const start = () => {
        if (frameId === undefined && onScreen && pageVisible && engaged && !typing) {
          animate();
        }
      };
      const stop = () => {
        if (frameId !== undefined) {
          cancelAnimationFrame(frameId);
          frameId = undefined;
        }
      };

      // The clock is never stopped, so resuming continues from where wall time
      // says the animation should be rather than snapping back.
      visibility = new IntersectionObserver((entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        onScreen ? start() : stop();
      });
      visibility.observe(container);

      onVisibilityChange = () => {
        pageVisible = document.visibilityState !== "hidden";
        pageVisible ? start() : stop();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);

      if (window.matchMedia("(pointer: coarse)").matches) {
        const isField = (el: Element | null) =>
          !!el &&
          (el.matches("input, textarea, select") || (el as HTMLElement).isContentEditable);
        const sync = () => (engaged && !typing ? start() : stop());
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const wake = () => {
          engaged = true;
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            engaged = false;
            stop();
          }, IDLE_MS);
          sync();
        };
        // focusout fires before the next focusin; read where focus settled.
        const onFocusChange = () =>
          setTimeout(() => {
            typing = isField(document.activeElement);
            sync();
          }, 0);
        const opts = { capture: true, passive: true } as const;
        document.addEventListener("touchstart", wake, opts);
        document.addEventListener("pointerdown", wake, opts);
        document.addEventListener("scroll", wake, opts);
        document.addEventListener("focusin", onFocusChange);
        document.addEventListener("focusout", onFocusChange);
        typing = isField(document.activeElement);
        wake();
        removeEngagement = () => {
          clearTimeout(idleTimer);
          document.removeEventListener("touchstart", wake, opts);
          document.removeEventListener("pointerdown", wake, opts);
          document.removeEventListener("scroll", wake, opts);
          document.removeEventListener("focusin", onFocusChange);
          document.removeEventListener("focusout", onFocusChange);
        };
      }

      start();
    }

    return () => {
      if (frameId !== undefined) cancelAnimationFrame(frameId);
      visibility?.disconnect();
      removeEngagement?.();
      if (onVisibilityChange) {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      observer.disconnect();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      geometry.dispose();
      material.dispose();
      renderer.forceContextLoss();
      renderer.dispose();
    };
  }, []);

  return (
    <div
      ref={mountRef}
      aria-hidden="true"
      className={className ?? DEFAULT_MASK}
    />
  );
}
