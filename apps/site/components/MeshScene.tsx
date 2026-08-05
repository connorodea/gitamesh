"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import {
  EffectComposer,
  Bloom,
  Vignette,
  Noise,
  ChromaticAberration,
} from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import * as THREE from "three";
import { Constellation } from "./scene/Constellation";
import { ExplodedMechanism } from "./scene/ExplodedMechanism";
import { AmbientField } from "./scene/AmbientField";
import { TimeCorridor } from "./scene/TimeCorridor";
import { DaughterGlobes } from "./scene/DaughterGlobes";
import { AnnotationLayer } from "./scene/AnnotationLayer";
import { StageEnvironment } from "./scene/StageEnvironment";
import { CameraRig, STATIC_STAGE, type StageState } from "./scene/CameraRig";
import {
  TIER_SETTINGS,
  type DeviceTier,
  type TierSettings,
} from "./scene/deviceTier";
import { scrollState } from "@/lib/scrollStore";

/**
 * On the low tier the stage is hero-scoped, so once the reader has scrolled a
 * viewport and a half past it there is nothing to render — but an r3f Canvas
 * with `frameloop="always"` keeps rendering anyway, forever, off-screen. This
 * watches the scroll store and flips the loop off, which is the difference
 * between a phone spending its GPU budget on an invisible scene for the
 * entire rest of the page and spending none.
 */
