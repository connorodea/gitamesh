import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
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
});
