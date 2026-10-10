import { Command } from "commander";

import { createClient } from "../context.js";
import type { CliDeps } from "../context.js";
import { printJson, printTable } from "../output.js";

interface ClaimRecord {
  resource_claim_id: string;
  resource_type: string;
  resource_key: string;
  mode: string;
  task_id: string;
  expires_at: string;
}

export function registerLockCommands(program: Command, deps: CliDeps): void {
  const lock = program.command("lock").description("Inspect and release active resource claims/locks");

  lock
    .command("list")
    .description("List active resource claims")
    .option("--repository-id <id>", "filter by repository id")
    .option("--json", "machine-readable output", false)
    .action(async (options: { repositoryId?: string; json: boolean }) => {
      const { client } = await createClient(deps);
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
    });

  lock
    .command("release <claimId>")
    .description("Release a resource claim")
    .option("--json", "machine-readable output", false)
    .action(async (claimId: string, options: { json: boolean }) => {
      const { client } = await createClient(deps);
      const result = await client.releaseClaim(claimId);
      if (options.json) {
        printJson(deps.sink, result);
      } else {
        deps.sink.log(`Claim ${claimId} released.`);
      }
    });
}
