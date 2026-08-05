"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useReducedMotion } from "./useReducedMotion";

const MeshScene = dynamic(
  () => import("./MeshScene").then((m) => m.MeshScene),
  { ssr: false }
);

/**
 * A thin bordered reticle around the focal 3D element — a cheap DOM/CSS
 * overlay (no WebGL cost) that reads as "framed with intention" rather than
 * a scene floating in a void. Corner ticks + a dashed rule, matching the
 * dashed-divider motif used elsewhere on the page.
 */
function ViewfinderFrame() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-6 inset-y-10 rounded-[28px] border border-dashed border-fg-faint/25 sm:inset-x-12 sm:inset-y-14"
    >
      {[
        "left-[-1px] top-[-1px] border-l border-t rounded-tl-md",
        "right-[-1px] top-[-1px] border-r border-t rounded-tr-md",
        "left-[-1px] bottom-[-1px] border-l border-b rounded-bl-md",
        "right-[-1px] bottom-[-1px] border-r border-b rounded-br-md",
      ].map((pos) => (
        <span
          key={pos}
          className={`absolute h-4 w-4 border-mesh/50 ${pos}`}
        />
      ))}
    </div>
  );
}

export function Hero3D() {
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // A brief fade rather than a hard pop once the client-only scene mounts.
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      id="hero-3d-root"
      className="pointer-events-none absolute inset-0"
      role="presentation"
    >
      <div
        className="absolute inset-0 transition-opacity duration-700 ease-out"
        style={{ opacity: mounted ? 1 : 0 }}
      >
        <MeshScene reducedMotion={reducedMotion} />
      </div>
      <ViewfinderFrame />
    </div>
  );
}
