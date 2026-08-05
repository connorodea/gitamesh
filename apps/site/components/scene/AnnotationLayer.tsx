"use client";

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { StageState } from "./CameraRig";
import { CALLOUTS } from "./annotationCallouts";

/**
 * Technical annotation callouts — numbers on thin leader lines pointing at
 * individual nodes of the constellation.
 *
 * This is igloo.inc's signature device: an engineering schematic drawn over a
 * photoreal render. It earns its place here because the "How it works"
 * section is already trying to say *these four primitives are labeled parts
 * of one mechanism* — which is exactly what an exploded-view callout says,
 * and what four flat cards in a row do not.
 *
 * IMPLEMENTATION
 * --------------
 * The labels are real DOM, not WebGL text. Two reasons: drei's `<Text>` pulls
 * a font from a CDN at runtime (this site is a dependency-free static export),
 * and text baked into a canvas leaves the accessibility tree entirely. So this
 * component lives *inside* the r3f tree purely to get camera access, projects
 * a handful of world-space anchors to screen space each frame, and writes the
 * results to a sibling DOM overlay as CSS custom properties.
 *
 * Per frame that is: four `Vector3.project()` calls and four style writes.
 * No React state, no layout reads, no reconciliation.
 *
 * The layer is only present on tiers that run the full-page stage, and is
 * never mounted at all under reduced motion — a callout whose leader line is
 * pinned to a node that never moves, in a scene whose camera never travels,
 * is just clutter over the copy.
 */

export function AnnotationLayer({
  anchors,
  stageRef,
  overlayRef,
}: {
  /**
   * Live world positions of the four mechanism parts, published each frame by
   * ExplodedMechanism.
   *
   * These used to be static constellation-node positions, which meant the
   * callouts labelled arbitrary points on a rotating globe — the labels said
   * CLAIM / FENCE / LEASE / LOG but pointed at nothing in particular. Now they
   * track the actual named parts of the authored mechanism, so the leader
   * lines land on the components they name. That is the whole point of the
   * device, and it only became possible with an asset that has addressable
   * parts.
   */
  anchors: React.MutableRefObject<THREE.Vector3[]>;
  stageRef: React.MutableRefObject<StageState>;
  overlayRef: React.RefObject<HTMLDivElement>;
}) {
  const { camera, size } = useThree();
  const scratch = useRef(new THREE.Vector3());

  useFrame(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const stage = stageRef.current;
    // Callouts belong to the "order restored" act ONLY — they arrive with the
    // primitives and leave with them. The window is deliberately narrow and
    // sits near the very top of the `order` range: the hero act is already at
    // 0.9, so anything looser than this leaks schematic annotations over the
    // opening title card, which is precisely where the page most needs
    // negative space.
    const presence = Math.max(0, (stage.order - 0.94) / 0.06) * stage.dim;
    overlay.style.opacity = presence.toFixed(3);
    overlay.style.visibility = presence > 0.01 ? "visible" : "hidden";
    if (presence <= 0.01) return;

    const children = overlay.children;
    for (let i = 0; i < CALLOUTS.length; i++) {
      const el = children[i] as HTMLElement | undefined;
      const anchor = anchors.current[i];
      if (!el || !anchor) continue;

      // Already a world position — the part publishes it via getWorldPosition,
      // so no local-to-world scaling is applied here.
      scratch.current.copy(anchor).project(camera);

      const x = (scratch.current.x * 0.5 + 0.5) * size.width;
      const y = (-scratch.current.y * 0.5 + 0.5) * size.height;
      // z > 1 means the anchor is behind the camera.
      const behind = scratch.current.z > 1;

      el.style.setProperty("--ax", `${x.toFixed(1)}px`);
      el.style.setProperty("--ay", `${y.toFixed(1)}px`);
      el.style.opacity = behind ? "0" : "1";
    }
  });

  return null;
}
