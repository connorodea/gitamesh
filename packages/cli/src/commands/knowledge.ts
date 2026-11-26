import { LocalKnowledgeWorkspace } from "@gitamesh/knowledge";
import { Command, InvalidArgumentError } from "commander";
import { isAbsolute } from "node:path";

import type { CliDeps } from "../context.js";
import { CliError, printJson } from "../output.js";

function workspaceFromEnvironment(deps: CliDeps): LocalKnowledgeWorkspace {
  const root = deps.env.GITAMESH_KNOWLEDGE_ROOT;
  const repositoryId = deps.env.GITAMESH_KNOWLEDGE_REPOSITORY_ID;
  if (!root?.trim() || !repositoryId?.trim()) {
    throw new CliError(
      "Set GITAMESH_KNOWLEDGE_ROOT and GITAMESH_KNOWLEDGE_REPOSITORY_ID to read local knowledge.",
    );
  }
  if (!isAbsolute(root)) {
    throw new CliError("GITAMESH_KNOWLEDGE_ROOT must be an absolute path.");
  }
  if (repositoryId !== repositoryId.trim() || Buffer.byteLength(repositoryId, "utf8") > 256
    || /[\u0000-\u001f\u007f-\u009f]/u.test(repositoryId)) {
    throw new CliError(
      "GITAMESH_KNOWLEDGE_REPOSITORY_ID must be a nonblank ID of at most 256 UTF-8 bytes, without control characters.",
    );
  }
  return new LocalKnowledgeWorkspace({ root, repositoryId });
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError("must be a positive whole number");
  }
  return parsed;
}

function collectPaths(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface ContextOptions {
  query?: string;
  path: string[];
  maxBytes?: number;
  maxNotes?: number;
  json: boolean;
}

export function registerKnowledgeCommands(program: Command, deps: CliDeps): void {
  const knowledge = program
    .command("knowledge")
    .description("Read local Markdown knowledge (no daemon required)");

  knowledge
    .command("read <path>")
    .description("Read a Markdown note relative to the configured knowledge folder")
    .option("--json", "machine-readable content and source hash", false)
    .action(async (relativePath: string, options: { json: boolean }) => {
      const note = await workspaceFromEnvironment(deps).read(relativePath);
      if (options.json) {
        printJson(deps.sink, note);
        return;
      }
      deps.sink.log(`# ${note.path}\nsha256: ${note.sha256}\n\n${note.content}`);
    });

  knowledge
    .command("context")
    .description("Build bounded context from local Markdown notes")
    .option("--query <text>", "text query for relevant notes")
    .option("--path <relative-path>", "include a specific note (repeatable)", collectPaths, [])
    .option("--max-bytes <bytes>", "Markdown packet budget, 512–65536 bytes (default 16384)", positiveInteger)
    .option("--max-notes <count>", "maximum included notes, 1–50 (default 10)", positiveInteger)
    .option("--json", "machine-readable packet, sources, and truncation metadata", false)
    .action(async (options: ContextOptions) => {
      const result = await workspaceFromEnvironment(deps).context({
        ...(options.query !== undefined ? { query: options.query } : {}),
        ...(options.path.length > 0 ? { paths: options.path } : {}),
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
        ...(options.maxNotes !== undefined ? { maxNotes: options.maxNotes } : {}),
      });
      if (options.json) {
        printJson(deps.sink, result);
        return;
      }
      deps.sink.log(result.markdown);
      if (result.truncated) {
        deps.sink.error(
          "warning: Knowledge context was truncated. Use --json to inspect omittedCount and scannedCount.",
        );
      }
    });
}
