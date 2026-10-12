import type { FetchLike } from "./client.js";
import { GitameshClient } from "./client.js";
import { resolveSettings } from "./config.js";
import type { OutputSink } from "./output.js";

export interface CliDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  sink: OutputSink;
  fetchImpl?: FetchLike;
  /** Reads all of stdin (for `--body -`). Defaults to the process's stdin. */
  readStdin?: () => Promise<string>;
}

export interface ResolvedClient {
  client: GitameshClient;
  daemonUrl: string;
  hasToken: boolean;
}

export async function createClient(deps: CliDeps): Promise<ResolvedClient> {
  const settings = await resolveSettings(deps.cwd, deps.env);
  const client = new GitameshClient({
    baseUrl: settings.daemonUrl,
    token: settings.token,
    fetchImpl: deps.fetchImpl,
  });
  return { client, daemonUrl: settings.daemonUrl, hasToken: settings.token !== null };
}
