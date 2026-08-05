"use client";

import { useEffect, useState } from "react";
import { motion, useInView } from "framer-motion";
import { useRef } from "react";

/**
 * Monotonic fencing tokens: a counter ticks upward (token #s being issued),
 * then a late/stale token (a lower number) flashes in and gets visibly
 * rejected — a tiny dramatization of "stale writer arrives late, provably
 * older, denied."
 */
export function FencingCounter({ reducedMotion }: { reducedMotion: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.8 });
  const [token, setToken] = useState(41);
  const [rejected, setRejected] = useState(false);

  useEffect(() => {
    if (!inView || reducedMotion) {
      if (reducedMotion) setToken(44);
      return;
    }
    const steps = [42, 43, 44];
    const timers = steps.map((v, i) =>
      setTimeout(() => setToken(v), 220 * (i + 1))
    );
    const rejectTimer = setTimeout(() => setRejected(true), 220 * 4);
    const resetTimer = setTimeout(() => setRejected(false), 220 * 4 + 900);
    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(rejectTimer);
      clearTimeout(resetTimer);
    };
  }, [inView, reducedMotion]);

  return (
    <div ref={ref} className="flex h-10 items-center gap-2 font-mono text-sm">
      <span className="rounded border border-mesh/40 bg-mesh/10 px-2 py-1 tabular-nums text-mesh">
        #{token}
      </span>
      <motion.span
        className="rounded border border-claim/40 bg-claim/10 px-2 py-1 tabular-nums text-claim"
        animate={
          rejected && !reducedMotion
            ? { opacity: [1, 0.3, 1], x: [0, -2, 2, 0] }
            : { opacity: 1, x: 0 }
        }
        transition={{ duration: 0.35 }}
      >
        #40{rejected ? " ✕" : ""}
      </motion.span>
    </div>
  );
}
