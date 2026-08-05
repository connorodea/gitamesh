"use client";

import { motion } from "framer-motion";
import type { HTMLMotionProps } from "framer-motion";
import { useReducedMotion } from "./useReducedMotion";
import { revealVariants, staggerContainer } from "@/lib/motion";

type RevealProps = HTMLMotionProps<"div"> & {
  as?: "div";
};

/**
 * Scroll-into-view fade+rise wrapper used for section headers, cards, and
 * standalone blocks. Fires once (viewport.once) so re-scrolling past a
 * section doesn't replay the entrance every time. Fully inert under
 * prefers-reduced-motion (renders visible with no transition).
 */
export function Reveal({ children, className, ...props }: RevealProps) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.3 }}
      variants={revealVariants(reducedMotion)}
      {...props}
    >
      {children}
    </motion.div>
  );
}

type RevealGroupProps = HTMLMotionProps<"div"> & {
  /** Element to render as — "ol" keeps list semantics when children are <li>. */
  as?: "div" | "ol";
};

/** Parent wrapper for grids of cards — staggers each direct <Reveal> child. */
export function RevealGroup({
  children,
  className,
  as = "div",
  ...props
}: RevealGroupProps) {
  const reducedMotion = useReducedMotion();
  const MotionTag = (as === "ol" ? motion.ol : motion.div) as typeof motion.div;
  return (
    <MotionTag
      className={className}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.2 }}
      variants={staggerContainer(reducedMotion)}
      {...props}
    >
      {children}
    </MotionTag>
  );
}
