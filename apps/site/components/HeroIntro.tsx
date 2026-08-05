"use client";

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

export function HeroIntro() {
  const reducedMotion = useReducedMotion();
  const { container, item } = useTimeline(reducedMotion);

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="visible"
      className="relative mx-auto w-full max-w-4xl text-center"
    >
      <motion.p
        variants={item}
        className="mb-6 inline-flex items-center gap-2 rounded-full border border-line/80 bg-ink-900/50 px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-fg-muted backdrop-blur-md"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-claim shadow-[0_0_10px_2px_rgba(255,107,53,0.55)]" />
        v0.1.0 — open source, early
      </motion.p>

      <motion.div
        variants={item}
        aria-hidden="true"
        className="mx-auto mb-8 h-px w-20 border-t border-dashed border-line"
      />

      {/* The wordmark carries the page. Very large, very tight tracking,
          leading pulled under 1 — display type set like a title sequence
          rather than an <h1> at whatever size the scale happened to offer. */}
      <h1 className="text-[clamp(3.25rem,13vw,9rem)] font-semibold leading-[0.85] tracking-[-0.055em] text-fg">
        <span className="sr-only">Gitamesh</span>
        <span aria-hidden="true" className="flex justify-center">
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
        </span>
      </h1>

      <motion.p
        variants={item}
        className="mx-auto mt-8 max-w-2xl text-balance text-[clamp(1.05rem,2.1vw,1.4rem)] font-medium leading-snug tracking-[-0.01em] text-fg"
      >
        The coordination mesh for autonomous coding agents.
      </motion.p>

      <motion.p
        variants={item}
        className="mx-auto mt-5 max-w-xl text-balance text-[15px] leading-relaxed text-fg-muted"
      >
        Gitamesh prevents duplicate work, conflicting implementations, and
        stale-worker races when multiple AI agents — Claude Code, Codex,
        Cursor, remote workers — operate across repos, branches, and worktrees
        at the same time.
      </motion.p>

      <motion.div
        variants={item}
        className="mt-10 flex flex-wrap items-center justify-center gap-3"
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
        className="pointer-events-none absolute -bottom-24 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2"
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
