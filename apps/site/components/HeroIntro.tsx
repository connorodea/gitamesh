"use client";

import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { GithubIcon } from "./GithubIcon";
import { useReducedMotion } from "./useReducedMotion";

/**
 * The opening title card.
 *
 * Choreographed rather than faded: each element rises on its own beat, and
 * the wordmark's letters resolve individually. The order is deliberate —
 * status pill, rule, wordmark, positioning line, body, actions, scroll cue —
 * so the eye is walked down the page in the order the copy wants to be read,
 * and the last thing to appear is the invitation to keep scrolling.
 *
 * The whole timeline collapses to `duration: 0` under prefers-reduced-motion:
 * every element renders in its final state on the first frame, no transforms,
 * no stagger.
 */

const ease = [0.16, 1, 0.3, 1] as const;

function useTimeline(reduced: boolean) {
  const container = {
    hidden: {},
    visible: {
      transition: reduced
        ? { staggerChildren: 0, delayChildren: 0 }
        : { staggerChildren: 0.085, delayChildren: 0.15 },
    },
  };
  const item = {
    hidden: reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 22, filter: "blur(6px)" },
    visible: {
      opacity: 1,
      y: 0,
      filter: "blur(0px)",
      transition: reduced ? { duration: 0 } : { duration: 0.95, ease },
    },
  };
  return { container, item };
}

const WORDMARK = "Gitamesh".split("");

/** Shared type treatment — both painted copies MUST render identically. */
const WORDMARK_CLASS =
  "flex justify-center text-[clamp(3.25rem,13vw,9rem)] font-semibold leading-[0.85] tracking-[-0.055em] text-fg";

/**
 * The letterforms, staggered in. Rendered twice (back and front copies of the
 * split); both run the same variants off the same parent, so the two copies
 * animate in lockstep and the seam between them is never visible.
 */
function Letters({ reducedMotion }: { reducedMotion: boolean }) {
  return (
    <>
      {WORDMARK.map((char, i) => (
        <motion.span
          key={`${char}-${i}`}
          variants={{
            hidden: reducedMotion
              ? { opacity: 1, y: 0 }
              : { opacity: 0, y: "0.35em" },
            visible: {
              opacity: 1,
              y: 0,
              transition: reducedMotion
                ? { duration: 0 }
                : { duration: 1.05, ease, delay: 0.32 + i * 0.038 },
            },
          }}
          className="inline-block will-change-transform"
        >
          {char}
        </motion.span>
      ))}
    </>
  );
}

