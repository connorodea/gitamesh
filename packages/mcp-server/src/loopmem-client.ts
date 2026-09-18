import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const MemoryKindSchema = z.enum(["constraint", "decision", "fact", "failure", "next"]);
const IdSchema = z.number().int().positive().safe();
export const MemorySchema = z.object({
  id: IdSchema,
  kind: MemoryKindSchema,
  text: z.string().min(1),
  evidence: z.array(z.string()),
  supersedes: IdSchema.nullable(),
  provenance: z.object({
    agent_id: z.string().min(1),
    session_id: z.string().min(1),
    recorded_at_unix_ms: z.number().int().nonnegative().safe(),
  }).strict().nullable().optional(),
}).strict();
export type Memory = z.infer<typeof MemorySchema>;

export const MemoryStoreSchema = z.object({
  namespace: z.string(),
  description: z.string(),
  store: z.string(),
  stored_memories: z.number().int().nonnegative().safe(),
  active_memories: z.number().int().nonnegative().safe(),
  max_context_bytes: z.number().int().positive().safe(),
}).strict();

export const RecallSchema = z.object({
  namespace: z.string(),
  memories: z.array(MemorySchema),
  total_matches: z.number().int().nonnegative().safe(),
  has_more: z.boolean(),
}).strict();

export interface ExecutionLimits {
  timeoutMs: number;
  maxOutputBytes: number;
}
export type LoopMemExecutor = (
  executable: string,
  args: string[],
  limits: ExecutionLimits,
) => Promise<string>;

export class LoopMemError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LoopMemError";
  }
}

/** No shell interpolation, and neither error diagnostics nor stored memory is
 * copied from a child process into unexpected error responses. */
export const executeLoopMem: LoopMemExecutor = (executable, args, limits) => new Promise((resolve, reject) => {
  execFile(executable, args, {
    encoding: "utf8",
    timeout: limits.timeoutMs,
    maxBuffer: limits.maxOutputBytes,
    killSignal: "SIGKILL",
    windowsHide: true,
  }, (error, stdout, stderr) => {
    if (error) {
      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        reject(new LoopMemError("output-limit", "LoopMem output exceeded the configured byte limit."));
      } else if (error.killed) {
        reject(new LoopMemError("timeout", "LoopMem exceeded the command timeout."));
      } else if (error.code === "ENOENT") {
        reject(new LoopMemError("not-found", "LoopMem executable was not found. Check GITAMESH_LOOPMEM_BIN."));
      } else if (/^LoopMem error: memory \d+ is already superseded\s*$/m.test(stderr)) {
        reject(new LoopMemError("memory-conflict", "Recall latest memory before replacing an entry."));
      } else {
        reject(new LoopMemError("command-failed", "LoopMem command failed. Check the store and command with the local CLI."));
      }
      return;
    }
    resolve(stdout);
  });
});

/** Repository IDs, not cwd, choose memory namespaces across agent worktrees. */
export function memoryNamespace(repositoryId: string): string {
  return `repo-${createHash("sha256").update(repositoryId, "utf8").digest("hex")}`;
}

export interface RememberInput {
  kind: z.infer<typeof MemoryKindSchema>;
  text: string;
  agentId: string;
  workspaceSessionId: string;
  evidence?: string[];
  supersedes?: number;
  taskId?: string;
  attemptId?: string;
}

export interface RecallInput {
  query?: string;
  kind?: z.infer<typeof MemoryKindSchema>;
  agentId?: string;
  workspaceSessionId?: string;
  includeSuperseded?: boolean;
  beforeId?: number;
  limit?: number;
}

export interface LoopMemClientOptions {
  executable: string;
  storeRoot: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  execute?: LoopMemExecutor;
}

export class LoopMemClient {
  private readonly limits: ExecutionLimits;
  private readonly execute: LoopMemExecutor;

  constructor(private readonly options: LoopMemClientOptions) {
    if (!isAbsolute(options.storeRoot) || !options.executable.trim()) {
      throw new LoopMemError("configuration", "LoopMem needs an absolute shared store path and an executable.");
    }
    this.limits = { timeoutMs: options.timeoutMs ?? 10_000, maxOutputBytes: options.maxOutputBytes ?? 1_048_576 };
    this.execute = options.execute ?? executeLoopMem;
  }

  private command(repositoryId: string, args: string[]): Promise<string> {
    return this.execute(this.options.executable, [
      "--store", this.options.storeRoot, "--namespace", memoryNamespace(repositoryId), ...args,
    ], this.limits);
  }

  private async json<T>(repositoryId: string, args: string[], schema: z.ZodType<T>): Promise<T> {
    const raw = await this.command(repositoryId, args);
    try {
      return schema.parse(JSON.parse(raw));
    } catch {
      throw new LoopMemError("invalid-output", "LoopMem returned a response that does not match the shared-memory protocol.");
    }
  }

  async initialize(repositoryId: string, goal?: string): Promise<z.infer<typeof MemoryStoreSchema>> {
    return this.json(repositoryId, ["init", ...(goal === undefined ? [] : [`--goal=${goal}`])],
      MemoryStoreSchema.refine((record) => record.namespace === memoryNamespace(repositoryId)));
  }

  async remember(repositoryId: string, input: RememberInput): Promise<Memory> {
    const evidence = [...(input.evidence ?? [])];
    if (input.taskId !== undefined) evidence.push(`gitamesh:task:${input.taskId}`);
    if (input.attemptId !== undefined) evidence.push(`gitamesh:attempt:${input.attemptId}`);
    const args = ["remember", "--kind", input.kind, `--text=${input.text}`,
      `--agent=${input.agentId}`, `--session=${input.workspaceSessionId}`];
    for (const reference of evidence) args.push(`--evidence=${reference}`);
    if (input.supersedes !== undefined) args.push(`--supersedes=${input.supersedes}`);
    return this.json(repositoryId, args, MemorySchema.refine((memory) =>
      memory.provenance?.agent_id === input.agentId && memory.provenance.session_id === input.workspaceSessionId));
  }

  async recall(repositoryId: string, input: RecallInput = {}): Promise<z.infer<typeof RecallSchema>> {
    const args = ["recall"];
    if (input.query !== undefined) args.push(`--query=${input.query}`);
    if (input.kind !== undefined) args.push("--kind", input.kind);
    if (input.agentId !== undefined) args.push(`--agent=${input.agentId}`);
    if (input.workspaceSessionId !== undefined) args.push(`--session=${input.workspaceSessionId}`);
    if (input.includeSuperseded) args.push("--include-superseded");
    if (input.beforeId !== undefined) args.push(`--before-id=${input.beforeId}`);
    if (input.limit !== undefined) args.push(`--limit=${input.limit}`);
    return this.json(repositoryId, args,
      RecallSchema.refine((record) => record.namespace === memoryNamespace(repositoryId)));
  }

  async get(repositoryId: string, id: number): Promise<Memory> {
    return this.json(repositoryId, ["get", String(id)], MemorySchema.refine((memory) => memory.id === id));
  }

  async context(repositoryId: string): Promise<string> {
    const output = await this.command(repositoryId, ["context"]);
    if (!output.trim()) throw new LoopMemError("invalid-output", "LoopMem returned empty context.");
    return output;
  }
}
