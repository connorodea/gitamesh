"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "./useReducedMotion";
import { useDeviceTier, TIER_SETTINGS } from "./scene/deviceTier";
// Imported from the DOM-only module, NOT from scene/AnnotationLayer — that
// file imports three.js and would be hoisted into the initial bundle.
import { AnnotationOverlay } from "./AnnotationOverlay";
import { TimeCursorHud } from "./TimeCursorHud";

const MeshScene = dynamic(
  () => import("./MeshScene").then((m) => m.MeshScene),
  { ssr: false }
);

/**
 * A thin bordered reticle around the focal 3D element — a cheap DOM/CSS
 * overlay (no WebGL cost) that reads as "framed with intention" rather than
 * a scene floating in a void. Corner ticks + a dashed rule, matching the
 * dashed-divider motif used elsewhere on the page.
 *
 * It fades out with hero progress: the frame belongs to the opening shot, and
 * a viewfinder still hanging around the terminal block would read as chrome.
 */
function ViewfinderFrame() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-6 inset-y-10 rounded-[28px] border border-dashed border-fg-faint/20 sm:inset-x-16 sm:inset-y-16"
      style={{ opacity: "calc(1 - var(--scrim, 0))" }}
    >
      {[
        "left-[-1px] top-[-1px] border-l border-t rounded-tl-md",
        "right-[-1px] top-[-1px] border-r border-t rounded-tr-md",
        "left-[-1px] bottom-[-1px] border-l border-b rounded-bl-md",
        "right-[-1px] bottom-[-1px] border-r border-b rounded-br-md",
      ].map((pos) => (
        <span key={pos} className={`absolute h-5 w-5 border-mesh/40 ${pos}`} />
      ))}
    </div>
  );
}

/**
 * The WebGL stage.
 *
 * On mid/high tiers this is `position: fixed` and spans the viewport for the
 * entire document — the page's sections scroll *over* a live scene rather
 * than past a 3D box parked at the top. That single change is most of what
 * separates "cinematic page" from "3D hero widget bolted onto a marketing
 * page": the camera track in CameraRig.tsx has something to play across, and
 * the reader never crosses a boundary where the production value stops.
 *
 * On the low tier it stays absolutely positioned inside the hero and parks
 * its render loop once scrolled past (see MeshScene). A phone gets the
 * opening shot and then its GPU back.
 *
 * A scrim sits between the canvas and the page content, ramping in with hero
 * scroll progress (`--scrim`, published by the scroll store). It guarantees
 * body-copy contrast over a scene whose brightness is, by design, changing —
 * text legibility can't be left to depend on where the constellation happens
 * to be.
 */
/**
 * A deliberately crude monospace progress bar shown while the WebGL bundle
 * loads and the scene composes its first frames.
 *
 * The device is borrowed from the reference: a lo-fi, almost teletype loader
 * immediately before a high-fidelity render. The contrast is the point — it
 * frames what follows as a payload that had to be *loaded*, which makes the
 * render land harder than a spinner or a skeleton would. It is also honest:
 * there really is a three.js bundle being fetched here.
 *
 * Hidden from assistive tech and skipped entirely under reduced motion, where
 * an animating bar would be exactly the wrong thing to show.
 */
function SceneLoader({ done }: { done: boolean }) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (done) return;
    const id = setInterval(() => setStep((s) => s + 1), 90);
    return () => clearInterval(id);
  }, [done]);

  const width = 22;
  const head = step % (width + 6);
  const bar = Array.from({ length: width }, (_, i) => {
    const d = Math.abs(i - head);
    if (d === 0) return "+";
    if (d <= 2) return "=";
    return "—";
  }).join("");

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-700"
      style={{ opacity: done ? 0 : 1 }}
    >
      <span className="font-mono text-[11px] tracking-[0.3em] text-fg-faint motion-reduce:hidden">
        {bar}
      </span>
    </div>
  );
}

/**
 * Corner-anchored monospace HUD chrome.
 *
 * The reference uses corner labels as the *only* DOM furniture over its
 * scene, which is what makes the centre of the frame feel deliberately empty
 * rather than merely unused. Four small technical labels do more for the
 * "instrument, not brochure" read than any amount of added ornament, and they
 * cost nothing.
 */
function StageHud() {
  const items = [
    { pos: "left-6 top-24 sm:left-10", text: "MESH / 01" },
    { pos: "right-6 top-24 sm:right-10", text: "LIVE" },
    { pos: "right-6 bottom-10 sm:right-10", text: "APACHE-2.0" },
  ];
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {items.map((i) => (
        <span
          key={i.text}
          className={`absolute font-mono text-[9px] uppercase tracking-[0.3em] text-fg-faint/70 ${i.pos}`}
          style={{ opacity: "calc(1 - var(--scrim, 0))" }}
        >
          {i.text}
        </span>
      ))}
      {/* The time cursor stays visible for the whole journey — unlike the
          other HUD chrome, it is the readout for what scrolling MEANS here,
          so it must not retire once the hero does. */}
      <TimeCursorHud />
    </div>
  );
}

export function SceneStage() {
  const reducedMotion = useReducedMotion();
  const tier = useDeviceTier();
  const [mounted, setMounted] = useState(false);
  const annotationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A brief fade rather than a hard pop once the client-only scene mounts.
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Hold off on committing to a layout until the tier is measured — the tier
  // decides whether this element is fixed or absolute, and swapping that
  // after paint would visibly jump the scene.
  if (!tier) return null;

  const fullPage = TIER_SETTINGS[tier].fullPageStage;

  return (
    <>
      {/* SCRIM — its own layer, BELOW the canvas.
          Splitting it out of the stage is what makes weaving possible: page
          content can now be placed at a z-index between the scrim and the
          canvas, so geometry passes in FRONT of it while the scrim still
          guarantees its contrast. A single combined stage layer forced every
          piece of content to be strictly in front of all geometry, which is
          exactly the "3D wallpaper behind a webpage" problem. */}
      <div
        aria-hidden="true"
        className={
          fullPage
            ? "pointer-events-none fixed inset-0 z-[5] bg-ink-950"
            : "pointer-events-none absolute inset-0 z-[5] bg-ink-950"
        }
        style={{ opacity: "calc(var(--scrim, 0) * 0.82)" }}
      />

      <div
        id="scene-stage"
        className={
          fullPage
            ? "pointer-events-none fixed inset-0 z-10"
            : "pointer-events-none absolute inset-0 z-10"
        }
        role="presentation"
      >
        {!reducedMotion && <SceneLoader done={mounted} />}

        <div
          className="absolute inset-0 transition-opacity duration-1000 ease-out"
          style={{ opacity: mounted ? 1 : 0 }}
        >
          <MeshScene
            reducedMotion={reducedMotion}
            tier={tier}
            annotationRef={annotationRef}
          />
        </div>

        {/* Schematic callouts pinned to the mechanism's named parts. Real DOM,
            drawn over the canvas, positioned by AnnotationLayer in the scene. */}
        {fullPage && !reducedMotion && (
          <AnnotationOverlay overlayRef={annotationRef} />
        )}

        {/* Grounds the opening shot into the page below it; retires as the
            scrim takes over so it never reads as a permanent viewport band. */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-ink-950 to-transparent"
          style={{ opacity: "calc(1 - var(--scrim, 0))" }}
        />

        <ViewfinderFrame />
        <StageHud />
      </div>
    </>
  );
}
