"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom, Vignette, Noise } from "@react-three/postprocessing";
import * as THREE from "three";
import { Constellation } from "./scene/Constellation";
import { AmbientField } from "./scene/AmbientField";
import { getDeviceTier, TIER_SETTINGS } from "./scene/deviceTier";

/**
 * Subtle camera parallax on pointer movement — a small offset applied on
 * top of the scene's own auto-rotation, giving the constellation real
 * depth-of-field-adjacent parallax as the viewer's mouse moves. Skipped
 * entirely under prefers-reduced-motion.
 */
function CameraParallax({ reducedMotion }: { reducedMotion: boolean }) {
  const { camera, pointer } = useThree();
  const target = useRef(new THREE.Vector3(0, 0, 8.5));

  useFrame(() => {
    if (reducedMotion) return;
    target.current.x = pointer.x * 0.5;
    target.current.y = pointer.y * 0.3;
    camera.position.x += (target.current.x - camera.position.x) * 0.04;
    camera.position.y += (target.current.y - camera.position.y) * 0.04;
    camera.lookAt(0, 0, 0);
  });

  return null;
}

function ScrollCamera({
  reducedMotion,
  scrollProgressRef,
}: {
  reducedMotion: boolean;
  scrollProgressRef: React.MutableRefObject<number>;
}) {
  const { camera } = useThree();
  useFrame(() => {
    if (reducedMotion) return;
    // Scroll-linked dolly: the constellation drifts closer as the hero
    // scrolls past, echoing a scroll-scrubbed camera move rather than a
    // scene that only ever animates on its own timer. Reads a plain ref
    // (updated by a passive scroll listener), never React state, so
    // scrolling never forces a re-render of the scene graph.
    const targetZ = 8.5 - scrollProgressRef.current * 1.6;
    camera.position.z += (targetZ - camera.position.z) * 0.08;
  });
  return null;
}

export function MeshScene({ reducedMotion }: { reducedMotion: boolean }) {
  const [dense, setDense] = useState(true);
  const [tier, setTier] = useState<"low" | "mid" | "high">("high");
  const scrollProgressRef = useRef(0);

  useEffect(() => {
    const el = document.getElementById("hero-3d-root");
    if (!el || reducedMotion) return;
    let ticking = false;
    const update = () => {
      ticking = false;
      const rect = el.getBoundingClientRect();
      const viewportH = window.innerHeight || 1;
      const total = rect.height + viewportH;
      const traveled = viewportH - rect.top;
      scrollProgressRef.current = Math.min(1, Math.max(0, traveled / total));
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [reducedMotion]);

  const settings = TIER_SETTINGS[tier];

  return (
    <Canvas
      dpr={settings.dpr}
      frameloop={reducedMotion ? "demand" : "always"}
      camera={{ position: [0, 0, 8.5], fov: 45 }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      onCreated={({ gl, size }) => {
        gl.setClearColor("#000000", 0);
        setDense(size.width > 640);
        setTier(getDeviceTier(size.width));
      }}
      aria-hidden="true"
    >
      <fog attach="fog" args={["#05070a", 7, 15]} />
      <ambientLight intensity={0.6} />
      <pointLight position={[5, 5, 5]} intensity={40} color="#4fd1c5" />

      <ScrollCamera reducedMotion={reducedMotion} scrollProgressRef={scrollProgressRef} />
      <Constellation reducedMotion={reducedMotion} dense={dense} scrollProgressRef={scrollProgressRef} />
      <AmbientField count={settings.particles} reducedMotion={reducedMotion} />
      <CameraParallax reducedMotion={reducedMotion} />

      {settings.postFx && (
        <Suspense fallback={null}>
          <EffectComposer multisampling={0}>
            <Bloom
              intensity={0.85}
              luminanceThreshold={0.18}
              luminanceSmoothing={0.35}
              mipmapBlur
            />
            <Noise premultiply opacity={0.035} />
            <Vignette eskil={false} offset={0.25} darkness={0.9} />
          </EffectComposer>
        </Suspense>
      )}
    </Canvas>
  );
}
