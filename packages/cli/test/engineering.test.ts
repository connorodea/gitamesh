import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { createFakeFetch } from "./support/fake-fetch.js";
import { createFakeSink } from "./support/fake-sink.js";

describe("gitamesh engineering", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  const fixture = fileURLToPath(new URL("./support/engineering-adapter", import.meta.url));

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gitamesh-engineering-"));
    env = {
      PATH: process.env.PATH,
      GITAMESH_ENGINEERING_TRUSTED_MAIN: fixture,
      GITAMESH_ENGINEERING_PYTHON: "python3",
      GITAMESH_REPOSITORY_ID: "repo_fixture",
      GITAMESH_DAEMON_URL: "http://127.0.0.1:4321",
      GITAMESH_TOKEN: "fixture-secret",
      ENGINEERING_FIXTURE_LOG: path.join(cwd, "calls.jsonl"),
    };
  });
  afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });

  async function call(command: string, args: string[] = ["--repo", "owner/repo", "--json"]) {
    const sink = createFakeSink();
    const code = await runCli(["node", "gitamesh", "engineering", command, ...args], { cwd, env, sink });
    return { code, sink };
  }

  async function calls() {
    return (await fs.readFile(env.ENGINEERING_FIXTURE_LOG!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  }

  it.each(["", "doctor", "status", "plan", "next", "audit", "run", "verify", "reconcile"])(
    "shows help for engineering %s without adapter configuration",
    async (command) => {
      const sink = createFakeSink();
      const code = await runCli(
        ["node", "gitamesh", "engineering", ...(command ? [command] : []), "--help"],
        { cwd: process.cwd(), env: {}, sink },
      );
      expect(code).toBe(0);
      expect(sink.logs.join("\n")).toContain(`Usage: gitamesh engineering${command ? ` ${command}` : ""}`);
      expect(sink.errors).toEqual([]);
    },
  );

  it("checks protocol then delegates with argv, resolved daemon URL and a child-only token", async () => {
    const sink = createFakeSink();
    const code = await runCli(["node", "gitamesh", "engineering", "status", "--repo", "owner/repo", "--json"], { cwd, env, sink });
    expect(code).toBe(0);
    const calls = (await fs.readFile(env.ENGINEERING_FIXTURE_LOG!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toEqual([
      { argv: ["--protocol"], has_token: false },
      { argv: ["status", "--repo", "owner/repo", "--json", "--trusted-main", fixture, "--repository-id", "repo_fixture", "--coordinator-url", "http://127.0.0.1:4321"], has_token: true },
    ]);
    expect(sink.logs[0]).toContain('"ok" : true');
    expect(JSON.parse(sink.logs[0]!).mutations).toBe(0);
    expect(sink.errors).toEqual([]);
    expect(JSON.stringify(sink)).not.toContain("fixture-secret");
    expect(env.GITAMESH_TOKEN).toBe("fixture-secret");
  });

  it.each([0, 1, 2, 3])("propagates adapter exit %i without adding an error envelope", async (exit) => {
    env.ENGINEERING_FIXTURE_EXIT = String(exit);
    const { code, sink } = await call("status");
    expect(code).toBe(exit);
    expect(sink.logs).toHaveLength(1);
    expect(JSON.parse(sink.logs[0]!).ok).toBe(exit === 0);
    expect(sink.errors).toEqual([]);
  });

  it.each(["gitamesh-engineering/2", "invalid-json", "nonzero"])("refuses protocol %s before command dispatch", async (mode) => {
    if (mode === "nonzero") env.ENGINEERING_FIXTURE_PROBE_EXIT = "1";
    else env.ENGINEERING_FIXTURE_PROTOCOL = mode;
    const { code, sink } = await call("status");
    expect(code).toBe(2);
    expect(JSON.parse(sink.logs[0]!).error.code).toBe("ADAPTER_INCOMPATIBLE");
    expect(await calls()).toEqual([{ argv: ["--protocol"], has_token: false }]);
  });

  it("refuses a missing adapter without starting a child", async () => {
    env.GITAMESH_ENGINEERING_TRUSTED_MAIN = cwd;
    const { code, sink } = await call("doctor");
    expect(code).toBe(2);
    expect(JSON.parse(sink.logs[0]!).error.code).toBe("ADAPTER_MISSING");
    expect(existsSync(env.ENGINEERING_FIXTURE_LOG!)).toBe(false);
  });

  it("refuses an unavailable interpreter without exposing subprocess arguments", async () => {
    env.GITAMESH_ENGINEERING_PYTHON = path.join(cwd, "missing-python");
    const { code, sink } = await call("doctor");
    expect(code).toBe(2);
    expect(JSON.parse(sink.logs[0]!).error.code).toBe("ADAPTER_MISSING");
    expect(JSON.stringify(sink)).not.toContain("fixture-secret");
  });

  it.each([
    ["GITAMESH_ENGINEERING_TRUSTED_MAIN", "TRUSTED_MAIN_MISSING"],
    ["GITAMESH_REPOSITORY_ID", "REPOSITORY_ID_MISSING"],
    ["GITAMESH_ENGINEERING_PYTHON", "PYTHON_MISSING"],
  ])("requires setting %s before dispatch", async (setting, error) => {
    env[setting] = " ";
    const { code, sink } = await call("status");
    expect(code).toBe(2);
    expect(JSON.parse(sink.logs[0]!).error.code).toBe(error);
    expect(existsSync(env.ENGINEERING_FIXTURE_LOG!)).toBe(false);
  });

  it.each(["", " ", "unknown", "owner/repo;touch sentinel", "owner/$(touch sentinel)"])("refuses invalid repo %j without evaluating it", async (repo) => {
    const { code, sink } = await call("status", ["--repo", repo, "--json"]);
    expect(code).toBe(2);
    expect(JSON.parse(sink.logs[0]!).error.code).toBe("UNKNOWN_REPO");
    expect(existsSync(env.ENGINEERING_FIXTURE_LOG!)).toBe(false);
    expect(existsSync(path.join(cwd, "sentinel"))).toBe(false);
  });

  it("requires --repo and verify's task before adapter dispatch", async () => {
    expect((await call("status", ["--json"])).code).not.toBe(0);
    expect((await call("verify")).code).not.toBe(0);
    expect(existsSync(env.ENGINEERING_FIXTURE_LOG!)).toBe(false);
  });

  it("passes task and manifest strings as literal argv entries with their order intact", async () => {
    const marker = path.join(cwd, "sentinel");
    const task = `task; touch ${marker}`;
    const manifest = `$(touch ${marker})`;
    const args = ["--repo=owner/repo", "--harness", manifest, task, "--task-register", "a path; with spaces.json", "--dry-run", "--json"];
    expect((await call("verify", args)).code).toBe(0);
    expect((await calls())[1].argv.slice(0, args.length + 1)).toEqual(["verify", ...args]);
    expect(existsSync(marker)).toBe(false);
  });

  it("passes bounded run flags unchanged and probes on every invocation", async () => {
    const args = ["--repo", "owner/repo", "--max-workers", "02", "--continuous", "--max-ticks", "3", "--deadline", "2027-01-01T00:00:00Z", "--max-duration-seconds", "1.50", "--dry-run", "--json"];
    expect((await call("run", args)).code).toBe(0);
    expect((await call("run", ["--repo", "owner/repo", "--once", "--json"])).code).toBe(0);
    const recorded = await calls();
    expect(recorded.map((entry) => entry.argv[0])).toEqual(["--protocol", "run", "--protocol", "run"]);
    expect(recorded[1].argv.slice(0, args.length + 1)).toEqual(["run", ...args]);
  });

  it("uses flag settings over env and removes only the launcher's --python option", async () => {
    env.GITAMESH_ENGINEERING_TRUSTED_MAIN = "missing";
    env.GITAMESH_ENGINEERING_PYTHON = "missing";
    const args = ["--repo", "owner/repo", "--python=python3", "--trusted-main", fixture, "--repository-id", "repo_flag", "--json"];
    expect((await call("status", args)).code).toBe(0);
    const argv = (await calls())[1].argv;
    expect(argv).toEqual(["status", "--repo", "owner/repo", "--trusted-main", fixture, "--repository-id", "repo_flag", "--json", "--coordinator-url", "http://127.0.0.1:4321"]);
  });

  it("reuses daemon URL and token configuration without putting credentials on argv", async () => {
    delete env.GITAMESH_TOKEN;
    delete env.GITAMESH_DAEMON_URL;
    await fs.mkdir(path.join(cwd, ".gitamesh"));
    await fs.writeFile(path.join(cwd, ".gitamesh/config.yaml"), "daemonUrl: http://configured:4477\ntoken: config-secret\n");
    expect((await call("status")).code).toBe(0);
    const recorded = await calls();
    expect(recorded[0].has_token).toBe(false);
    expect(recorded[1].has_token).toBe(true);
    expect(recorded[1].argv.slice(-2)).toEqual(["--coordinator-url", "http://configured:4477"]);
    expect(JSON.stringify(recorded)).not.toContain("config-secret");
    expect(env.GITAMESH_TOKEN).toBeUndefined();
  });

  it("renders only envelope facts in human output", async () => {
    env.ENGINEERING_FIXTURE_EXIT = "1";
    const { code, sink } = await call("audit", ["--repo", "owner/repo"]);
    expect(code).toBe(1);
    expect(sink.logs[0]).toBe("ok: false");
    expect(sink.logs).toContain("blocker: fixture blocker");
    expect(sink.errors).toEqual([]);
  });

  it("leaves existing commands available", async () => {
    const sink = createFakeSink();
    const { fetchImpl } = createFakeFetch({ "GET /v1/agents": { body: { agents: [] } } });
    expect(await runCli(["node", "gitamesh", "agent", "list", "--json"], {
      cwd, env, sink, fetchImpl,
    })).toBe(0);
    expect(JSON.parse(sink.logs[0]!)).toEqual([]);
    expect(existsSync(env.ENGINEERING_FIXTURE_LOG!)).toBe(false);
  });

  const realCheckout = "/Volumes/GDriveODEA/worktrees/juricratic/feat-engineering-harness-outcome-gate";
  const realExists = existsSync(path.join(realCheckout, "scripts/engineering_adapter.py"));
  it.skipIf(!realExists)(realExists ? "calls the real Juricratic adapter and refuses an unknown repository" : "real adapter check skipped: Juricratic checkout is absent", async () => {
    env.GITAMESH_ENGINEERING_TRUSTED_MAIN = realCheckout;
    const { code, sink } = await call("doctor", ["--repo", "unknown-owner/unknown-repo", "--json"]);
    expect(code).toBe(2);
    const envelope = JSON.parse(sink.logs[0]!);
    expect(envelope.protocol).toBe("gitamesh-engineering/1");
    expect(envelope.adapter).toBe("juricratic");
    expect(envelope.error.code).toBe("UNKNOWN_REPO");
    expect(envelope.mutations).toBe(0);
  });
});
