import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { CliDeps } from "./context.js";
import { CliError } from "./output.js";

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Resolves a `--body` value: literal text, `@file` (path relative to the
 * working directory), or `-` for stdin. Long or multi-line text is awkward
 * to quote in a shell, so agents should prefer `@file` or `-`.
 */
export async function resolveBody(raw: string, deps: CliDeps): Promise<string> {
  let text: string;
  if (raw === "-") {
    text = await (deps.readStdin ?? readProcessStdin)();
  } else if (raw.startsWith("@")) {
    const file = path.resolve(deps.cwd, raw.slice(1));
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      throw new CliError(`--body: cannot read file ${file}`);
    }
  } else {
    text = raw;
  }
  // One trailing newline is an artifact of files/heredocs, not content.
  text = text.replace(/\r?\n$/, "");
  if (text.trim() === "") {
    throw new CliError("--body is empty");
  }
  return text;
}
