"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { StageState } from "./CameraRig";

/**
 * FISSION AND TELEPATHY — the spine of the piece.
 *
 * The parent globe throws off daughter globes; they fly their own independent
 * orbits through the void, linked by filaments; and every so often one of them
 * *signals* and the rest react within a beat.
 *
 * WHY THIS IS THE PRODUCT, NOT AN EFFECT
 * --------------------------------------
 * Each element maps onto something the daemon actually does:
 *   - fission            one repo/mesh spawning agents, worktrees, replicas
 *   - independent orbits distributed workers with no shared memory
 *   - filaments          the coordination graph between them
 *   - the signal         the Redis pub/sub layer: a payload-free notification
 *                        that means "something changed, go re-read the log".
 *                        Processes genuinely learn of each other this way.
 *   - contention         two globes reach for the same thing; exactly one wins
 *                        and flares, the other yields and drops its filament.
 *                        That is the atomic claim, shown rather than described.
 *
 * THE MOTION QUALITY THIS IS TUNED FOR
 * ------------------------------------
 * The failure modes are specific and both easy to fall into:
 *   - Smooth shared drift reads as a lava lamp: decorative, says nothing.
 *   - A shared metronome reads as a screensaver: regular, so no event within
 *     it can register AS an event.
 *
 * What's built instead: every globe has its own orbital speed, phase, radius
 * and inclination — genuinely autonomous, never in lockstep. Signals fire at
 * IRREGULAR intervals (a randomised gap, not a fixed one), and when one does,
 * every linked recipient reacts one beat later. The intended read over ten
 * seconds is "those things are each doing their own thing… oh, they all just
 * reacted to something at once." Independence, punctuated by sudden consensus.
 *
 * Orange is strictly rationed: only the emitter of a live signal and its
 * immediate recipients carry it, and only for a fraction of a second. Teal is
 * the resting state of everything, which is what lets a flare read as news.
 *
 * COST
 * ----
 * One shared wireframe geometry reused across N globes (N is 3/6/9 by device
 * tier), one instanced core mesh, and ONE `LineSegments` for all filaments
 * whose endpoint buffer is rewritten each frame. Filament count is bounded by
 * construction: each globe keeps at most one link, so the buffer is N segments,
 * not N². Per frame this is N matrix writes plus a 2N-vertex buffer update.
 */

export type SwarmSize = 3 | 6 | 9;

type Orbit = {
  radius: number;
  speed: number;
  phase: number;
  tilt: number;
  yaw: number;
  scale: number;
};

/** Deterministic per-index parameters — identical every load, no hydration drift. */
function buildOrbits(count: number): Orbit[] {
  const orbits: Orbit[] = [];
  let seed = 987654321;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    orbits.push({
      // Deliberately wide spreads on every parameter. Close values would let
      // the globes fall into visual lockstep, which is exactly the
      // screensaver failure mode.
      radius: 4.6 + rand() * 4.4,
      speed: 0.055 + rand() * 0.16,
      phase: rand() * Math.PI * 2,
      tilt: (rand() - 0.5) * 1.5,
      yaw: rand() * Math.PI * 2,
      scale: 0.3 + rand() * 0.26,
    });
  }
  return orbits;
}

const TEAL = new THREE.Color("#4fd1c5");
const DIM = new THREE.Color("#2c5a56");
const ORANGE = new THREE.Color("#FF6B35");

