"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { StageState } from "./CameraRig";
import { scrollState } from "@/lib/scrollStore";

/**
 * ACT III — the time corridor.
 *
 * A run of concentric rings receding along -Z, each one a moment in the
 * append-only event log. The camera pulls back into it at the end of the
 * scroll, so the reader finishes the page looking *down the log itself*.
 *
 * This is the piece of the scene most directly derived from the data model
 * rather than from a reference image. Gitamesh's log is append-only and state
 * is derived by replaying it; fencing tokens are monotonic, so the log has a
 * direction. A corridor is what a monotonic, replayable sequence actually
 * looks like when you stand at one end of it: strata behind you, strata ahead,
 * and a position along the axis that is exactly the cursor `listEventsSince`
 * takes. Scroll is that cursor.
 *
 * MOTION GRAMMAR — the two vocabularies are kept strictly separate, because
 * they are two different domain behaviours:
 *   - Claims fire as DISCRETE snaps: a ring's marker ignites orange on a
 *     single frame and decays. Nothing eases in.
 *   - The corridor's overall presence fades CONTINUOUSLY, like a lease
 *     decaying rather than an event occurring.
 *
 * Orange is kept rare on purpose. At any moment only a couple of rings out of
 * the whole corridor carry an event; if every ring pulsed, an event would stop
 * reading as an event.
 *
 * COST: two draw calls total (one `LineSegments` for every ring, one `Points`
 * for the event markers), both from buffers built once at mount. Per frame
 * this writes one material opacity and one attribute range — the marker
 * colours — which is why a corridor of 34 rings is affordable on top of an
 * already-persistent canvas.
 *
 * SWAP SEAM: `buildCorridor()` returns plain buffers. Swapping in an authored
 * `.glb` means replacing that function and the geometry it feeds; the
 * choreography, tier gating and reduced-motion handling live outside it.
 */

const RING_COUNT = 34;
const RING_SPACING = 2.6;
const RING_RADIUS = 7.4;
const RING_SEGMENTS = 48;
/** Z of the nearest ring — behind the globe, so the corridor opens beyond it. */
const RING_START = -5;

function buildCorridor() {
  const lines: number[] = [];
  const markers: number[] = [];

  for (let r = 0; r < RING_COUNT; r++) {
    const z = RING_START - r * RING_SPACING;
    // Rings taper very slightly with distance so the corridor reads as
    // converging rather than as a cylinder of identical hoops.
    const radius = RING_RADIUS * (1 - r / (RING_COUNT * 3.2));

    for (let s = 0; s < RING_SEGMENTS; s++) {
      const a0 = (s / RING_SEGMENTS) * Math.PI * 2;
      const a1 = ((s + 1) / RING_SEGMENTS) * Math.PI * 2;
      lines.push(
        Math.cos(a0) * radius, Math.sin(a0) * radius, z,
        Math.cos(a1) * radius, Math.sin(a1) * radius, z
      );
    }

    // One event marker per ring, at a deterministic angle so the markers
    // spiral gently down the corridor instead of lining up in a seam.
    const angle = r * 2.399963;
    markers.push(Math.cos(angle) * radius, Math.sin(angle) * radius, z);
  }

  return {
    lines: new Float32Array(lines),
    markers: new Float32Array(markers),
    markerColors: new Float32Array(RING_COUNT * 3),
  };
}

const TEAL = new THREE.Color("#4fd1c5");
const ORANGE = new THREE.Color("#FF6B35");

export function TimeCorridor({
  reducedMotion,
  stageRef,
}: {
  reducedMotion: boolean;
  stageRef: React.MutableRefObject<StageState>;
}) {
  const { lines, markers, markerColors } = useMemo(buildCorridor, []);
  const lineMatRef = useRef<THREE.LineBasicMaterial>(null);
  const markerMatRef = useRef<THREE.PointsMaterial>(null);
  const colorAttrRef = useRef<THREE.BufferAttribute>(null);
  const presence = useRef(0);
  /** Per-ring event intensity, decayed each frame. */
  const heat = useRef(new Float32Array(RING_COUNT));
  const fireClock = useRef(0);

  // Seed a resting teal so the corridor is never colourless on its first frame.
  useEffect(() => {
    for (let i = 0; i < RING_COUNT; i++) {
      markerColors[i * 3] = TEAL.r;
      markerColors[i * 3 + 1] = TEAL.g;
      markerColors[i * 3 + 2] = TEAL.b;
    }
  }, [markerColors]);

  useFrame((_, delta) => {
    const stage = stageRef.current;

    // Continuous vocabulary: the corridor arrives as the graph dims, i.e. as
    // the camera withdraws down the log axis in the closing act.
    const target = reducedMotion ? 0.25 : Math.max(0, 1 - stage.dim);
    const k = reducedMotion ? 1 : 1 - Math.pow(0.02, delta);
    presence.current += (target - presence.current) * k;

    if (lineMatRef.current) {
      lineMatRef.current.opacity = presence.current * 0.42;
      lineMatRef.current.visible = presence.current > 0.004;
    }
    if (markerMatRef.current) {
      markerMatRef.current.opacity = presence.current;
      markerMatRef.current.visible = presence.current > 0.004;
    }
    if (reducedMotion || presence.current <= 0.004) return;

    // Discrete vocabulary: events land on a single frame, then decay. The
    // ring chosen is keyed to the scroll cursor, so scrubbing the page really
    // is scrubbing which part of the log is currently firing.
    fireClock.current += delta;
    if (fireClock.current > 0.28) {
      fireClock.current = 0;
      const cursor = Math.floor(scrollState.page * RING_COUNT);
      const ring = (cursor + Math.floor(Math.random() * 5)) % RING_COUNT;
      heat.current[ring] = 1;
    }

    const decay = Math.pow(0.12, delta);
    for (let i = 0; i < RING_COUNT; i++) {
      heat.current[i] *= decay;
      const h = heat.current[i];
      markerColors[i * 3] = TEAL.r + (ORANGE.r - TEAL.r) * h;
      markerColors[i * 3 + 1] = TEAL.g + (ORANGE.g - TEAL.g) * h;
      markerColors[i * 3 + 2] = TEAL.b + (ORANGE.b - TEAL.b) * h;
    }
    if (colorAttrRef.current) colorAttrRef.current.needsUpdate = true;
  });

  return (
    <group>
      <lineSegments frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            count={lines.length / 3}
            array={lines}
            itemSize={3}
          />
        </bufferGeometry>
        <lineBasicMaterial
          ref={lineMatRef}
          color="#2c5a56"
          transparent
          opacity={0}
          depthWrite={false}
        />
      </lineSegments>

      <points frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            count={RING_COUNT}
            array={markers}
            itemSize={3}
          />
          <bufferAttribute
            ref={colorAttrRef}
            attach="attributes-color"
            count={RING_COUNT}
            array={markerColors}
            itemSize={3}
          />
        </bufferGeometry>
        <pointsMaterial
          ref={markerMatRef}
          vertexColors
          size={0.16}
          sizeAttenuation
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </group>
  );
}
