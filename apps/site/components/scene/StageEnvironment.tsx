"use client";

import { Environment, Lightformer } from "@react-three/drei";

/**
 * The lighting rig — a hand-placed studio, baked once into an environment map.
 *
 * Two decisions worth naming:
 *
 * 1. NO HDRI PRESET. drei's `<Environment preset="...">` fetches an HDR file
 *    from a public CDN at runtime. This site is a static export with no
 *    third-party runtime dependencies, and every stock preset is a bright
 *    neutral studio that would wash a #05070a page into grey. Instead the
 *    environment is *authored*: a small set of `<Lightformer>` emissive
 *    planes rendered into a cube target. Fully offline, and art-directed to
 *    the brand rather than borrowed from a photograph of someone's kitchen.
 *
 * 2. `frames={1}`. Nothing in this rig moves, so the cube camera renders the
 *    environment exactly once at mount and never again. The reflections the
 *    nodes pick up cost one bake, not a per-frame render pass — which is what
 *    makes real environment reflections affordable here at all.
 *
 * The rig itself is deliberately a *dark* stage: two large cool key panels in
 * mesh teal at grazing angles to rake the node silhouettes, one warm tropic
 * orange accent opposite them so claimed nodes have something warm to catch,
 * and a dim overhead fill. The dominant tone stays near-black, so nodes read as
 * polished objects sitting in a dark room with a few lights in it — the
 * specific look that separates "premium product render" from "3D widget".
 */
export function StageEnvironment() {
  return (
    <Environment resolution={128} frames={1}>
      {/* Cool key, camera-left, raking. */}
      <Lightformer
        form="rect"
        intensity={2.4}
        color="#4fd1c5"
        position={[-6, 2.5, -4]}
        rotation={[0, Math.PI / 2.6, 0]}
        scale={[9, 9, 1]}
      />
      {/* Cool fill, camera-right, dimmer and tighter for asymmetry. */}
      <Lightformer
        form="rect"
        intensity={1.1}
        color="#8fb8ff"
        position={[6, -1.5, -3]}
        rotation={[0, -Math.PI / 2.6, 0]}
        scale={[6, 6, 1]}
      />
      {/* Warm accent — the only orange in the rig, so the claim color has a
          real reflected source rather than pure emission. Intensity nudged
          down from the amber it replaced: tropic orange is a more saturated,
          more forward hue, and at equal intensity it dominated the cool key
          instead of accenting it. */}
      <Lightformer
        form="circle"
        intensity={1.5}
        color="#FF6B35"
        position={[2.5, 4, 4]}
        scale={[3, 3, 1]}
      />
      {/* Overhead sheen — a long thin strip reads on a sphere as a crisp
          specular line, which is most of what sells "polished". */}
      <Lightformer
        form="rect"
        intensity={1.4}
        color="#e8ecf1"
        position={[0, 7, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        scale={[12, 1.6, 1]}
      />
      {/* Deep ambient shell keeping the unlit side ink-dark rather than black. */}
      <Lightformer
        form="rect"
        intensity={0.22}
        color="#0d121a"
        position={[0, 0, -10]}
        scale={[24, 24, 1]}
      />
    </Environment>
  );
}
