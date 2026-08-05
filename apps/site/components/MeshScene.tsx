"use client";

import { useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";

/**
 * The mesh, visualized: a small constellation of nodes (agents / worktrees)
 * connected by edges (the coordination graph). Every couple of seconds a
 * "claim" fires — one node wins the race, briefly glowing gold while its
 * neighbors dim — the same guarantee the daemon enforces for real: exactly
 * one agent holds a lease on a given resource at a time.
 */

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

  // Connect each node to its 3 nearest neighbors -> a believable mesh graph.
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

function MeshGraph({ reducedMotion, dense }: { reducedMotion: boolean; dense: boolean }) {
  const count = dense ? NODE_COUNT_DESKTOP : NODE_COUNT_MOBILE;
  const nodes = useMemo(() => buildMesh(count), [count]);
  const groupRef = useRef<THREE.Group>(null);
  const [claimedIndex, setClaimedIndex] = useState(reducedMotion ? 0 : -1);
  const claimClock = useRef(0);
  const order = useRef(
    [...Array(count).keys()].sort(() => Math.random() - 0.5)
  );

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

  useFrame((_, delta) => {
    if (groupRef.current && !reducedMotion) {
      groupRef.current.rotation.y += delta * 0.06;
      groupRef.current.rotation.x = Math.sin(Date.now() / 8000) * 0.08;
    }
    if (reducedMotion) return;
    claimClock.current += delta * 1000;
    if (claimClock.current >= CLAIM_INTERVAL_MS) {
      claimClock.current = 0;
      const next = order.current.shift();
      if (next !== undefined) {
        order.current.push(next);
        setClaimedIndex(next);
      }
    }
  });

  return (
    <group ref={groupRef}>
      {edges.map(([a, b], i) => {
        const isActive = claimedIndex === a || claimedIndex === b;
        return (
          <line key={`edge-${i}`}>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                count={2}
                array={
                  new Float32Array([
                    ...nodes[a].position,
                    ...nodes[b].position,
                  ])
                }
                itemSize={3}
              />
            </bufferGeometry>
            <lineBasicMaterial
              color={isActive ? "#f5b942" : "#2c5a56"}
              transparent
              opacity={isActive ? 0.85 : 0.35}
            />
          </line>
        );
      })}
      {nodes.map((n, i) => {
        const isClaimed = claimedIndex === i;
        return (
          <mesh key={`node-${i}`} position={n.position}>
            <sphereGeometry args={[isClaimed ? 0.11 : 0.07, 16, 16]} />
            <meshStandardMaterial
              color={isClaimed ? "#f5b942" : "#4fd1c5"}
              emissive={isClaimed ? "#f5b942" : "#0d3d38"}
              emissiveIntensity={isClaimed ? 1.4 : 0.4}
              toneMapped={false}
            />
          </mesh>
        );
      })}
    </group>
  );
}

export function MeshScene({ reducedMotion }: { reducedMotion: boolean }) {
  const [dense, setDense] = useState(true);

  return (
    <Canvas
      dpr={[1, 1.75]}
      frameloop={reducedMotion ? "demand" : "always"}
      camera={{ position: [0, 0, 8.5], fov: 45 }}
      onCreated={({ gl, size }) => {
        gl.setClearColor("#000000", 0);
        setDense(size.width > 640);
      }}
      aria-hidden="true"
    >
      <ambientLight intensity={0.6} />
      <pointLight position={[5, 5, 5]} intensity={40} color="#4fd1c5" />
      <MeshGraph reducedMotion={reducedMotion} dense={dense} />
    </Canvas>
  );
}
