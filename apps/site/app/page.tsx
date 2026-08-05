import { SceneStage } from "@/components/SceneStage";
import { SmoothScroll } from "@/components/SmoothScroll";
import { GithubIcon } from "@/components/GithubIcon";
import { Mark } from "@/components/Mark";
import { Reveal } from "@/components/Reveal";
import { SpatialGroup } from "@/components/SpatialGroup";
import { HeroIntro } from "@/components/HeroIntro";
import { ProblemCard } from "@/components/ProblemCard";
import { PrimitiveCard } from "@/components/PrimitiveCard";
import { TerminalBlock } from "@/components/TerminalBlock";
import { NavLink } from "@/components/NavLink";

const PROBLEMS = [
  {
    title: "Duplicate task claims",
    body: "Two agents pick up the same ticket at once and both start writing code for it — one run is wasted, sometimes both are wrong.",
  },
  {
    title: "Overlapping file edits",
    body: "Independent agents touch the same files or modules in parallel, and their changes land in conflicting, hard-to-reconcile diffs.",
  },
  {
    title: "Stale workers publishing late",
    body: "An agent loses its lease — timeout, crash, network blip — but keeps working anyway, and its output lands after a newer attempt already won.",
  },
  {
    title: "Orphaned jobs after crashes",
    body: "A worker dies mid-task with no heartbeat and no handoff, leaving the task stuck claimed forever with nothing to reclaim it.",
  },
];

const PRIMITIVES = [
  {
    title: "Atomic claims",
    body: "A task or resource can be claimed by exactly one agent at a time — the claim itself is the coordination point, not a convention agents have to honor.",
  },
  {
    title: "Monotonic fencing tokens",
    body: "Every claim carries a strictly increasing token, so a stale writer's late arrival is provably older than the current holder's — and gets rejected.",
  },
  {
    title: "Leases with heartbeats",
    body: "Claims expire unless renewed. A crashed or hung agent's lease lapses on its own, and the task becomes reclaimable without manual intervention.",
  },
  {
    title: "Append-only event log",
    body: "Every claim, heartbeat, and completion is an immutable event with a cursor — state is derived, replayable, and reconnect-safe end to end.",
  },
];

