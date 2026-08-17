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
    float morph = sin(pos.y * 3.5 + uTime * 1.8) * 0.07;
    morph += cos(pos.x * 2.8 + uTime * 1.4) * 0.05;
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
    float fresnel = pow(clamp(1.0 - dot(viewDir, vNormal), 0.0, 1.0), 2.2);

    float time = uTime * 1.2;
    float wave = sin(vPosition.y * 3.0 + time + sin(vPosition.x * 2.0));

    vec3 baseBlue = vec3(0.0, 0.48, 1.0);
    vec3 cyanGlow = vec3(0.18, 0.82, 0.98);
    vec3 purpleGlow = vec3(0.42, 0.22, 0.92);

    vec3 color = mix(baseBlue, cyanGlow, wave * 0.5 + 0.5);
    color = mix(color, purpleGlow, fresnel);

    vec3 finalColor = mix(color, vec3(1.0), fresnel * 0.55);
    gl_FragColor = vec4(finalColor, 0.95);
  }
`;

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
export function IntelligenceCore() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = 3.2;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const resize = () => {
      const size = Math.max(container.clientWidth, 1);
      renderer.setSize(size, size, false);
      camera.aspect = 1;
      camera.updateProjectionMatrix();
    };
    resize();
    container.appendChild(renderer.domElement);

    const observer = new ResizeObserver(resize);
    observer.observe(container);

    const geometry = new THREE.SphereGeometry(1.1, 64, 64);
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
      sphere.rotation.y = elapsed * 0.35;
      sphere.rotation.x = elapsed * 0.15;
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

  return <div ref={mountRef} aria-hidden="true" className="h-full w-full" />;
}
