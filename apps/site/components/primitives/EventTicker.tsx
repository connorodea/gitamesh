"use client";

import { motion, useInView } from "framer-motion";
import { useRef } from "react";

const EVENTS = ["CLAIMED", "HEARTBEAT", "RELEASED", "COMPLETED"];

/**
 * Append-only event log: a small marquee of event-name tokens scrolling
 * upward, as if new immutable events keep landing at the tail of the log.
 */
export function EventTicker({ reducedMotion }: { reducedMotion: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.8 });
  const items = [...EVENTS, ...EVENTS];

  return (
    <div
      ref={ref}
      className="relative h-10 w-24 overflow-hidden font-mono text-[10px] text-fg-faint"
      style={{
        maskImage:
          "linear-gradient(to bottom, transparent, black 30%, black 70%, transparent)",
      }}
    >
      <motion.div
        className="flex flex-col gap-1.5"
        animate={
          inView && !reducedMotion ? { y: ["0%", "-50%"] } : { y: "0%" }
        }
        transition={
          reducedMotion
            ? { duration: 0.01 }
            : { duration: 6, ease: "linear", repeat: Infinity }
        }
      >
        {items.map((label, i) => (
          <span key={`${label}-${i}`} className="whitespace-nowrap">
            &gt; {label}
          </span>
        ))}
      </motion.div>
    </div>
  );
}
