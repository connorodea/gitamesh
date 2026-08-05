import { Command } from "commander";

import { configFilePath, configExists, DEFAULT_DAEMON_URL, writeConfig } from "../config.js";
import type { CliDeps } from "../context.js";
import { CliError } from "../output.js";

export function registerInitCommand(program: Command, deps: CliDeps): void {
  program
    .command("init")
    .description("Write .gitamesh/config.yaml in the current directory")
    .option("--daemon-url <url>", "daemon base URL", DEFAULT_DAEMON_URL)
    .option("--force", "overwrite an existing config file", false)
    .action(async (options: { daemonUrl: string; force: boolean }) => {
      const alreadyExists = await configExists(deps.cwd);
      if (alreadyExists && !options.force) {
        throw new CliError(
          `${configFilePath(deps.cwd)} already exists — pass --force to overwrite.`,
        );
      }
      const filePath = await writeConfig(deps.cwd, { daemonUrl: options.daemonUrl });
      deps.sink.log(`Wrote ${filePath}`);
      deps.sink.log(
        `Set GITAMESH_TOKEN in your shell environment to authenticate — it is never written to this file.`,
      );
    });
}
