import { getOrCreateRepositoryId, getRepositoryIdentity, listWorktrees } from "@gitamesh/git-adapter";
import { Command } from "commander";

import { createClient } from "../context.js";
import type { CliDeps } from "../context.js";
import { CliError, printJson, printTable } from "../output.js";

export function registerRepoCommands(program: Command, deps: CliDeps): void {
  const repo = program.command("repo").description("Repository registration and status");

  repo
    .command("register")
    .description("Register this repository with the daemon")
    .option("--display-name <name>", "human-readable name (defaults to the directory name)")
    .option("--namespace-id <id>", "namespace id", "default")
    .option("--json", "machine-readable output", false)
    .action(async (options: { displayName?: string; namespaceId: string; json: boolean }) => {
      const identity = await getRepositoryIdentity(deps.cwd);
      const repositoryId = await getOrCreateRepositoryId(identity.gitCommonDir);
      const displayName = options.displayName ?? deps.cwd.split("/").filter(Boolean).pop() ?? "repository";

      const { client } = await createClient(deps);
      let result: unknown;
      try {
        result = await client.registerRepository({
          namespace_id: options.namespaceId,
          display_name: displayName,
          git_common_dir: identity.gitCommonDir,
          default_branch: identity.defaultBranch,
          metadata: { local_repository_id: repositoryId },
        });
      } catch (error) {
        throw new CliError(
          `repo register failed: ${(error as Error).message}. Note: POST /v1/repositories may not exist yet on this daemon build — see this package's README.`,
        );
      }

      if (options.json) {
        printJson(deps.sink, result);
      } else {
        deps.sink.log(`Registered repository (local id ${repositoryId}, default branch ${identity.defaultBranch}).`);
      }
    });

  repo
    .command("status")
    .description("Show worktrees for the current repository (no daemon required)")
    .option("--json", "machine-readable output", false)
    .action(async (options: { json: boolean }) => {
      const identity = await getRepositoryIdentity(deps.cwd);
      const repositoryId = await getOrCreateRepositoryId(identity.gitCommonDir);
      const worktrees = await listWorktrees(deps.cwd);

      if (options.json) {
        printJson(deps.sink, { repository_id: repositoryId, default_branch: identity.defaultBranch, worktrees });
        return;
      }

      deps.sink.log(`repository_id: ${repositoryId}`);
      deps.sink.log(`default_branch: ${identity.defaultBranch}`);
      deps.sink.log("");
      printTable(
        deps.sink,
        ["branch", "detached", "dirty", "head_sha", "canonical_path"],
        worktrees.map((w) => ({
          branch: w.branch,
          detached: w.detached,
          dirty: w.dirty,
          head_sha: w.head_sha.slice(0, 12),
          canonical_path: w.canonical_path,
        })),
      );
    });
}
