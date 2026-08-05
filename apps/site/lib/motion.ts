import type { Transition, Variants } from "framer-motion";

/**
 * Shared motion tokens so every section's scroll-reveal / hover / micro-
 * interaction animation shares one timing language instead of each
 * component inventing its own duration/easing. Mirrors the hero's
 * restrained, physical feel (organic shimmer and travelling pulses, not
 * bouncy/cartoonish easing).
 */
export const EASE_OUT: Transition["ease"] = [0.16, 1, 0.3, 1];
export const EASE_IN_OUT: Transition["ease"] = [0.65, 0, 0.35, 1];

export const DURATION = {
  fast: 0.2,
  base: 0.45,
  slow: 0.8,
} as const;

export const STAGGER_CHILD = 0.09;

/** Fade + rise-in reveal, the base entrance used across every section. */
export function revealVariants(reducedMotion: boolean): Variants {
  if (reducedMotion) {
    return {
      hidden: { opacity: 1, y: 0, filter: "none" },
      visible: { opacity: 1, y: 0, filter: "none" },
    };
  }
  return {
    hidden: { opacity: 0, y: 24, filter: "blur(6px)" },
    visible: {
      opacity: 1,
      y: 0,
      filter: "blur(0px)",
      transition: { duration: DURATION.slow, ease: EASE_OUT },
    },
  };
}

/** Parent container that staggers reveal of its direct motion children. */
export function staggerContainer(reducedMotion: boolean): Variants {
  return {
    hidden: {},
    visible: {
      transition: reducedMotion
        ? { staggerChildren: 0 }
        : { staggerChildren: STAGGER_CHILD, delayChildren: 0.05 },
    },
  };
}
