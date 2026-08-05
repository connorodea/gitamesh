"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Instance, Instances } from "@react-three/drei";
import * as THREE from "three";
import "./materials";
import type { StageState } from "./CameraRig";

const NODE_COUNT_DESKTOP = 22;
const NODE_COUNT_MOBILE = 13;
const CLAIM_INTERVAL_MS = 2200;

type Node = {
  position: [number, number, number];
  neighbors: number[];
};

export const NODE_COUNTS = {
  desktop: NODE_COUNT_DESKTOP,
  mobile: NODE_COUNT_MOBILE,
};

/**
 * Exported so the annotation layer can anchor its callouts to the very same
 * node positions the constellation renders — the two must not drift apart, and
 * the function is pure and cheap enough to simply call twice.
 */
export function buildMesh(count: number): Node[] {
  // Fibonacci-sphere distribution for an even, organic node cluster.
  const points: [number, number, number][] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const radius = Math.sqrt(1 - y * y);
    const theta = golden * i;
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;
    points.push([x * GLOBE_RADIUS, y * GLOBE_RADIUS, z * GLOBE_RADIUS]);
  }

  return points.map((p, i) => {
    const distances = points
      .map((q, j) => ({
        j,
        d:
          i === j
            ? Infinity
            : (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2,
      }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map((e) => e.j);
    return { position: p, neighbors: distances };
  });
}

type EdgeMaterialImpl = THREE.ShaderMaterial & {
  uTime: number;
  uActive: number;
  uPulseStart: number;
  uDir: number;
  uOrder: number;
  uDim: number;
};
type NodeMaterialImpl = THREE.ShaderMaterial & { uTime: number; uActive: number };
type HaloMaterialImpl = THREE.ShaderMaterial & {
  uTime: number;
  uActive: number;
  uIntensity: number;
};

/**
 * Enlarged from 0.075. The whole point of the PBR/environment work is that a
 * node reads as a real object catching light — at the old radius the specular
 * highlights and clearcoat sheen were sub-pixel and the nodes were, visually,
 * still just dots. They need to be big enough to have a surface.
 */
const NODE_RADIUS = 0.12;
/** How far the additive halo shell extends past the solid node surface. */
const HALO_SCALE = 2.2;

/**
 * The node surface on the mid/high tiers.
 *
 * A dark, near-metal dielectric with a clearcoat: low roughness so the
 * Lightformer rig reads as crisp specular highlights, a small amount of
 * emission so the object never fully disappears in the unlit hemisphere, and
 * clearcoat on top for the lacquered "expensive product photograph" read.
 * The base color is intentionally *dark* teal, not bright — a bright base
 * flattens under bloom, whereas a dark base with sharp reflections keeps its
 * form.
 */
function PhysicalNodeMaterial({ active = false }: { active?: boolean }) {
  return (
    <meshPhysicalMaterial
      color={active ? "#FF6B35" : "#132a2c"}
      emissive={active ? "#FF6B35" : "#2c5a56"}
      emissiveIntensity={active ? 1.5 : 0.35}
      roughness={0.16}
      metalness={0.55}
      clearcoat={1}
      clearcoatRoughness={0.08}
      envMapIntensity={1.6}
    />
  );
}

/** Radius the nodes are distributed on — the globe's surface. */
const GLOBE_RADIUS = 3.2;

/**
 * The globe itself: a geodesic wireframe shell that the agent nodes sit on.
 *
 * Without it the nodes read as a loose cloud of points that happens to be
 * roughly spherical. With it they read as participants distributed across the
 * surface of one coordinated world — which is the actual claim the product
 * makes, and the reason the globe is the right central object rather than a
 * decorative one.
 *
 * An icosahedron subdivision rather than a lat/long sphere: lat/long wireframe
 * bunches hard at the poles and immediately reads as "a 3D primitive", whereas
 * a geodesic tessellation is near-uniform everywhere and reads as an
 * engineered lattice. One `LineSegments` draw call; geometry built once.
 */
function GlobeShell() {
  const geometry = useMemo(
    () => new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(GLOBE_RADIUS, 2)),
    []
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial
        color="#2c5a56"
        transparent
        opacity={0.32}
        depthWrite={false}
      />
    </lineSegments>
  );
}

/**
 * The mesh, visualized: a constellation of nodes (agents / worktrees)
 * connected by edges (the coordination graph). Every couple of seconds a
 * "claim" fires — one node wins the race. Instead of a flat color swap, an
 * energy pulse visibly travels outward along every edge touching the winner
 * (see EdgeGlowMaterial) while the rest of the mesh keeps its low ambient
 * shimmer — the same guarantee the daemon enforces for real: exactly one
 * agent holds a lease on a given resource at a time, and the whole graph
 * feels that claim ripple through the wire.
 *
 * The whole group is additionally scrubbed by the scroll track (`stageRef`):
 * it scatters and loses its wiring through the "problem" section, then
 * contracts into a tight, fast-claiming lattice through the "primitives"
 * section. See CameraRig.tsx for the authored timeline.
 */
export function Constellation({
  reducedMotion,
  dense,
  physical,
  halo,
  stageRef,
}: {
  reducedMotion: boolean;
  dense: boolean;
  physical: boolean;
  halo: boolean;
  stageRef: React.MutableRefObject<StageState>;
}) {
  const count = dense ? NODE_COUNT_DESKTOP : NODE_COUNT_MOBILE;
  const nodes = useMemo(() => buildMesh(count), [count]);
  const groupRef = useRef<THREE.Group>(null);
  const [claimedIndex, setClaimedIndex] = useState(reducedMotion ? 0 : -1);
  const claimClock = useRef(0);
  const globalClock = useRef(0);
  const order = useRef([...Array(count).keys()].sort(() => Math.random() - 0.5));
  const spread = useRef(1);

  // `count` can change once, right after mount, when the desktop/mobile
  // `dense` tier is determined from the actual canvas width. Re-derive the
  // claim order and clear any stale claimed index so it never points past
  // the end of a freshly-resized `nodes` array.
  useEffect(() => {
    order.current = [...Array(count).keys()].sort(() => Math.random() - 0.5);
    setClaimedIndex(reducedMotion ? 0 : -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  const edges = useMemo(() => {
    const seen = new Set<string>();
    const pairs: [number, number][] = [];
    nodes.forEach((n, i) => {
      n.neighbors.forEach((j) => {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push([i, j]);
        }
      });
    });
    return pairs;
  }, [nodes]);

  // Precompute each edge's line-geometry buffers once, outside JSX — hooks
  // (useMemo) may not be called inside a loop/callback.
  const edgeBuffers = useMemo(
    () =>
      edges.map(([a, b]) => ({
        positions: new Float32Array([...nodes[a].position, ...nodes[b].position]),
        progress: new Float32Array([0, 1]),
      })),
    [edges, nodes]
  );

  const edgeMaterialRefs = useRef<(EdgeMaterialImpl | null)[]>([]);
  const sharedNodeMatRef = useRef<NodeMaterialImpl | null>(null);
  const overlayNodeMatRef = useRef<NodeMaterialImpl | null>(null);
  const haloMatRef = useRef<HaloMaterialImpl | null>(null);
  const overlayHaloMatRef = useRef<HaloMaterialImpl | null>(null);

  useFrame((_, delta) => {
    globalClock.current += delta;
    const stage = stageRef.current;

    if (groupRef.current && !reducedMotion) {
      groupRef.current.rotation.y += delta * 0.06;
      groupRef.current.rotation.x = Math.sin(globalClock.current / 8) * 0.08;

      // Damped scatter/contract. The graph never snaps between acts even if
      // the reader jumps the scroll position.
      const k = 1 - Math.pow(0.004, delta);
      spread.current += (stage.spread - spread.current) * k;
      groupRef.current.scale.setScalar(spread.current);
    }

    if (sharedNodeMatRef.current) sharedNodeMatRef.current.uTime = globalClock.current;
    if (overlayNodeMatRef.current) overlayNodeMatRef.current.uTime = globalClock.current;
    if (haloMatRef.current) {
      haloMatRef.current.uTime = globalClock.current;
      haloMatRef.current.uIntensity = stage.dim;
    }
    if (overlayHaloMatRef.current) {
      overlayHaloMatRef.current.uTime = globalClock.current;
      overlayHaloMatRef.current.uIntensity = stage.dim;
    }
    edgeMaterialRefs.current.forEach((mat) => {
      if (mat) {
        mat.uTime = globalClock.current;
        mat.uOrder = stage.order;
        mat.uDim = stage.dim;
      }
    });

    if (reducedMotion) return;
    // Claim cadence accelerates as the scene reaches the "order restored"
    // act, so coordination reads as busier traffic, not just tighter geometry.
    claimClock.current += delta * 1000 * stage.tempo;
    if (claimClock.current >= CLAIM_INTERVAL_MS) {
      claimClock.current = 0;
      const next = order.current.shift();
      if (next !== undefined) {
        order.current.push(next);
        setClaimedIndex(next);
        // Fire the travelling pulse on every edge touching the new winner.
        edges.forEach(([a, b], i) => {
          const mat = edgeMaterialRefs.current[i];
          if (!mat) return;
          if (a === next || b === next) {
            mat.uPulseStart = globalClock.current;
            mat.uDir = a === next ? 1 : -1;
            mat.uActive = 1;
          } else {
            mat.uActive = 0;
          }
        });
      }
    }
  });

  return (
    <group ref={groupRef}>
      <GlobeShell />

      {edges.map(([a, b], i) => (
        <line key={`edge-${a}-${b}`}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              count={2}
              array={edgeBuffers[i].positions}
              itemSize={3}
            />
            <bufferAttribute
              attach="attributes-aProgress"
              count={2}
              array={edgeBuffers[i].progress}
              itemSize={1}
            />
          </bufferGeometry>
          <edgeGlowMaterial
            ref={(m: EdgeMaterialImpl | null) => {
              edgeMaterialRefs.current[i] = m;
            }}
            transparent
            depthWrite={false}
          />
        </line>
      ))}

      {/* Solid node surfaces. One instanced draw call regardless of tier —
          only the material differs. */}
      <Instances limit={count} range={count}>
        <sphereGeometry args={[NODE_RADIUS, 20, 20]} />
        {physical ? (
          <PhysicalNodeMaterial />
        ) : (
          <nodeGlowMaterial ref={sharedNodeMatRef} />
        )}
        {nodes.map((n, i) => (
          <Instance key={`node-${i}`} position={n.position} />
        ))}
      </Instances>

      {/* Atmospheric halo shells — a second instanced draw, back-faced and
          additive, so the physically-shaded cores still glow. Skipped on the
          low tier along with the PBR path. */}
      {halo && (
        <Instances limit={count} range={count}>
          <sphereGeometry args={[NODE_RADIUS * HALO_SCALE, 16, 16]} />
          <nodeHaloMaterial
            ref={haloMatRef}
            transparent
            depthWrite={false}
            side={THREE.BackSide}
            blending={THREE.AdditiveBlending}
          />
          {nodes.map((n, i) => (
            <Instance key={`halo-${i}`} position={n.position} />
          ))}
        </Instances>
      )}

      {claimedIndex >= 0 && claimedIndex < nodes.length && (
        <group position={nodes[claimedIndex].position}>
          <mesh scale={1.5}>
            <sphereGeometry args={[NODE_RADIUS, 24, 24]} />
            {physical ? (
              <PhysicalNodeMaterial active />
            ) : (
              <nodeGlowMaterial ref={overlayNodeMatRef} uActive={1} />
            )}
          </mesh>
          {halo && (
            <mesh scale={1.5}>
              <sphereGeometry args={[NODE_RADIUS * HALO_SCALE, 20, 20]} />
              <nodeHaloMaterial
                ref={overlayHaloMatRef}
                uActive={1}
                transparent
                depthWrite={false}
                side={THREE.BackSide}
                blending={THREE.AdditiveBlending}
              />
            </mesh>
          )}
        </group>
      )}
    </group>
  );
}
