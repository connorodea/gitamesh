"use client";

import { motion } from "framer-motion";
import { useReducedMotion } from "./useReducedMotion";
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
  const Diagram = DIAGRAMS[index];

  return (
    <motion.li
      variants={revealVariants(reducedMotion)}
      className="group rounded-xl border border-line bg-ink-950/60 p-6 transition-colors duration-300 hover:border-mesh/40 hover:bg-ink-950"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-mono text-xs text-claim">
          {String(index + 1).padStart(2, "0")}
        </span>
        <div className="text-fg-muted transition-colors duration-300 group-hover:text-mesh">
          <Diagram reducedMotion={reducedMotion} />
        </div>
      </div>
      <h3 className="mt-3 font-semibold text-fg">{title}</h3>
      <p className="mt-2 text-sm text-fg-muted">{body}</p>
    </motion.li>
  );
}
