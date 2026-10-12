import { Command } from "commander";

import { createClient } from "../context.js";
import type { CliDeps } from "../context.js";
import { CliError, printJson, printTable } from "../output.js";

interface ClaimRecord {
  resource_claim_id: string;
  resource_type: string;
  resource_key: string;
  mode: string;
  task_id: string;
  expires_at: string;
}

export interface PathLockRecord {
  lock_id: string;
  repository_id: string;
  agent_id: string;
  holder_display_name: string;
  task_id: string | null;
  paths: string[];
  heartbeat_at: string;
  expires_at: string;
}

/** Path-lock ids are minted with this prefix; anything else is a resource claim id. */
const PATH_LOCK_PREFIX = "lock_";

export function pathLockRows(locks: PathLockRecord[]): Array<Record<string, unknown>> {
  return locks.map((lock) => ({
    lock_id: lock.lock_id,
    holder: `${lock.holder_display_name} (${lock.agent_id})`,
    paths: lock.paths.join(", "),
    task_id: lock.task_id,
    expires_at: lock.expires_at,
  }));
}

export function registerLockCommands(program: Command, deps: CliDeps): void {
  const lock = program
    .command("lock")
    .description("Path locks between agents, and the resource claims task attempts hold");

  lock
    .command("acquire")
    .description("Lock path globs so no other agent edits them")
    .requiredOption("--agent-id <id>", "agent taking the lock")
    .requiredOption("--repository-id <id>", "repository id")
    .requiredOption(
      "--path <glob>",
      "repository-relative path or glob; a plain path covers everything under it (repeatable)",
      collect,
      [] as string[],
    )
    .option("--task-id <id>", "task this lock is for")
    .option("--ttl <seconds>", "seconds until the lock expires unless heartbeated (default 900)")
    .option("--json", "machine-readable output", false)
    .action(
      async (options: {
        agentId: string;
        repositoryId: string;
        path: string[];
        taskId?: string;
        ttl?: string;
        json: boolean;
      }) => {
        const { client } = await createClient(deps);
        const result = (await client.acquireLock({
          agent_id: options.agentId,
          repository_id: options.repositoryId,
          paths: options.path,
          task_id: options.taskId ?? null,
          ttl_seconds: options.ttl === undefined ? undefined : parseTtl(options.ttl),
        })) as { lock?: PathLockRecord };
        if (options.json) {
          printJson(deps.sink, result);
        } else {
          deps.sink.log(
            `Lock ${result.lock?.lock_id ?? "unknown"} acquired on ${result.lock?.paths.join(", ")}; expires ${result.lock?.expires_at}.`,
          );
        }
      },
    );

  lock
    .command("list")
    .description("List active path locks with their holder (--claims: task resource claims)")
    .option("--repository-id <id>", "filter by repository id")
    .option("--agent-id <id>", "only locks this agent holds")
    .option("--claims", "list the resource claims held by task attempts instead", false)
    .option("--json", "machine-readable output", false)
    .action(
      async (options: { repositoryId?: string; agentId?: string; claims: boolean; json: boolean }) => {
        const { client } = await createClient(deps);
        if (options.claims) {
          const result = (await client.listClaims({ repositoryId: options.repositoryId })) as {
            claims?: ClaimRecord[];
          };
          const claims = result.claims ?? [];
          if (options.json) {
            printJson(deps.sink, claims);
          } else {
            printTable(
              deps.sink,
              ["resource_claim_id", "resource_type", "resource_key", "mode", "task_id", "expires_at"],
              claims,
            );
          }
          return;
        }
        const result = (await client.listLocks({
          repositoryId: options.repositoryId,
          agentId: options.agentId,
        })) as { locks?: PathLockRecord[] };
        const locks = result.locks ?? [];
        if (options.json) {
          printJson(deps.sink, locks);
        } else {
          printTable(deps.sink, ["lock_id", "holder", "paths", "task_id", "expires_at"], pathLockRows(locks));
        }
      },
    );

  lock
    .command("heartbeat <lockId>")
    .description("Keep a path lock alive past its TTL")
    .requiredOption("--agent-id <id>", "agent holding the lock")
    .option("--ttl <seconds>", "new TTL in seconds (default: same as before)")
    .option("--json", "machine-readable output", false)
    .action(async (lockId: string, options: { agentId: string; ttl?: string; json: boolean }) => {
      const { client } = await createClient(deps);
      const result = (await client.heartbeatLock(lockId, {
        agent_id: options.agentId,
        ttl_seconds: options.ttl === undefined ? undefined : parseTtl(options.ttl),
      })) as { lock?: PathLockRecord };
      if (options.json) {
        printJson(deps.sink, result);
      } else {
        deps.sink.log(`Lock ${lockId} renewed; expires ${result.lock?.expires_at}.`);
      }
    });

  lock
    .command("release <id>")
    .description("Release a path lock (lock_…, needs --agent-id) or a resource claim (admin)")
    .option("--agent-id <id>", "agent holding the path lock")
    .option("--json", "machine-readable output", false)
    .action(async (id: string, options: { agentId?: string; json: boolean }) => {
      const isPathLock = id.startsWith(PATH_LOCK_PREFIX);
      if (isPathLock && !options.agentId) {
        throw new CliError(`releasing path lock ${id} needs --agent-id <id> (the holder)`);
      }
      const { client } = await createClient(deps);
      const result = isPathLock
        ? await client.releaseLock(id, { agent_id: options.agentId! })
        : await client.releaseClaim(id);
      if (options.json) {
        printJson(deps.sink, result);
      } else {
        deps.sink.log(isPathLock ? `Lock ${id} released.` : `Claim ${id} released.`);
      }
    });
}

function parseTtl(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliError(`--ttl must be a positive whole number of seconds, got "${raw}"`);
  }
  return value;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
