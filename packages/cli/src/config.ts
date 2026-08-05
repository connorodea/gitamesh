import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Default daemon base URL, used when no `.gitamesh/config.yaml` exists yet
 * and `GITAMESH_DAEMON_URL` is unset.
 *
 * COORDINATION NOTE: `apps/daemon` does not have a committed HTTP entry
 * point (`src/index.ts`) yet as of this package's initial implementation —
 * only route modules and auth/storage plumbing exist. `4477` is a
 * documented placeholder port chosen by this CLI, NOT confirmed against a
 * running daemon. Whoever finishes wiring up the daemon's HTTP server must
 * either bind it to `4477` by default or this default must be updated to
 * match. `gitamesh doctor` / `gitamesh status` will clearly report
 * "daemon unreachable" until the ports agree.
 */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:4477";

export const CONFIG_DIR_NAME = ".gitamesh";
export const CONFIG_FILE_NAME = "config.yaml";
export const TOKEN_ENV_VAR = "GITAMESH_TOKEN";
export const DAEMON_URL_ENV_VAR = "GITAMESH_DAEMON_URL";

export interface GitameshConfig {
  daemonUrl: string;
  /**
   * Intentionally almost never populated. `gitamesh init` never writes a
   * token field into the config file (config files get committed; tokens
   * must not). This field exists only so a user who deliberately opts in
   * by hand-editing the file is still respected — `resolveToken` always
   * prefers `GITAMESH_TOKEN` from the environment first.
   */
  token?: string;
}

export function configDirPath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME);
}

export function configFilePath(cwd: string): string {
  return path.join(configDirPath(cwd), CONFIG_FILE_NAME);
}

/**
 * Minimal hand-rolled parser for the CLI's own flat `key: value`
 * configuration format. Deliberately not a general YAML parser (this repo
 * carries no YAML dependency anywhere else): the config file only ever has
 * a couple of top-level string keys and comment lines starting with `#`.
 * If richer config needs ever arise, swap this for a real YAML library —
 * the file's syntax is a valid subset of YAML either way, so nothing that
 * reads it today would need to change.
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

export function serializeConfig(config: GitameshConfig): string {
  const lines = [
    "# Gitamesh CLI configuration.",
    "#",
    "# Do NOT put a token here — this file is meant to be committed.",
    `# Set ${TOKEN_ENV_VAR} in your shell environment instead:`,
    `#   export ${TOKEN_ENV_VAR}=gm_...`,
    "",
    `daemonUrl: ${config.daemonUrl}`,
  ];
  return `${lines.join("\n")}\n`;
}

export async function configExists(cwd: string): Promise<boolean> {
  try {
    await fs.access(configFilePath(cwd));
    return true;
  } catch {
    return false;
  }
}

export async function writeConfig(cwd: string, config: GitameshConfig): Promise<string> {
  const dir = configDirPath(cwd);
  await fs.mkdir(dir, { recursive: true });
  const filePath = configFilePath(cwd);
  await fs.writeFile(filePath, serializeConfig(config), "utf8");
  return filePath;
}

/**
 * Loads `.gitamesh/config.yaml` if present. Returns `null` (not a throw)
 * when the file does not exist — callers decide whether that is fatal
 * (`doctor` reports it as a failed check; most daemon-talking commands
 * fall back to `GITAMESH_DAEMON_URL` / `DEFAULT_DAEMON_URL`).
 */
export async function loadConfig(cwd: string): Promise<GitameshConfig | null> {
  const filePath = configFilePath(cwd);
  let contents: string;
  try {
    contents = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const parsed = parseFlatYaml(contents);
  const daemonUrl = parsed.daemonUrl ?? DEFAULT_DAEMON_URL;
  const config: GitameshConfig = { daemonUrl };
  if (parsed.token) {
    config.token = parsed.token;
  }
  return config;
}

export interface ResolvedSettings {
  daemonUrl: string;
  token: string | null;
  /** Where the token came from, for `doctor`/`status` diagnostics. */
  tokenSource: "env" | "config" | "none";
}

/**
 * Resolves the effective daemon URL + token for a command run from `cwd`.
 *
 * Precedence: `GITAMESH_DAEMON_URL` env var > config file's `daemonUrl` >
 * `DEFAULT_DAEMON_URL`. For the token: `GITAMESH_TOKEN` env var always
 * wins over a (deliberately unusual) `token:` line hand-added to the
 * config file.
 */
export async function resolveSettings(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedSettings> {
  const config = await loadConfig(cwd);

  const daemonUrl = env[DAEMON_URL_ENV_VAR] ?? config?.daemonUrl ?? DEFAULT_DAEMON_URL;

  const envToken = env[TOKEN_ENV_VAR];
  if (envToken && envToken.length > 0) {
    return { daemonUrl, token: envToken, tokenSource: "env" };
  }
  if (config?.token && config.token.length > 0) {
    return { daemonUrl, token: config.token, tokenSource: "config" };
  }
  return { daemonUrl, token: null, tokenSource: "none" };
}

/** Masks a token for display: shows only its last 4 characters. */
export function maskToken(token: string): string {
  if (token.length <= 4) {
    return "*".repeat(token.length);
  }
  return `${"*".repeat(token.length - 4)}${token.slice(-4)}`;
}
