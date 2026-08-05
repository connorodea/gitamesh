"use client";

import { motion } from "framer-motion";
import { useReducedMotion } from "./useReducedMotion";
import { useSpotlight } from "./useSpotlight";
import { revealVariants } from "@/lib/motion";
import { ClaimLock } from "./primitives/ClaimLock";
import { FencingCounter } from "./primitives/FencingCounter";
import { LeaseRing } from "./primitives/LeaseRing";
import { EventTicker } from "./primitives/EventTicker";

const DIAGRAMS = [ClaimLock, FencingCounter, LeaseRing, EventTicker];

type PrimitiveCardProps = {
  index: number;
  title: string;
  body: string;
};

export function PrimitiveCard({ index, title, body }: PrimitiveCardProps) {
  const reducedMotion = useReducedMotion();
  const { ref, spotlightProps } = useSpotlight<HTMLDivElement>();
  const Diagram = DIAGRAMS[index];

  return (
    // A <div>, not an <li>: SpatialGroup supplies the <li> wrapper it needs
    // to own the depth transform, so list semantics live one level up.
    <motion.div
      ref={ref}
      {...spotlightProps}
      variants={revealVariants(reducedMotion)}
      className="spotlight group h-full rounded-2xl border border-line bg-ink-950/70 p-6 backdrop-blur-xl transition-[border-color,background-color] duration-500 ease-out hover:border-mesh/30 hover:bg-ink-950/85"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-mono text-[11px] tracking-[0.16em] text-claim">
          {String(index + 1).padStart(2, "0")}
        </span>
        <div className="text-fg-muted transition-colors duration-300 group-hover:text-mesh">
          <Diagram reducedMotion={reducedMotion} />
        </div>
      </div>
      <h3 className="mt-4 font-semibold tracking-[-0.015em] text-fg">{title}</h3>
      <p className="mt-2.5 text-[14px] leading-relaxed text-fg-muted">{body}</p>
    </motion.div>
  );
}
