"use client";

import { motion } from "framer-motion";
import { EASE_OUT } from "@/lib/motion";

/** Atomic claims: a padlock shackle that snaps shut once, on scroll-in. */
export function ClaimLock({ reducedMotion }: { reducedMotion: boolean }) {
  return (
    <svg
      viewBox="0 0 48 40"
      className="h-10 w-12"
      aria-hidden="true"
      fill="none"
    >
      <motion.path
        d="M14 18 V13 a10 10 0 0 1 20 0 V18"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="text-fg-muted"
        initial={reducedMotion ? undefined : { rotate: -14, y: -3 }}
        whileInView={{ rotate: 0, y: 0 }}
        viewport={{ once: true, amount: 0.8 }}
        transition={{ duration: 0.5, ease: EASE_OUT, delay: 0.15 }}
        style={{ transformOrigin: "38px 18px" }}
      />
      <rect
        x="8"
        y="18"
        width="32"
        height="20"
        rx="4"
        className="fill-ink-950 stroke-mesh"
        strokeWidth="2"
      />
      <motion.circle
        cx="24"
        cy="27"
        r="2.4"
        className="fill-claim"
        initial={reducedMotion ? undefined : { scale: 0, opacity: 0 }}
        whileInView={{ scale: 1, opacity: 1 }}
        viewport={{ once: true, amount: 0.8 }}
        transition={{ duration: 0.3, ease: EASE_OUT, delay: 0.55 }}
      />
    </svg>
  );
}
