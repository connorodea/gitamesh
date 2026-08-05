"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { StageState } from "./CameraRig";

/**
 * ACT II — the mechanism, exploded.
 *
 * This is the one place a Blender-authored asset clearly beats procedural
 * geometry, and it is why this component uses a GLB while the globe next to
 * it does not.
 *
 * The reasoning is about ADDRESSABILITY, not polish. The globe's whole job is
 * per-node runtime control — individual agent nodes have to ignite, pulse to
 * neighbours, and re-colour on their own schedule, which means the code needs
 * to own every node's position and material. A static mesh actively fights
 * that. The mechanism's job is the opposite: four named parts, authored as
 * recognisable objects, that separate outward and get labelled. Nothing about
 * them needs per-vertex runtime control, and hand-modelled parts read as real
 * components in a way that four procedural primitives never would.
 *
 * ASSET FACTS THIS RELIES ON (verified by the coordinator against the real
 * files, not taken from the asset report):
 *   - `exploded-mechanism.glb` is FLAT: `getObjectByName('part_claim')` returns
 *     a Mesh directly, for all four parts. (The globe shells are NOT like
 *     this — they are Groups wrapping a Mesh + a LineSegments, which is why
 *     they would need a two-material traversal. Not this file's problem.)
 *   - Each part's origin is its own centroid and it already sits at its
 *     assembled-state world position, so exploding is a pure outward offset
 *     from the origin. No centroid maths, no re-pivoting.
 *   - +Y up, no correction transform.
 *   - Triangle meshes carry COLOR_0 vertex colours holding the orange /
 *     teal / dim-teal semantics, so the material must opt into `vertexColors`
 *     or the palette silently vanishes.
 */

const PART_NAMES = ["part_claim", "part_fencing", "part_lease", "part_eventlog"] as const;

export const MECHANISM_URL = "/models/exploded-mechanism.glb";

export function ExplodedMechanism({
  reducedMotion,
  stageRef,
  anchorsRef,
}: {
  reducedMotion: boolean;
  stageRef: React.MutableRefObject<StageState>;
  /** Part world positions, published for the annotation callouts to track. */
  anchorsRef: React.MutableRefObject<THREE.Vector3[]>;
}) {
  const { scene } = useGLTF(MECHANISM_URL);

  // Clone so this component never mutates useGLTF's shared cache entry — a
  // second mount (or a Fast Refresh) would otherwise inherit exploded
  // transforms and swapped materials.
  const root = useMemo(() => scene.clone(true), [scene]);

  const parts = useMemo(() => {
    const found: THREE.Mesh[] = [];
    for (const name of PART_NAMES) {
      const obj = root.getObjectByName(name);
      if (obj instanceof THREE.Mesh) found.push(obj);
    }
    return found;
  }, [root]);

  /** Assembled-state positions, captured before anything is offset. */
  const restPositions = useMemo(
    () => parts.map((p) => p.position.clone()),
    [parts]
  );

  /** Outward explode direction per part, from its own rest position. */
  const directions = useMemo(
    () =>
      restPositions.map((p) => {
        const d = p.clone();
        // A part sitting exactly at the origin has no outward direction of
        // its own; give it one so it doesn't stay buried inside the others.
        if (d.lengthSq() < 1e-6) d.set(0, 1, 0);
        return d.normalize();
      }),
    [restPositions]
  );

  useEffect(() => {
    for (const part of parts) {
      part.material = new THREE.MeshStandardMaterial({
        // Without this the authored orange/teal/dim-teal COLOR_0 data is
        // simply ignored and every part renders flat white.
        vertexColors: true,
        roughness: 0.28,
        metalness: 0.45,
        envMapIntensity: 1.4,
        transparent: true,
        opacity: 1,
      });
    }
  }, [parts]);

  const explode = useRef(0);
  const groupRef = useRef<THREE.Group>(null);

  useFrame((_, delta) => {
    const stage = stageRef.current;

    // The mechanism belongs to the "order restored" act, on the same narrow
    // window the callouts use — they are one device and must arrive together.
    const target = Math.max(0, (stage.order - 0.94) / 0.06);
    const k = reducedMotion ? 1 : 1 - Math.pow(0.01, delta);
    explode.current += (target - explode.current) * k;

    const presence = explode.current * stage.dim;
    const visible = presence > 0.01;
    if (groupRef.current) groupRef.current.visible = visible;
    if (!visible) return;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const rest = restPositions[i];
      const dir = directions[i];
      // Pure outward offset from the authored assembled position.
      const distance = explode.current * 1.35;
      part.position.set(
        rest.x + dir.x * distance,
        rest.y + dir.y * distance,
        rest.z + dir.z * distance
      );
      part.getWorldPosition(anchorsRef.current[i]);

      const mat = part.material as THREE.MeshStandardMaterial;
      mat.opacity = presence;
    }

    if (groupRef.current && !reducedMotion) {
      groupRef.current.rotation.y += delta * 0.08;
    }
  });

  return (
    <group ref={groupRef} scale={1.5} visible={false}>
      <primitive object={root} />
    </group>
  );
}

useGLTF.preload(MECHANISM_URL);
