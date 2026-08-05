"use client";

import { motion } from "framer-motion";
import { useReducedMotion } from "./useReducedMotion";
import { revealVariants, EASE_IN_OUT } from "@/lib/motion";

type ProblemCardProps = {
  title: string;
  body: string;
};

/**
 * Each problem card carries a small "conflict" motif above the copy: two
 * indicator dots drift toward each other and collide, flickering/glitching
 * on contact — a literal read of "two agents about to hit the same thing".
 * Idle drift is subtle and continuous; hovering the card speeds the
 * collision up and adds a glitch offset on the card border. Everything
 * freezes to a static, already-collided frame under reduced motion.
 */
export function ProblemCard({ title, body }: ProblemCardProps) {
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      variants={revealVariants(reducedMotion)}
      className="group relative overflow-hidden bg-ink-900 p-6 transition-colors duration-300 hover:bg-ink-800 sm:p-8"
    >
      <div
        aria-hidden="true"
        className="relative mb-5 h-6 w-20 shrink-0"
      >
        <span className="absolute left-0 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-mesh" />
        <span className="absolute right-0 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-claim" />
        <span className="absolute left-1/2 top-1/2 h-px w-full -translate-x-1/2 -translate-y-1/2 border-t border-dashed border-line" />
        {!reducedMotion && (
          <>
            <motion.span
              className="absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-mesh shadow-[0_0_6px_1px_rgba(79,209,197,0.6)]"
              animate={{ left: ["0%", "44%", "0%"] }}
              transition={{
                duration: 3.2,
                ease: EASE_IN_OUT,
                repeat: Infinity,
              }}
            />
            <motion.span
              className="absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-claim shadow-[0_0_6px_1px_rgba(245,185,66,0.6)]"
              style={{ right: 0 }}
              animate={{ right: ["0%", "44%", "0%"] }}
              transition={{
                duration: 3.2,
                ease: EASE_IN_OUT,
                repeat: Infinity,
              }}
            />
            <motion.span
              className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg"
              animate={{ opacity: [0, 0, 1, 0], scale: [0.6, 0.6, 1.4, 0.6] }}
              transition={{
                duration: 3.2,
                times: [0, 0.42, 0.5, 0.58],
                ease: EASE_IN_OUT,
                repeat: Infinity,
              }}
            />
          </>
        )}
      </div>
      <h3 className="font-semibold text-fg transition-transform duration-200 group-hover:translate-x-0.5">
        {title}
      </h3>
      <p className="mt-2 text-sm text-fg-muted">{body}</p>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 border border-transparent transition-colors duration-200 group-hover:border-claim/30"
      />
    </motion.div>
  );
}
