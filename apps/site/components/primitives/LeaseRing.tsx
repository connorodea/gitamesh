"use client";

import { motion, useInView } from "framer-motion";
import { useRef } from "react";

/**
 * Leases with heartbeats: an SVG ring counts down (stroke-dashoffset), then
 * a heartbeat pulse resets it before expiry — visualizing "renewed lease
 * keeps living; an un-renewed one would run out."
 */
export function LeaseRing({ reducedMotion }: { reducedMotion: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.8 });
  const radius = 14;
  const circumference = 2 * Math.PI * radius;

  return (
    <div ref={ref} className="relative h-10 w-10">
      <svg viewBox="0 0 32 32" className="h-10 w-10 -rotate-90">
        <circle
          cx="16"
          cy="16"
          r={radius}
          className="stroke-line"
          strokeWidth="2.5"
          fill="none"
        />
        <motion.circle
          cx="16"
          cy="16"
          r={radius}
          className="stroke-mesh"
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={
            inView
              ? reducedMotion
                ? { strokeDashoffset: circumference * 0.25 }
                : {
                    strokeDashoffset: [
                      circumference,
                      circumference * 0.72,
                      circumference * 0.18,
                      circumference * 0.72,
                    ],
                  }
              : {}
          }
          transition={
            reducedMotion
              ? { duration: 0.01 }
              : { duration: 2.6, ease: "easeInOut", times: [0, 0.42, 0.5, 1] }
          }
        />
      </svg>
      <span
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-center font-mono text-[9px] text-fg-faint"
      >
        TTL
      </span>
    </div>
  );
}
