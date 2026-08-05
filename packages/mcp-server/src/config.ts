import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Configuration resolution for the MCP server process.
 *
 * `packages/cli` already has a `.gitamesh/config.yaml` file format and a
 * `resolveSettings()` loader (`packages/cli/src/config.ts`). This package
 * deliberately does NOT take a `workspace:*` dependency on `@gitamesh/cli`
 * to reuse it: `@gitamesh/cli` is an application package (its `index.ts`
 * barrel re-exports `cli.ts`, which imports `commander` and wires up every
 * CLI subcommand) rather than a focused library, and pulling in an
 * unrelated command-parsing surface just to reuse ~20 lines of flat-YAML
 * parsing would be the wrong coupling for a small MCP adapter. Instead this
 * file re-implements the same minimal parser and the same file
 * location/format (`.gitamesh/config.yaml`, `daemonUrl:` key) so a repo that
 * already has one from `gitamesh init` "just works" for the MCP server too,
 * without creating a cross-package dependency. If `@gitamesh/cli` ever
 * grows a slimmer `@gitamesh/cli-config`-style extraction, switch this file
 * to depend on that instead of duplicating.
 */

export const CONFIG_DIR_NAME = ".gitamesh";
export const CONFIG_FILE_NAME = "config.yaml";

/**
 * This package's own documented env vars, per its tool spec.
 * `GITAMESH_DAEMON_URL` / `GITAMESH_TOKEN` (the CLI's names) are also
 * accepted as a compatibility fallback, since the two adapters commonly
 * run in the same environment.
 */
export const DAEMON_URL_ENV_VAR = "GITAMESH_URL";
export const DAEMON_URL_ENV_VAR_CLI_COMPAT = "GITAMESH_DAEMON_URL";
export const TOKEN_ENV_VAR = "GITAMESH_TOKEN";

/**
 * Default daemon base URL. `apps/daemon` binds to `127.0.0.1:8787` by
 * default (`GITAMESH_PORT`, see `apps/daemon/README.md`) — this matches
 * that. NOTE: `packages/cli/src/config.ts`'s `DEFAULT_DAEMON_URL` is
 * currently `http://127.0.0.1:4477`, documented in its own source as a
 * placeholder chosen before the daemon had a committed HTTP entry point.
 * That mismatch predates this package and fixing it is out of scope here
 * (it lives entirely in `packages/cli`); this package matches the daemon's
 * actual default instead of copying the stale one.
 */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:8787";

export interface GitameshMcpConfig {
  daemonUrl: string;
  token: string | null;
  tokenSource: "env" | "config" | "none";
}

function configFilePath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/**
 * Minimal duplicate of `packages/cli/src/config.ts`'s `parseFlatYaml` —
 * see that file's own doc comment for why this repo hand-rolls this
 * instead of carrying a YAML dependency. Kept byte-for-byte equivalent in
 * behavior (not import) so both packages read the same config file
 * identically.
 */
export function parseFlatYaml(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) {
      result[key] = value;
    }
  }
  return result;
}

async function loadConfigFile(cwd: string): Promise<Record<string, string> | null> {
  try {
    const contents = await fs.readFile(configFilePath(cwd), "utf8");
    return parseFlatYaml(contents);
  } catch {
    return null;
  }
}

/**
 * Resolves the effective daemon URL + token for this MCP server process.
 *
 * Precedence for the URL: `GITAMESH_URL` > `GITAMESH_DAEMON_URL`
 * (cli-compat) > `.gitamesh/config.yaml`'s `daemonUrl` > `DEFAULT_DAEMON_URL`.
 * Precedence for the token: `GITAMESH_TOKEN` env var > a `token:` line
 * hand-added to the config file (same deliberately-unusual escape hatch
 * `packages/cli` supports — config files get committed, tokens must not).
 */
export async function resolveConfig(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitameshMcpConfig> {
  const fileConfig = await loadConfigFile(cwd);

  const daemonUrl =
    env[DAEMON_URL_ENV_VAR] ??
    env[DAEMON_URL_ENV_VAR_CLI_COMPAT] ??
    fileConfig?.daemonUrl ??
    DEFAULT_DAEMON_URL;

  const envToken = env[TOKEN_ENV_VAR];
  if (envToken && envToken.length > 0) {
    return { daemonUrl, token: envToken, tokenSource: "env" };
  }
  if (fileConfig?.token && fileConfig.token.length > 0) {
    return { daemonUrl, token: fileConfig.token, tokenSource: "config" };
  }
  return { daemonUrl, token: null, tokenSource: "none" };
}