export function HeroIntro() {
  const reducedMotion = useReducedMotion();
  const { container, item } = useTimeline(reducedMotion);
  const wordmarkRef = useRef<HTMLDivElement>(null);
  const frontRef = useRef<HTMLDivElement>(null);

  /**
   * Keep the split line on the globe.
   *
   * The canvas is fixed and its camera looks at the world origin, so the
   * globe's centre stays at roughly the viewport's vertical centre no matter
   * where the page is scrolled. The wordmark, being in normal flow, does not
   * — it travels up and off screen. A hard-coded `inset(50% ...)` would
   * therefore only be correct at one scroll position and would visibly slide
   * off the globe everywhere else.
   *
   * So the clip is derived every frame from the real rects: convert the
   * viewport centre into a percentage down the wordmark's own box. Writes one
   * custom property on one element; no React state, no layout thrash beyond a
   * single rect read.
   */
  useEffect(() => {
    let frame = 0;
    let last = "";
    const update = () => {
      frame = requestAnimationFrame(update);
      const box = wordmarkRef.current;
      const front = frontRef.current;
      if (!box || !front) return;

      const rect = box.getBoundingClientRect();
      if (rect.height <= 0) return;
      const globeCenterY = (window.innerHeight || 1) / 2;
      const pct = ((globeCenterY - rect.top) / rect.height) * 100;
      // Clamp so the front copy is never fully clipped away (which would drop
      // the lower half of the headline) nor fully painted (which would hide
      // the globe behind it entirely).
      const clamped = Math.max(0, Math.min(100, pct)).toFixed(2) + "%";
      if (clamped !== last) {
        last = clamped;
        front.style.setProperty("--split-y", clamped);
      }
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="visible"
      className="relative mx-auto w-full max-w-4xl text-center"
    >
      <motion.p
        variants={item}
        className="relative z-30 mb-6 inline-flex items-center gap-2 rounded-full border border-line/80 bg-ink-900/50 px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-fg-muted backdrop-blur-md"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-claim shadow-[0_0_10px_2px_rgba(255,107,53,0.55)]" />
        v0.1.0 — open source, early
      </motion.p>

      <motion.div
        variants={item}
        aria-hidden="true"
        className="relative z-30 mx-auto mb-8 h-px w-20 border-t border-dashed border-line"
      />

      {/* THE SPLIT.
          The globe does not sit behind the headline — it passes THROUGH it.
          Two aria-hidden visual copies of the wordmark straddle the canvas in
          z-order (back copy below it, front copy above it), and the front copy
          is clipped to only paint below the globe's screen-space centre. The
          result is that the upper half of the letterforms is occluded by the
          globe while the lower half occludes it, so the type is genuinely
          bisected by the object rather than layered over a backdrop.

          Accessibility: exactly ONE copy is in the accessibility tree — the
          sr-only <h1>. Both painted copies are aria-hidden, so a screen reader
          hears "Gitamesh" once, not three times.

          The clip line is measured, not guessed: `--split-y` is recomputed
          from the real rects each frame (see below), so the split tracks the
          globe as the hero scrolls instead of drifting off it. */}
      <h1 className="sr-only">Gitamesh</h1>

      <div ref={wordmarkRef} className="relative">
        {/* BACK copy — in normal flow, so it defines the layout box. Sits
            beneath the canvas layer. */}
        <div aria-hidden="true" className={`relative z-0 ${WORDMARK_CLASS}`}>
          <Letters reducedMotion={reducedMotion} />
        </div>
        {/* FRONT copy — an exact overlay, above the canvas, clipped to the
            portion of the letterforms that should occlude the globe. */}
        <div
          ref={frontRef}
          aria-hidden="true"
          className={`absolute inset-0 z-30 ${WORDMARK_CLASS}`}
          style={{ clipPath: "inset(var(--split-y, 50%) 0 0 0)" }}
        >
          <Letters reducedMotion={reducedMotion} />
        </div>
      </div>

      <motion.p
        variants={item}
        className="relative z-30 mx-auto mt-8 max-w-2xl text-balance text-[clamp(1.05rem,2.1vw,1.4rem)] font-medium leading-snug tracking-[-0.01em] text-fg"
      >
        The coordination mesh for autonomous coding agents.
      </motion.p>

      <motion.p
        variants={item}
        className="relative z-30 mx-auto mt-5 max-w-xl text-balance text-[15px] leading-relaxed text-fg-muted"
      >
        Gitamesh prevents duplicate work, conflicting implementations, and
        stale-worker races when multiple AI agents — Claude Code, Codex,
        Cursor, remote workers — operate across repos, branches, and worktrees
        at the same time.
      </motion.p>

      <motion.div
        variants={item}
        className="relative z-30 mt-10 flex flex-wrap items-center justify-center gap-3"
      >
        <a
          href="#quickstart"
          className="focus-ring group relative overflow-hidden rounded-full bg-mesh px-6 py-3 text-sm font-semibold text-ink-950 transition-transform duration-300 ease-out hover:scale-[1.03] active:scale-[0.99]"
        >
          {/* A single specular sweep on hover — the button catching the same
              light the scene behind it is catching. */}
          <span
            aria-hidden="true"
            className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/45 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-full motion-reduce:hidden"
          />
          <span className="relative">Get started</span>
        </a>
        <a
          href="https://github.com/connorodea/gitamesh"
          className="focus-ring flex items-center gap-2 rounded-full border border-line px-6 py-3 text-sm font-medium text-fg backdrop-blur-md transition-colors duration-300 hover:border-mesh/60 hover:text-mesh"
        >
          <GithubIcon className="h-4 w-4" />
          View on GitHub
        </a>
      </motion.div>

      <motion.div
        variants={item}
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-24 z-30 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2"
        style={{ opacity: "calc(1 - var(--hero-progress, 0) * 3)" }}
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-fg-faint">
          Scroll
        </span>
        <span className="relative block h-10 w-px overflow-hidden bg-line">
          <span className="scroll-cue absolute inset-x-0 top-0 block h-4 bg-mesh" />
        </span>
      </motion.div>
    </motion.div>
  );
}