function useOffscreenParked(active: boolean): boolean {
  const [parked, setParked] = useState(false);

  useEffect(() => {
    if (!active) {
      setParked(false);
      return;
    }
    let frame = 0;
    const check = () => {
      const shouldPark = scrollState.hero > 1.4;
      setParked((prev) => (prev === shouldPark ? prev : shouldPark));
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return parked;
}

/**
 * Stops the render loop while the tab is in the background.
 *
 * For a canvas that only occupied the hero this barely mattered — it scrolled
 * away and the loop could park. A persistent full-page stage is, by
 * definition, always "in viewport", so the only remaining free win is the
 * Page Visibility API. Browsers throttle rAF in background tabs but do not
 * reliably stop it, and a backgrounded tab quietly rendering a full
 * post-processed scene is exactly the kind of thing that drains a laptop
 * battery for no benefit whatsoever.
 */
function useTabHidden(): boolean {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const sync = () => setHidden(document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  return hidden;
}

/**
 * Renders a short burst of frames after mount, then stops.
 *
 * A reduced-motion visitor gets `frameloop="demand"`, which renders once on
 * mount and then only when something calls `invalidate()`. That single frame
 * is not enough: drei's `<Environment>` bakes its cube map from inside the
 * render loop, and the EffectComposer needs a pass of its own, so a
 * one-frame scene composes with no environment map at all — the PBR nodes
 * come out unlit and black. Pumping ~1.2s of frames lets the bake and the
 * post chain settle into a correct still image, after which the loop parks
 * for good.
 *
 * The result for a reduced-motion visitor is the intended one: a fully
 * lit, fully composed, completely static frame — not a degraded scene, and
 * not a running animation.
 */
function StaticFramePump() {
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    const started = performance.now();
    let frame = 0;
    const pump = () => {
      invalidate();
      if (performance.now() - started < 1200) {
        frame = requestAnimationFrame(pump);
      }
    };
    frame = requestAnimationFrame(pump);
    return () => cancelAnimationFrame(frame);
  }, [invalidate]);

  return null;
}

/**
 * The post chain, assembled as an array.
 *
 * `<EffectComposer>` types its children as strictly `JSX.Element`, so an
 * inline `{cond && <Effect/>}` (which can evaluate to `false`) or even a JSX
 * comment (which evaluates to `undefined`) is a type error. Building the list
 * here keeps the chain conditional AND documented.
 */
function buildEffects(settings: TierSettings) {
  const effects = [
    // Retuned for the PBR node surfaces. The old threshold of 0.18 bloomed
    // nearly the whole frame — fine when every node was a flat emissive ball,
    // far too eager now that nodes are dark dielectrics with bright specular
    // hits. Raising the threshold and widening the smoothing means only
    // genuine highlights (the halo shells, the claim core, specular pinpoints)
    // bloom, and they fall off filmically instead of turning into a haze.
    <Bloom
      key="bloom"
      intensity={1.15}
      luminanceThreshold={0.62}
      luminanceSmoothing={0.5}
      mipmapBlur
      radius={0.72}
    />,
  ];

  if (settings.chromaticAberration) {
    // Deliberately near the edge of perception: sub-pixel lateral dispersion,
    // radially modulated so the frame centre stays clean and only the corners
    // pick it up. Enough to imply a real lens, not enough to notice as an
    // effect. High tier only.
    effects.push(
      <ChromaticAberration
        key="chroma"
        offset={new THREE.Vector2(0.0004, 0.0006)}
        radialModulation
        modulationOffset={0.35}
        blendFunction={BlendFunction.NORMAL}
      />
    );
  }

  // Grain lowered and switched to soft-light blending so it reads as film
  // stock rather than TV static over the flat ink-950 background, where
  // additive noise at the previous opacity was most visible.
  effects.push(
    <Noise
      key="noise"
      premultiply
      opacity={0.022}
      blendFunction={BlendFunction.SOFT_LIGHT}
    />,
    <Vignette key="vignette" eskil={false} offset={0.18} darkness={0.95} />
  );

  return effects;
}

export function MeshScene({
  reducedMotion,
  tier,
  annotationRef,
}: {
  reducedMotion: boolean;
  tier: DeviceTier;
  /** DOM overlay the annotation callouts write their projected positions to. */
  annotationRef: React.RefObject<HTMLDivElement>;
}) {
  const settings = TIER_SETTINGS[tier];
  const [dense, setDense] = useState(tier !== "low");
  const stageRef = useRef<StageState>({ ...STATIC_STAGE });

  // Four reusable vectors the mechanism writes its part world-positions into
  // each frame, and the annotation layer reads. Allocated once so the
  // per-frame path never touches the allocator.
  const partAnchors = useRef([
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
  ]);

  const parked = useOffscreenParked(!settings.fullPageStage && !reducedMotion);
  const tabHidden = useTabHidden();

  // "demand" renders once and then only when invalidated — correct for a
  // reduced-motion visitor, who should get a single static composed frame.
  // "never" fully parks the loop: for an off-screen low-tier stage, or
  // whenever the tab is in the background.
  //
  // Note on the alternative: r3f's guidance for a persistent canvas is
  // `frameloop="demand"` plus `invalidate()` on scroll. That does not apply
  // here, because this scene is never genuinely idle by design — the mesh
  // rotates, claims fire on a timer, and the particle field drifts whether or
  // not the reader is scrolling. Switching to demand would mean freezing the
  // scene the moment scrolling stops, trading the "living instrument" read
  // for battery. The tier system and the visibility pause are where the cost
  // is recovered instead.
  const frameloop = reducedMotion
    ? "demand"
    : parked || tabHidden
      ? "never"
      : "always";

  return (
    <Canvas
      dpr={settings.dpr}
      frameloop={frameloop}
      camera={{ position: [0, 0, 12.4], fov: 45 }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      onCreated={({ gl, size }) => {
        gl.setClearColor("#000000", 0);
        // ACES filmic tonemapping is what keeps the bright halo cores from
        // clipping to flat white the moment bloom hits them — highlights roll
        // off instead of blowing out. This is a large part of why the scene
        // reads "shot" rather than "rendered".
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.15;
        setDense(size.width > 640);
      }}
      aria-hidden="true"
    >
      {/* Fog is doing double duty as the depth cue that DepthOfField would
          otherwise provide — see the known-issue note in scene/materials.ts.
          DoF was NOT re-attempted in this pass; the glBlitFramebuffer
          depth/stencil aliasing failure on r3f v8 + three 0.169 is a hard
          canvas-blanking bug, not a tuning problem. The far plane is pushed
          out because the closing act pulls the camera back to z ~16.5 and the
          old 15-unit fog end would have swallowed the whole graph. The range
          is set against the widened opening framing (camera at z 12.4) and
          the lattice field, which needs to genuinely dissolve into the
          background rather than end at a visible edge. */}
      <fog attach="fog" args={["#05070a", 14, 44]} />
      <ambientLight intensity={reducedMotion ? 0.7 : 0.45} />
      <pointLight position={[5, 5, 5]} intensity={30} color="#4fd1c5" />
      <pointLight position={[-6, -3, 2]} intensity={12} color="#FF6B35" />

      {settings.physicalNodes && (
        <Suspense fallback={null}>
          <StageEnvironment />
        </Suspense>
      )}

      {reducedMotion && <StaticFramePump />}

      <CameraRig reducedMotion={reducedMotion} stageRef={stageRef} />
      <Constellation
        reducedMotion={reducedMotion}
        dense={dense}
        physical={settings.physicalNodes}
        halo={settings.halo}
        stageRef={stageRef}
      />
      <AmbientField count={settings.particles} reducedMotion={reducedMotion} />
      <DaughterGlobes
        count={settings.swarm}
        reducedMotion={reducedMotion}
        stageRef={stageRef}
      />
      <TimeCorridor reducedMotion={reducedMotion} stageRef={stageRef} />

      {/* The mechanism and its callouts are ONE device on ONE timeline: the
          GLB supplies four addressable, authored parts, and the callouts
          label them. Both are gated to the full-page stage — the low tier's
          hero-scoped stage never reaches this act, so there is no reason to
          make a phone fetch a 65 KB model it will never render. */}
      {settings.fullPageStage && (
        <Suspense fallback={null}>
          <ExplodedMechanism
            reducedMotion={reducedMotion}
            stageRef={stageRef}
            anchorsRef={partAnchors}
          />
          {!reducedMotion && (
            <AnnotationLayer
              anchors={partAnchors}
              stageRef={stageRef}
              overlayRef={annotationRef}
            />
          )}
        </Suspense>
      )}

      {settings.postFx && (
        <Suspense fallback={null}>
          <EffectComposer multisampling={0}>{buildEffects(settings)}</EffectComposer>
        </Suspense>
      )}
    </Canvas>
  );
}
