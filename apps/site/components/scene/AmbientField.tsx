"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import "./materials";

type AmbientFieldMaterialImpl = THREE.ShaderMaterial & {
  uTime: number;
  uPixelRatio: number;
};

/**
 * Deep background particle field — a single `THREE.Points` draw call whose
 * per-vertex drift is computed entirely in the vertex shader (GLSL simplex
 * noise, see materials.ts). No per-frame CPU writes to position data: only
 * the `uTime` uniform advances, so hundreds of particles cost one shader
 * dispatch rather than hundreds of scene-graph updates.
 */
export function AmbientField({
  count,
  // Pushed out from 9: the camera track now travels between z 7.2 and 16.5,
  // and at the old radius the shell intersected the camera — particles
  // passing through the near plane were what produced the oversized bokeh.
  radius = 15,
  reducedMotion,
}: {
  count: number;
  radius?: number;
  reducedMotion: boolean;
}) {
  const materialRef = useRef<AmbientFieldMaterialImpl>(null);

  const { positions, seeds, sizes } = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Sample a shell around the constellation so particles read as
      // depth-haze behind it, not as more nodes.
      const r = radius * (0.65 + Math.random() * 0.6);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
      seeds[i] = Math.random();
      sizes[i] = 0.6 + Math.random() * 1.6;
    }
    return { positions, seeds, sizes };
  }, [count, radius]);

  useFrame((_, delta) => {
    if (materialRef.current && !reducedMotion) {
      materialRef.current.uTime += delta;
    }
  });

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={count}
          array={positions}
          itemSize={3}
        />
        <bufferAttribute
          attach="attributes-aSeed"
          count={count}
          array={seeds}
          itemSize={1}
        />
        <bufferAttribute
          attach="attributes-aSize"
          count={count}
          array={sizes}
          itemSize={1}
        />
      </bufferGeometry>
      <ambientFieldMaterial
        ref={materialRef}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        uPixelRatio={typeof window !== "undefined" ? window.devicePixelRatio : 1}
      />
    </points>
  );
}
