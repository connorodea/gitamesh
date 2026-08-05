import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DAEMON_URL,
  configFilePath,
  loadConfig,
  maskToken,
  parseFlatYaml,
  resolveSettings,
  writeConfig,
} from "../src/config.js";

describe("parseFlatYaml", () => {
  it("parses simple key: value lines, ignoring comments and blanks", () => {
    const parsed = parseFlatYaml(
      ["# a comment", "", "daemonUrl: http://127.0.0.1:4477", "token: gm_abc123"].join("\n"),
    );
    expect(parsed).toEqual({ daemonUrl: "http://127.0.0.1:4477", token: "gm_abc123" });
  });

  it("strips matching surrounding quotes", () => {
    const parsed = parseFlatYaml('daemonUrl: "http://127.0.0.1:4477"');
    expect(parsed.daemonUrl).toBe("http://127.0.0.1:4477");
  });
});

describe("writeConfig / loadConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gitamesh-cli-config-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("round-trips daemonUrl through the config file", async () => {
    await writeConfig(dir, { daemonUrl: "http://example.test:9999" });
    const loaded = await loadConfig(dir);
    expect(loaded?.daemonUrl).toBe("http://example.test:9999");
  });

  it("never writes a token field by default", async () => {
    const filePath = await writeConfig(dir, { daemonUrl: DEFAULT_DAEMON_URL });
    const contents = await fs.readFile(filePath, "utf8");
    expect(contents).not.toMatch(/^token:/m);
    expect(contents).toMatch(/GITAMESH_TOKEN/);
  });

  it("returns null when no config file exists", async () => {
    const loaded = await loadConfig(dir);
    expect(loaded).toBeNull();
  });

  it("writes to .gitamesh/config.yaml", async () => {
    const filePath = await writeConfig(dir, { daemonUrl: DEFAULT_DAEMON_URL });
    expect(filePath).toBe(configFilePath(dir));
    expect(filePath).toContain(".gitamesh/config.yaml");
  });
});

describe("resolveSettings", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gitamesh-cli-settings-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("falls back to DEFAULT_DAEMON_URL and no token when nothing is configured", async () => {
    const settings = await resolveSettings(dir, {});
    expect(settings.daemonUrl).toBe(DEFAULT_DAEMON_URL);
    expect(settings.token).toBeNull();
    expect(settings.tokenSource).toBe("none");
  });

  it("prefers GITAMESH_TOKEN env var over a config-file token", async () => {
    await writeConfig(dir, { daemonUrl: DEFAULT_DAEMON_URL, token: "gm_from_config" });
    const settings = await resolveSettings(dir, { GITAMESH_TOKEN: "gm_from_env" });
    expect(settings.token).toBe("gm_from_env");
    expect(settings.tokenSource).toBe("env");
  });

  it("uses GITAMESH_DAEMON_URL over the config file's daemonUrl", async () => {
    await writeConfig(dir, { daemonUrl: "http://config-value:1111" });
    const settings = await resolveSettings(dir, { GITAMESH_DAEMON_URL: "http://env-value:2222" });
    expect(settings.daemonUrl).toBe("http://env-value:2222");
  });
});

describe("maskToken", () => {
  it("shows only the last 4 characters", () => {
    const token = "gm_abcdefghijklmnop"; // 19 chars
    expect(maskToken(token)).toBe(`${"*".repeat(15)}mnop`);
  });

  it("masks entirely when the token is 4 chars or shorter", () => {
    expect(maskToken("abcd")).toBe("****");
    expect(maskToken("ab")).toBe("**");
  });
});
