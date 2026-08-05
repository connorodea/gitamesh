import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig, parseFlatYaml, DEFAULT_DAEMON_URL } from "../src/config.js";

describe("parseFlatYaml", () => {
  it("parses simple key: value lines, ignoring comments and blanks", () => {
    const parsed = parseFlatYaml(["# a comment", "", "daemonUrl: http://127.0.0.1:8787", "token: 'gm_x'"].join("\n"));
    expect(parsed).toEqual({ daemonUrl: "http://127.0.0.1:8787", token: "gm_x" });
  });
});

describe("resolveConfig", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gitamesh-mcp-server-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("falls back to the default daemon URL with no env and no config file", async () => {
    const dir = await makeTmpDir();
    const resolved = await resolveConfig(dir, {});
    expect(resolved).toEqual({ daemonUrl: DEFAULT_DAEMON_URL, token: null, tokenSource: "none" });
  });

  it("prefers GITAMESH_URL over GITAMESH_DAEMON_URL and the config file", async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, ".gitamesh"), { recursive: true });
    await fs.writeFile(path.join(dir, ".gitamesh", "config.yaml"), "daemonUrl: http://example.invalid:1\n");

    const resolved = await resolveConfig(dir, {
      GITAMESH_URL: "http://from-env:9999",
      GITAMESH_DAEMON_URL: "http://from-cli-env:1111",
    });

    expect(resolved.daemonUrl).toBe("http://from-env:9999");
  });

  it("falls back to GITAMESH_DAEMON_URL (cli-compat), then the config file", async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, ".gitamesh"), { recursive: true });
    await fs.writeFile(path.join(dir, ".gitamesh", "config.yaml"), "daemonUrl: http://from-config:2222\n");

    const cliCompat = await resolveConfig(dir, { GITAMESH_DAEMON_URL: "http://from-cli-env:1111" });
    expect(cliCompat.daemonUrl).toBe("http://from-cli-env:1111");

    const configOnly = await resolveConfig(dir, {});
    expect(configOnly.daemonUrl).toBe("http://from-config:2222");
  });

  it("prefers GITAMESH_TOKEN over a config-file token", async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, ".gitamesh"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".gitamesh", "config.yaml"),
      "daemonUrl: http://127.0.0.1:8787\ntoken: gm_from_config\n",
    );

    const resolved = await resolveConfig(dir, { GITAMESH_TOKEN: "gm_from_env" });
    expect(resolved).toEqual({
      daemonUrl: "http://127.0.0.1:8787",
      token: "gm_from_env",
      tokenSource: "env",
    });

    const configOnly = await resolveConfig(dir, {});
    expect(configOnly).toEqual({
      daemonUrl: "http://127.0.0.1:8787",
      token: "gm_from_config",
      tokenSource: "config",
    });
  });
});
