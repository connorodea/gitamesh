"use client";

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { scrollState } from "@/lib/scrollStore";

/**
 * The scene's narrative state at a given scroll position.
 *
 * `spread` and `order` are read by the constellation, not the camera — they
 * live here because they belong to the same authored track as the camera
 * move. One timeline, one place to tune it.
 */
export type StageState = {
  /** Uniform scale on the constellation. >1 scatters it, <1 tightens it. */
  spread: number;
  /** 0 = incoherent graph, 1 = fully coordinated. Drives edge presence. */
  order: number;
  /** Global fade of the graph as the scene recedes behind closing sections. */
  dim: number;
  /** Multiplier on the claim cadence — order arriving reads as faster traffic. */
  tempo: number;
  /**
   * 0 = one whole globe; 1 = fully fissioned, daughter globes flung wide.
   * Drives how far the daughter swarm has separated from the parent mesh.
   */
  fission: number;
};

type Keyframe = StageState & {
  /** Page scroll progress, 0..1, at which this keyframe is exact. */
  at: number;
  position: [number, number, number];
};

/**
 * The four-act track.
 *
 * This is the change that turns a 3D hero into a cinematic page: the scene is
 * not a decorative loop that happens near the top, it is scrubbed by the
 * reader and its state *argues the page's copy*.
 *
 *   I.   Hero (0.00)      — the mesh, centred and coherent. The product.
 *   II.  Problem (0.26)   — camera swings off-axis and pulls back while the
 *                           constellation scatters and its wiring fades to a
 *                           ghost. This is "more agents, same repo, no
 *                           traffic control" rendered rather than described.
 *   III. Primitives (0.56)— the mesh contracts into a tight, ordered lattice,
 *                           edges re-light, claim traffic speeds up. The four
 *                           primitives imposing order, shown as it is read.
 *   IV.  Quickstart (0.82)— the camera withdraws and the graph dims, handing
 *                           the screen to the terminal block. The scene knows
 *                           when to stop being the subject.
 *
 * Interpolation is smoothstep between adjacent keyframes, then the result is
 * additionally damped per-frame — so even a hard scroll jump (keyboard Page
 * Down, a hash link) resolves as a camera move rather than a cut.
 */
const TRACK: Keyframe[] = [
  // The opening framing is deliberately WIDE. The reference this page is
  // chasing keeps its subject at roughly a quarter of the frame and lets the
  // rest be empty — restraint is most of what reads as expensive, and a
  // constellation crowding the headline reads as a busy widget instead. It
  // also buys the type the quiet it needs.
  { at: 0.0, position: [0, 0, 12.4], spread: 0.82, order: 0.9, dim: 1.0, tempo: 1.0, fission: 0.0 },
  { at: 0.26, position: [3.6, 1.1, 13.6], spread: 1.18, order: 0.06, dim: 1.0, tempo: 0.55, fission: 0.32 },
  { at: 0.56, position: [-2.2, -0.7, 9.4], spread: 0.78, order: 1.0, dim: 1.0, tempo: 2.1, fission: 0.62 },
  { at: 0.82, position: [0.8, 1.6, 15.5], spread: 0.9, order: 0.8, dim: 0.5, tempo: 1.0, fission: 0.9 },
  // The closing act rises and pulls back into a high, near-isometric read of
  // the mesh sitting above the lattice field — the one scene from the
  // reference that is not decoration here, because a coordination mesh
  // rendered as an explicit lattice is the product's actual thesis.
  { at: 1.0, position: [0, 1.4, 15.0], spread: 1.0, order: 0.6, dim: 0.2, tempo: 0.8, fission: 1.0 },
];

const smoothstep = (t: number) => t * t * (3 - 2 * t);

function sampleTrack(p: number, out: StageState & { position: THREE.Vector3 }) {
  let i = 0;
  while (i < TRACK.length - 2 && p > TRACK[i + 1].at) i++;
  const a = TRACK[i];
  const b = TRACK[i + 1];
  const span = b.at - a.at || 1;
  const t = smoothstep(Math.min(1, Math.max(0, (p - a.at) / span)));

  out.position.set(
    a.position[0] + (b.position[0] - a.position[0]) * t,
    a.position[1] + (b.position[1] - a.position[1]) * t,
    a.position[2] + (b.position[2] - a.position[2]) * t
  );
  out.spread = a.spread + (b.spread - a.spread) * t;
  out.order = a.order + (b.order - a.order) * t;
  out.dim = a.dim + (b.dim - a.dim) * t;
  out.tempo = a.tempo + (b.tempo - a.tempo) * t;
  out.fission = a.fission + (b.fission - a.fission) * t;
}

/** The state a reduced-motion visitor sees: act I, held still, fully coherent. */
export const STATIC_STAGE: StageState = {
  spread: 0.82,
  order: 1,
  dim: 1,
  tempo: 1,
  // A reduced-motion visitor sees a partially-fissioned swarm held still:
  // enough separation that the daughter globes and their filaments are
  // legible as a distributed mesh, with none of the drift.
  fission: 0.45,
};

/**
 * Drives the camera along the track and publishes the narrative scalars into
 * `stageRef` for the constellation to consume.
 *
 * Pointer parallax is folded in here rather than living in a second component,
 * so exactly one thing writes `camera.position` each frame — the previous
 * split (one component owning x/y, another owning z) meant two damped systems
 * fighting over the same transform.
 *
 * Under prefers-reduced-motion this returns before touching the camera at all:
 * no scroll scrub, no parallax, no drift. The camera stays exactly where the
 * Canvas placed it and `stageRef` keeps its static values.
 */
export function CameraRig({
  reducedMotion,
  stageRef,
}: {
  reducedMotion: boolean;
  stageRef: React.MutableRefObject<StageState>;
}) {
  const { camera, pointer } = useThree();
  const sample = useRef({
    position: new THREE.Vector3(0, 0, 12.4),
    ...STATIC_STAGE,
  });

  useFrame((_, delta) => {
    if (reducedMotion) return;

    sampleTrack(scrollState.page, sample.current);

    // Pointer parallax rides on top of the authored position — a small
    // offset, not a competing target, so the track always wins the framing.
    const px = pointer.x * 0.55;
    const py = pointer.y * 0.34;

    // Frame-rate-independent damping: a fixed lerp factor makes the move
    // twice as fast on a 120Hz display as on a 60Hz one.
    const k = 1 - Math.pow(0.0022, delta);

    camera.position.x += (sample.current.position.x + px - camera.position.x) * k;
    camera.position.y += (sample.current.position.y + py - camera.position.y) * k;
    camera.position.z += (sample.current.position.z - camera.position.z) * k;
    camera.lookAt(0, 0, 0);

    stageRef.current.spread = sample.current.spread;
    stageRef.current.order = sample.current.order;
    stageRef.current.dim = sample.current.dim;
    stageRef.current.tempo = sample.current.tempo;
    stageRef.current.fission = sample.current.fission;
  });

  return null;
}
