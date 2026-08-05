"use client";

import { useEffect, useState } from "react";

export type DeviceTier = "low" | "mid" | "high";

/**
 * A deliberately simple heuristic — viewport width plus reported core count
 * — rather than full GPU/UA sniffing. Good enough to keep particle counts
 * and post-processing cost sane on phones and low-end laptops without
 * over-engineering device detection.
 */
export function getDeviceTier(width: number): DeviceTier {
  const cores =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;

  if (width < 640 || cores <= 2) return "low";
  if (width < 1024 || cores <= 4) return "mid";
  return "high";
}

export type TierSettings = {
  particles: number;
  dpr: [number, number];
  postFx: boolean;
  /**
   * How many daughter globes fission off the parent. Each one costs two draw
   * calls (wireframe shell + core) plus a filament segment, and the swarm's
   * per-frame work scales linearly with it — so this is the honest place to
   * spend or save. Three still reads as "a distributed mesh"; nine reads as a
   * populated one.
   */
  swarm: 3 | 6 | 9;
  /**
   * Render a baked Lightformer environment map and shade the nodes with
   * MeshPhysicalMaterial instead of the flat emissive shader. This is what
   * makes the nodes read as real objects catching light — and it is the
   * single most expensive addition in this scene, so the low tier keeps the
   * original cheap shader path.
   */
  physicalNodes: boolean;
  /** Additive fresnel halo shell around each node (a second instanced draw). */
  halo: boolean;
  /** Restrained lens dispersion in post. High tier only. */
  chromaticAberration: boolean;
  /**
   * Whether the WebGL stage stays live behind the whole page (the cinematic
   * full-page scroll choreography) or remains scoped to the hero and stops
   * rendering once scrolled past.
   */
  fullPageStage: boolean;
};

export const TIER_SETTINGS: Record<DeviceTier, TierSettings> = {
  // postFx (bloom + mipmapBlur + noise + vignette) is the single most
  // expensive part of this scene on mobile GPUs — far more than the
  // particle-count difference. Measured: leaving it on for every tier meant
  // "low" (width < 640 or <=2 cores, i.e. most phones) only cosmetically
  // reduced load. Disabled here so the low tier actually sheds GPU cost
  // instead of just drawing fewer points while still running the full
  // multi-pass EffectComposer chain every frame.
  //
  // The same reasoning now governs the newer additions. `physicalNodes`
  // pulls in a cube-camera environment bake plus a full PBR shader on every
  // node; `fullPageStage` keeps the renderer running for the entire scroll
  // rather than one viewport. Both are real, sustained cost, so the low tier
  // opts out of both: on a phone the scene is a hero flourish that stops
  // rendering the moment it leaves the screen, not a persistent backdrop.
  low: {
    particles: 140,
    dpr: [1, 1.25],
    postFx: false,
    swarm: 3,
    physicalNodes: false,
    halo: false,
    chromaticAberration: false,
    fullPageStage: false,
  },
  mid: {
    particles: 380,
    dpr: [1, 1.5],
    postFx: true,
    swarm: 6,
    physicalNodes: true,
    halo: true,
    chromaticAberration: false,
    fullPageStage: true,
  },
  high: {
    particles: 700,
    dpr: [1, 1.9],
    postFx: true,
    swarm: 9,
    physicalNodes: true,
    halo: true,
    chromaticAberration: true,
    fullPageStage: true,
  },
};

/**
 * Resolve the tier once on mount, before the Canvas is laid out.
 *
 * The tier now decides page *layout* (whether the stage is fixed behind the
 * whole document or scoped to the hero), not just in-scene quality knobs, so
 * it can no longer be discovered inside `<Canvas onCreated>` — it has to be
 * known before the canvas renders. Returns `null` until measured so callers
 * can hold off on committing to a layout.
 */
export function useDeviceTier(): DeviceTier | null {
  const [tier, setTier] = useState<DeviceTier | null>(null);

  useEffect(() => {
    const resolve = () => setTier(getDeviceTier(window.innerWidth));
    resolve();
    // Re-resolve on resize so a desktop window dragged narrow sheds the
    // expensive path rather than keeping it for the life of the session.
    window.addEventListener("resize", resolve);
    return () => window.removeEventListener("resize", resolve);
  }, []);

  return tier;
}