/** Small uppercase mono label used to open every section. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.24em] text-mesh">
      {children}
    </h2>
  );
}

export default function Home() {
  return (
    <>
      <SmoothScroll />
      <a id="main" />

      {/* The live WebGL stage sits behind everything at z-0. On mid/high
          tiers it is fixed for the whole document, so every section below
          scrolls over a continuing scene rather than past a hero widget. */}
      <SceneStage />

      <header className="sticky top-0 z-40 border-b border-line/40 bg-ink-950/60 backdrop-blur-xl">
        <nav
          aria-label="Primary"
          className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4"
        >
          <a
            href="#main"
            className="focus-ring group flex items-center gap-2.5 text-sm font-semibold tracking-tight text-fg"
          >
            <Mark className="h-6 w-6 shrink-0 transition-transform duration-500 ease-out group-hover:rotate-90" />
            Gitamesh
          </a>
          <div className="flex items-center gap-5 text-sm text-fg-muted sm:gap-8">
            <NavLink href="#problem">Problem</NavLink>
            <NavLink href="#how-it-works">How it works</NavLink>
            <NavLink href="#quickstart">Quickstart</NavLink>
            <a
              className="focus-ring flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-fg transition-colors duration-300 hover:border-mesh/60 hover:text-mesh"
              href="https://github.com/connorodea/gitamesh"
            >
              <GithubIcon className="h-4 w-4" />
              Source
            </a>
          </div>
        </nav>
      </header>

      <main className="relative z-10">
        {/* HERO — a full viewport, so the opening shot is the whole screen
            rather than a 440px band with copy stacked underneath it. */}
        <section className="relative isolate flex min-h-[100svh] flex-col items-center justify-center overflow-hidden px-6 pb-32 pt-24">
          <div className="pointer-events-none absolute inset-0 -z-10 bg-grid bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_45%,black,transparent)]" />
          <HeroIntro />
        </section>

        {/* PROBLEM */}
        <section id="problem" className="relative py-28 sm:py-40">
          <div className="mx-auto max-w-6xl px-6">
            <Reveal className="max-w-3xl">
              <Eyebrow>The problem</Eyebrow>
              <p className="mt-5 text-balance text-[clamp(1.9rem,4.2vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-fg">
                More agents, same repo, no traffic control.
              </p>
              <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-fg-muted">
                Run one AI coding agent and coordination is trivial. Run five
                against the same repo and you get races that look like flaky
                CI until you trace them back to two workers editing the same
                thing at once.
              </p>
            </Reveal>
            {/* The problem grid is deliberately NOT a flush mosaic any more:
                separated cards can each hold their own depth and yaw, which a
                shared-border slab cannot. */}
            <SpatialGroup className="mt-16 grid gap-4 sm:grid-cols-2">
              {PROBLEMS.map((p) => (
                <ProblemCard key={p.title} title={p.title} body={p.body} />
              ))}
            </SpatialGroup>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section id="how-it-works" className="relative py-28 sm:py-40">
          <div className="mx-auto max-w-6xl px-6">
            <Reveal className="max-w-3xl">
              <Eyebrow>How it works</Eyebrow>
              <p className="mt-5 text-balance text-[clamp(1.9rem,4.2vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-fg">
                Four primitives, one coordination engine.
              </p>
            </Reveal>
            <SpatialGroup
              as="ol"
              itemAs="li"
              className="mt-16 grid gap-5 sm:grid-cols-2 lg:grid-cols-4"
            >
              {PRIMITIVES.map((p, i) => (
                <PrimitiveCard key={p.title} index={i} title={p.title} body={p.body} />
              ))}
            </SpatialGroup>
          </div>
        </section>

        {/* QUICKSTART */}
        <section id="quickstart" className="relative py-28 sm:py-40">
          <div className="mx-auto max-w-4xl px-6">
            <Reveal className="max-w-2xl">
              <Eyebrow>Quickstart</Eyebrow>
              <p className="mt-5 text-balance text-[clamp(1.9rem,4.2vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-fg">
                Register the repo, register an agent, claim a task.
              </p>
              <p className="mt-6 text-[17px] leading-relaxed text-fg-muted">
                The <code className="font-mono text-fg">gitamesh</code> CLI
                talks to a running daemon over HTTP for agent/task/lock
                operations, and to git directly for repo/worktree status — no
                daemon required for local checks.
              </p>
            </Reveal>
            <Reveal className="mt-12">
              <TerminalBlock />
            </Reveal>
            <p className="mt-5 text-sm text-fg-faint">
              Every read command supports{" "}
              <code className="font-mono">--json</code> for scripting. Full
              command reference in{" "}
              <a
                className="focus-ring text-mesh hover:underline"
                href="https://github.com/connorodea/gitamesh/blob/main/packages/cli/README.md"
              >
                packages/cli/README.md
              </a>
              .
            </p>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-line/50 bg-ink-950/80 py-12 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-6 text-sm text-fg-faint sm:flex-row sm:justify-between">
          <div className="flex items-center gap-2">
            <Mark className="h-4 w-4" />
            <span>Gitamesh — Apache-2.0, open source.</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <a
              className="focus-ring flex items-center gap-1.5 transition-colors duration-300 hover:text-mesh"
              href="https://github.com/connorodea/gitamesh"
            >
              <GithubIcon className="h-4 w-4" />
              Source
            </a>
            <a
              className="focus-ring transition-colors duration-300 hover:text-mesh"
              href="https://juricratic.com"
            >
              From the team behind Juricratic
            </a>
            <a
              className="focus-ring transition-colors duration-300 hover:text-mesh"
              href="https://api.gitamesh.com/healthz"
            >
              API status
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}
