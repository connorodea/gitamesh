"use client";

import dynamic from "next/dynamic";
import { useReducedMotion } from "./useReducedMotion";

const MeshScene = dynamic(
  () => import("./MeshScene").then((m) => m.MeshScene),
  { ssr: false }
);

export function Hero3D() {
  const reducedMotion = useReducedMotion();

  return (
    <div className="pointer-events-none absolute inset-0" role="presentation">
      <MeshScene reducedMotion={reducedMotion} />
    </div>
  );
}
