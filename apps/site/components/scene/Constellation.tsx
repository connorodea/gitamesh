"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Instance, Instances } from "@react-three/drei";
import * as THREE from "three";
import "./materials";

const NODE_COUNT_DESKTOP = 22;
const NODE_COUNT_MOBILE = 13;
const CLAIM_INTERVAL_MS = 2200;

type Node = {
  position: [number, number, number];
  neighbors: number[];
};

function buildMesh(count: number): Node[] {
  // Fibonacci-sphere distribution for an even, organic node cluster.
  const points: [number, number, number][] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const radius = Math.sqrt(1 - y * y);
    const theta = golden * i;
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;
    points.push([x * 3.2, y * 3.2, z * 3.2]);
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
};
type NodeMaterialImpl = THREE.ShaderMaterial & { uTime: number; uActive: number };

/**
 * The mesh, visualized: a constellation of nodes (agents / worktrees)
 * connected by edges (the coordination graph). Every couple of seconds a
 * "claim" fires — one node wins the race. Instead of a flat color swap, an
 * energy pulse visibly travels outward along every edge touching the winner
 * (see EdgeGlowMaterial) while the rest of the mesh keeps its low ambient
 * shimmer — the same guarantee the daemon enforces for real: exactly one
 * agent holds a lease on a given resource at a time, and the whole graph
 * feels that claim ripple through the wire.
 */
export function Constellation({
  reducedMotion,
  dense,
  scrollProgressRef,
}: {
  reducedMotion: boolean;
  dense: boolean;
  scrollProgressRef: React.MutableRefObject<number>;
}) {
  const count = dense ? NODE_COUNT_DESKTOP : NODE_COUNT_MOBILE;
  const nodes = useMemo(() => buildMesh(count), [count]);
  const groupRef = useRef<THREE.Group>(null);
  const [claimedIndex, setClaimedIndex] = useState(reducedMotion ? 0 : -1);
  const claimClock = useRef(0);
  const globalClock = useRef(0);
  const order = useRef([...Array(count).keys()].sort(() => Math.random() - 0.5));

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

  useFrame((_, delta) => {
    globalClock.current += delta;
    if (groupRef.current && !reducedMotion) {
      groupRef.current.rotation.y += delta * 0.06;
      groupRef.current.rotation.x =
        Math.sin(Date.now() / 8000) * 0.08 + scrollProgressRef.current * 0.22;
    }

    if (sharedNodeMatRef.current) sharedNodeMatRef.current.uTime = globalClock.current;
    if (overlayNodeMatRef.current) overlayNodeMatRef.current.uTime = globalClock.current;
    edgeMaterialRefs.current.forEach((mat) => {
      if (mat) mat.uTime = globalClock.current;
    });

    if (reducedMotion) return;
    claimClock.current += delta * 1000;
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

      <Instances limit={count} range={count}>
        <sphereGeometry args={[0.075, 20, 20]} />
        <nodeGlowMaterial ref={sharedNodeMatRef} />
        {nodes.map((n, i) => (
          <Instance key={`node-${i}`} position={n.position} />
        ))}
      </Instances>

      {claimedIndex >= 0 && claimedIndex < nodes.length && (
        <mesh position={nodes[claimedIndex].position} scale={1.5}>
          <sphereGeometry args={[0.075, 24, 24]} />
          <nodeGlowMaterial ref={overlayNodeMatRef} uActive={1} />
        </mesh>
      )}
    </group>
  );
}