export function DaughterGlobes({
  count,
  reducedMotion,
  stageRef,
}: {
  count: SwarmSize;
  reducedMotion: boolean;
  stageRef: React.MutableRefObject<StageState>;
}) {
  const orbits = useMemo(() => buildOrbits(count), [count]);

  const shellGeometry = useMemo(
    () => new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1, 1)),
    []
  );
  useEffect(() => () => shellGeometry.dispose(), [shellGeometry]);

  const groupRefs = useRef<(THREE.Group | null)[]>([]);
  const shellMats = useRef<(THREE.LineBasicMaterial | null)[]>([]);
  const coreMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);

  const filamentPositions = useMemo(() => new Float32Array(count * 6), [count]);
  const filamentAttr = useRef<THREE.BufferAttribute>(null);
  const filamentMat = useRef<THREE.LineBasicMaterial>(null);

  /** Live activation per globe, 0..1, decayed every frame. */
  const activation = useRef(new Float32Array(count));
  /** Which globe each one is currently linked to. */
  const linkedTo = useRef(
    Array.from({ length: count }, (_, i) => (i + 1) % count)
  );
  /** Pending signal deliveries: recipients flare one beat AFTER the emitter. */
  const pending = useRef<{ target: number; at: number }[]>([]);
  const clock = useRef(0);
  const nextSignal = useRef(1.5);
  const positions = useRef(
    Array.from({ length: count }, () => new THREE.Vector3())
  );

  useFrame((_, delta) => {
    const stage = stageRef.current;
    clock.current += reducedMotion ? 0 : delta;

    // Fission: daughters start absorbed in the parent globe and separate as
    // the journey progresses. Below a threshold they are hidden entirely, so
    // Act I is genuinely ONE whole globe.
    const fission = stage.fission;
    const visible = fission > 0.04;

    for (let i = 0; i < count; i++) {
      const g = groupRefs.current[i];
      if (!g) continue;
      g.visible = visible;
      if (!visible) continue;

      const o = orbits[i];
      // Each globe on its own clock — its own speed AND its own phase.
      const t = clock.current * o.speed + o.phase;
      const r = o.radius * fission;

      const x = Math.cos(t) * r;
      const z = Math.sin(t) * r;
      const y = Math.sin(t * 1.7 + o.yaw) * r * 0.32 + o.tilt;

      g.position.set(x, y, z);
      g.scale.setScalar(o.scale * (0.6 + fission * 0.4));
      g.rotation.y += delta * (0.2 + o.speed);
      positions.current[i].set(x, y, z);
    }

    if (!visible) {
      if (filamentMat.current) filamentMat.current.visible = false;
      return;
    }
    if (filamentMat.current) filamentMat.current.visible = true;

    // --- The telepathic signal -------------------------------------------
    if (!reducedMotion) {
      if (clock.current >= nextSignal.current) {
        // IRREGULAR gap, not a metronome. Long quiet stretches are the point:
        // they're what make the burst land.
        nextSignal.current = clock.current + 1.6 + Math.random() * 3.4;

        const emitter = Math.floor(Math.random() * count);
        activation.current[emitter] = 1;

        // Contention: sometimes a second globe was reaching for the same
        // thing. It loses, and visibly yields by dropping its filament and
        // re-linking elsewhere — the atomic claim, staged.
        if (Math.random() < 0.45) {
          const loser = (emitter + 1 + Math.floor(Math.random() * (count - 1))) % count;
          linkedTo.current[loser] = emitter;
          activation.current[loser] = 0.18;
        }

        // Recipients react ONE BEAT later — correlated, but not simultaneous.
        // Simultaneity would read as a single object flashing; a short,
        // staggered delay reads as a message propagating.
        for (let i = 0; i < count; i++) {
          if (i === emitter) continue;
          if (linkedTo.current[i] === emitter || linkedTo.current[emitter] === i) {
            pending.current.push({
              target: i,
              at: clock.current + 0.12 + Math.random() * 0.14,
            });
          }
        }
      }

      for (let p = pending.current.length - 1; p >= 0; p--) {
        if (clock.current >= pending.current[p].at) {
          activation.current[pending.current[p].target] = 0.8;
          pending.current.splice(p, 1);
        }
      }
    }

    // Discrete vocabulary: activation SNAPS to 1 and decays fast. Nothing
    // eases in — an event either happened or it didn't.
    const decay = reducedMotion ? 1 : Math.pow(0.045, delta);
    for (let i = 0; i < count; i++) {
      if (!reducedMotion) activation.current[i] *= decay;
      const a = activation.current[i];

      const shell = shellMats.current[i];
      if (shell) {
        shell.color.copy(DIM).lerp(ORANGE, a);
        shell.opacity = (0.3 + a * 0.6) * stage.dim;
      }
      const core = coreMats.current[i];
      if (core) {
        core.color.copy(TEAL).lerp(ORANGE, a);
        core.opacity = (0.5 + a * 0.5) * stage.dim;
      }
    }

    // --- Filaments --------------------------------------------------------
    let peak = 0;
    for (let i = 0; i < count; i++) {
      const from = positions.current[i];
      const to = positions.current[linkedTo.current[i]];
      filamentPositions[i * 6] = from.x;
      filamentPositions[i * 6 + 1] = from.y;
      filamentPositions[i * 6 + 2] = from.z;
      filamentPositions[i * 6 + 3] = to.x;
      filamentPositions[i * 6 + 4] = to.y;
      filamentPositions[i * 6 + 5] = to.z;
      peak = Math.max(peak, activation.current[i]);
    }
    if (filamentAttr.current) filamentAttr.current.needsUpdate = true;
    if (filamentMat.current) {
      filamentMat.current.color.copy(DIM).lerp(ORANGE, peak * 0.85);
      filamentMat.current.opacity = (0.16 + peak * 0.5) * stage.dim;
    }
  });

  return (
    <group>
      {orbits.map((_, i) => (
        <group
          key={i}
          ref={(g) => {
            groupRefs.current[i] = g;
          }}
        >
          <lineSegments geometry={shellGeometry}>
            <lineBasicMaterial
              ref={(m) => {
                shellMats.current[i] = m;
              }}
              transparent
              opacity={0.3}
              depthWrite={false}
            />
          </lineSegments>
          <mesh scale={0.34}>
            <sphereGeometry args={[1, 12, 12]} />
            <meshBasicMaterial
              ref={(m) => {
                coreMats.current[i] = m;
              }}
              transparent
              opacity={0.5}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        </group>
      ))}

      <lineSegments frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute
            ref={filamentAttr}
            attach="attributes-position"
            count={count * 2}
            array={filamentPositions}
            itemSize={3}
          />
        </bufferGeometry>
        <lineBasicMaterial
          ref={filamentMat}
          transparent
          opacity={0.16}
          depthWrite={false}
        />
      </lineSegments>
    </group>
  );
}
