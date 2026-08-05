"use client";

import { useEffect } from "react";
import { CALLOUTS } from "./scene/annotationCallouts";

/**
 * The DOM half of the annotation-callout system.
 *
 * Rendered outside the Canvas, absolutely positioned over it, and updated
 * only by `AnnotationLayer` (which lives inside the r3f tree and writes each
 * callout's projected screen position into `--ax`/`--ay`).
 *
 * This file deliberately imports NOTHING from three.js or r3f. It is rendered
 * eagerly by the stage, whereas the WebGL scene is a lazily-loaded chunk — so
 * if this module pulled in the r3f side, the entire three.js bundle would be
 * hoisted into the page's initial JS. It did exactly that before this split,
 * costing ~210 kB of First Load JS for four small labels.
 *
 * Each callout is a short diagonal leader line with a terminal dot at the
 * anchor end and a monospace number/label at the other, matching the corner
 * HUD type used elsewhere.
 */
export function AnnotationOverlay({
  overlayRef,
}: {
  overlayRef: React.RefObject<HTMLDivElement>;
}) {
  // Ensure the overlay starts hidden even before the first projected frame,
  // so callouts never flash at a stale position on mount.
  useEffect(() => {
    const el = overlayRef.current;
    if (el) {
      el.style.opacity = "0";
      el.style.visibility = "hidden";
    }
  }, [overlayRef]);

  return (
    <div
      ref={overlayRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 transition-opacity duration-300"
    >
      {CALLOUTS.map((c) => (
        <div
          key={c.id}
          className="absolute left-0 top-0 transition-opacity duration-300"
          style={{ transform: "translate3d(var(--ax, -100px), var(--ay, -100px), 0)" }}
        >
          {/* Terminal dot sitting on the node itself. */}
          <span className="absolute -left-[3px] -top-[3px] block h-1.5 w-1.5 rounded-full bg-mesh" />
          {/* Diagonal leader line out to the label. */}
          <span className="absolute left-0 top-0 block h-px w-14 origin-left -rotate-[38deg] bg-mesh/50" />
          <span className="absolute left-[44px] top-[-38px] block whitespace-nowrap font-mono text-[10px] uppercase leading-none tracking-[0.22em] text-mesh">
            <span className="text-claim">{c.id}</span>
            <span className="ml-1.5 text-fg-muted">{c.label}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
