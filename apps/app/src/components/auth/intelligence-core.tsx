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

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
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

    if (reduceMotion) {
      renderFrame(0);
    } else {
      const animate = () => {
        frameId = requestAnimationFrame(animate);
        renderFrame(clock.getElapsedTime());
      };
      animate();
    }

    return () => {
      if (frameId !== undefined) cancelAnimationFrame(frameId);
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
