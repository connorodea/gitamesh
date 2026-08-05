import { Hero3D } from "@/components/Hero3D";
import { GithubIcon } from "@/components/GithubIcon";
import { Mark } from "@/components/Mark";

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

export default function Home() {
  return (
    <>
      <a id="main" />

      <header className="sticky top-0 z-40 border-b border-line/60 bg-ink-950/80 backdrop-blur">
        <nav
          aria-label="Primary"
          className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4"
        >
          <a
            href="#main"
            className="focus-ring flex items-center gap-2 text-sm font-semibold tracking-tight text-fg"
          >
            <Mark className="h-6 w-6 shrink-0" />
            Gitamesh
          </a>
          <div className="flex items-center gap-4 text-sm text-fg-muted sm:gap-6">
            <a
              className="focus-ring hidden hover:text-fg sm:inline"
              href="#problem"
            >
              Problem
            </a>
            <a
              className="focus-ring hidden hover:text-fg sm:inline"
              href="#how-it-works"
            >
              How it works
            </a>
            <a
              className="focus-ring hidden hover:text-fg sm:inline"
              href="#quickstart"
            >
              Quickstart
            </a>
            <a
              className="focus-ring flex shrink-0 items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-fg hover:border-mesh/60 hover:text-mesh"
              href="https://github.com/connorodea/gitamesh"
            >
              <GithubIcon className="h-4 w-4" />
              Source
            </a>
          </div>
        </nav>
      </header>

      <main>
        {/* HERO */}
        <section className="relative isolate overflow-hidden border-b border-line/60">
          <div className="pointer-events-none absolute inset-0 bg-grid bg-[size:42px_42px] [mask-image:radial-gradient(ellipse_65%_55%_at_50%_20%,black,transparent)]" />
          <div className="relative h-[440px] sm:h-[520px]">
            <Hero3D />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-ink-950/10 to-ink-950" />
          </div>
          <div className="mx-auto -mt-64 max-w-3xl px-6 pb-24 text-center sm:-mt-80">
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-ink-900/70 px-3 py-1 text-xs text-fg-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-claim" />
              v0.1.0 — open source, early
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-fg sm:text-6xl">
              Gitamesh
            </h1>
            <p className="mt-4 text-lg font-medium text-fg sm:text-xl">
              The coordination mesh for autonomous coding agents.
            </p>
            <p className="mx-auto mt-4 max-w-xl text-balance text-sm text-fg-muted sm:text-base">
              Gitamesh prevents duplicate work, conflicting implementations,
              and stale-worker races when multiple AI agents — Claude Code,
              Codex, Cursor, remote workers — operate across repos, branches,
              and worktrees at the same time.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <a
                href="#quickstart"
                className="focus-ring rounded-md bg-mesh px-5 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-mesh/90"
              >
                Get started
              </a>
              <a
                href="https://github.com/connorodea/gitamesh"
                className="focus-ring flex items-center gap-2 rounded-md border border-line px-5 py-2.5 text-sm font-medium text-fg transition hover:border-mesh/60 hover:text-mesh"
              >
                <GithubIcon className="h-4 w-4" />
                View on GitHub
              </a>
            </div>
          </div>
        </section>

        {/* PROBLEM */}
        <section id="problem" className="border-b border-line/60 py-20 sm:py-28">
          <div className="mx-auto max-w-6xl px-6">
            <div className="max-w-2xl">
              <h2 className="text-sm font-semibold uppercase tracking-widest text-mesh">
                The problem
              </h2>
              <p className="mt-3 text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
                More agents, same repo, no traffic control.
              </p>
              <p className="mt-3 text-fg-muted">
                Run one AI coding agent and coordination is trivial. Run five
                against the same repo and you get races that look like flaky
                CI until you trace them back to two workers editing the same
                thing at once.
              </p>
            </div>
            <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
              {PROBLEMS.map((p) => (
                <div key={p.title} className="bg-ink-900 p-6 sm:p-8">
                  <h3 className="font-semibold text-fg">{p.title}</h3>
                  <p className="mt-2 text-sm text-fg-muted">{p.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section
          id="how-it-works"
          className="border-b border-line/60 bg-ink-900/40 py-20 sm:py-28"
        >
          <div className="mx-auto max-w-6xl px-6">
            <div className="max-w-2xl">
              <h2 className="text-sm font-semibold uppercase tracking-widest text-mesh">
                How it works
              </h2>
              <p className="mt-3 text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
                Four primitives, one coordination engine.
              </p>
            </div>
            <ol className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {PRIMITIVES.map((p, i) => (
                <li
                  key={p.title}
                  className="rounded-xl border border-line bg-ink-950/60 p-6"
                >
                  <span className="font-mono text-xs text-claim">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h3 className="mt-3 font-semibold text-fg">{p.title}</h3>
                  <p className="mt-2 text-sm text-fg-muted">{p.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* QUICKSTART */}
        <section id="quickstart" className="py-20 sm:py-28">
          <div className="mx-auto max-w-4xl px-6">
            <div className="max-w-2xl">
              <h2 className="text-sm font-semibold uppercase tracking-widest text-mesh">
                Quickstart
              </h2>
              <p className="mt-3 text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
                Register the repo, register an agent, claim a task.
              </p>
              <p className="mt-3 text-fg-muted">
                The <code className="font-mono text-fg">gitamesh</code> CLI
                talks to a running daemon over HTTP for agent/task/lock
                operations, and to git directly for repo/worktree status — no
                daemon required for local checks.
              </p>
            </div>
            <div className="mt-10 overflow-hidden rounded-xl border border-line bg-ink-900">
              <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                <span className="h-2.5 w-2.5 rounded-full bg-line" />
                <span className="h-2.5 w-2.5 rounded-full bg-line" />
                <span className="h-2.5 w-2.5 rounded-full bg-line" />
                <span className="ml-2 font-mono text-xs text-fg-faint">
                  terminal
                </span>
              </div>
              <pre className="overflow-x-auto px-5 py-5 font-mono text-[13px] leading-relaxed text-fg">
{`$ pnpm add -g @gitamesh/cli
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
# attempt fails fast with a 409, fencing token intact`}
              </pre>
            </div>
            <p className="mt-4 text-sm text-fg-faint">
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

      <footer className="border-t border-line/60 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-6 text-sm text-fg-faint sm:flex-row sm:justify-between">
          <div className="flex items-center gap-2">
            <Mark className="h-4 w-4" />
            <span>Gitamesh — Apache-2.0, open source.</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <a
              className="focus-ring flex items-center gap-1.5 hover:text-fg"
              href="https://github.com/connorodea/gitamesh"
            >
              <GithubIcon className="h-4 w-4" />
              Source
            </a>
            <a
              className="focus-ring hover:text-fg"
              href="https://juricratic.com"
            >
              From the team behind Juricratic
            </a>
            <a
              className="focus-ring hover:text-fg"
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
