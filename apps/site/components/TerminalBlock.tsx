"use client";

import { motion, useInView } from "framer-motion";
import { useMemo, useRef, useState, useEffect } from "react";
import { useReducedMotion } from "./useReducedMotion";
import { EASE_OUT } from "@/lib/motion";

type Line = {
  text: string;
  kind: "cmd" | "output" | "comment" | "blank";
};

/** Verbatim CLI content — presentation-only changes happen around this. */
const RAW = `$ pnpm add -g @gitamesh/cli
$ gitamesh init --daemon-url http://127.0.0.1:4477
$ gitamesh doctor
✔ git repository detected
✔ daemon reachable at http://127.0.0.1:4477
✔ token valid (scopes: agent, task, claim)

$ gitamesh repo register --display-name "gitamesh"
$ gitamesh agent register \\
    --display-name "claude-code-1" \\
    --runtime "claude-code" \\
    --capability "typescript" --capability "test"

$ gitamesh task create \\
    --workflow-id wf_default \\
    --repository-id repo_gitamesh \\
    --title "Fix flaky worktree test" \\
    --priority high

$ gitamesh task claim <taskId> \\
    --agent-id <agentId> \\
    --workspace-session-id <sessionId>
# exactly one caller gets the claim — every other
# attempt fails fast with a 409, fencing token intact`;

function classify(raw: string): Line[] {
  return raw.split("\n").map((text) => {
    if (text.trim() === "") return { text, kind: "blank" };
    if (text.startsWith("$")) return { text, kind: "cmd" };
    if (text.startsWith("#")) return { text, kind: "comment" };
    if (text.startsWith("✔")) return { text, kind: "output" };
    // continuation line of a multi-line command (indented, backslash-joined)
    return { text, kind: "cmd" };
  });
}

function tint(line: Line): string {
  switch (line.kind) {
    case "cmd":
      return "text-fg";
    case "output":
      return "text-mesh";
    case "comment":
      return "text-fg-faint";
    default:
      return "text-fg";
  }
}

export function TerminalBlock() {
  const reducedMotion = useReducedMotion();
  const ref = useRef<HTMLPreElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.35 });
  const lines = useMemo(() => classify(RAW), []);
  const [showCursor, setShowCursor] = useState(reducedMotion);

  // per-line reveal delay: cmd lines pause like a typed keystroke beat,
  // output/comment lines snap in right after (as if printed by the shell).
  const delays = useMemo(() => {
    let t = 0;
    return lines.map((line) => {
      const start = t;
      t += line.kind === "cmd" ? 0.11 : line.kind === "blank" ? 0.04 : 0.045;
      return start;
    });
  }, [lines]);

  const totalDelay = delays.length
    ? delays[delays.length - 1] + 0.15
    : 0;

  useEffect(() => {
    if (reducedMotion) return;
    if (!inView) return;
    const id = setTimeout(() => setShowCursor(true), totalDelay * 1000);
    return () => clearTimeout(id);
  }, [inView, reducedMotion, totalDelay]);

  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-ink-900">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-line" />
        <span className="h-2.5 w-2.5 rounded-full bg-line" />
        <span className="h-2.5 w-2.5 rounded-full bg-line" />
        <span className="ml-2 font-mono text-xs text-fg-faint">terminal</span>
      </div>
      <div className="relative">
        {/* scanline + glow overlay, purely decorative, gated for reduced motion */}
        {!reducedMotion && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-10 opacity-[0.06]"
            style={{
              backgroundImage:
                "repeating-linear-gradient(to bottom, rgba(232,236,241,0.7) 0px, rgba(232,236,241,0.7) 1px, transparent 1px, transparent 3px)",
            }}
          />
        )}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-gradient-to-b from-mesh/[0.05] to-transparent"
        />
        <pre
          ref={ref}
          className="relative overflow-x-auto px-5 py-5 font-mono text-[13px] leading-relaxed"
        >
          {lines.map((line, i) => (
            <motion.div
              key={i}
              initial={reducedMotion ? undefined : { opacity: 0, y: 4 }}
              animate={
                reducedMotion
                  ? { opacity: 1, y: 0 }
                  : inView
                    ? { opacity: 1, y: 0 }
                    : {}
              }
              transition={{
                duration: 0.22,
                ease: EASE_OUT,
                delay: reducedMotion ? 0 : delays[i],
              }}
              className={tint(line)}
            >
              {line.text || " "}
            </motion.div>
          ))}
          <motion.span
            aria-hidden="true"
            className="mt-1 inline-block h-[14px] w-[7px] translate-y-[3px] bg-mesh"
            initial={{ opacity: 0 }}
            animate={
              showCursor
                ? reducedMotion
                  ? { opacity: 1 }
                  : { opacity: [1, 1, 0, 0] }
                : { opacity: 0 }
            }
            transition={
              reducedMotion
                ? { duration: 0.01 }
                : { duration: 1, repeat: Infinity, times: [0, 0.5, 0.5, 1] }
            }
          />
        </pre>
      </div>
    </div>
  );
}
