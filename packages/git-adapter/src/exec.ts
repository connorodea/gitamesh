import { execFile } from "node:child_process";

/**
 * Runs `git` with an argument ARRAY (never a shell-interpolated string).
 * This is a hard security requirement: branch names, paths, and SHAs that
 * flow through this adapter may originate from untrusted agent output, and
 * `execFile` (unlike `exec`) never invokes a shell, so there is no
 * injection surface via `;`, `$( )`, backticks, etc.
 */
export interface GitResult {
  stdout: string;
  stderr: string;
  /** Process exit code. 0 on the conventional "success" path. */
  code: number;
}

export class GitCommandError extends Error {
  readonly args: string[];
  readonly cwd: string;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(params: {
    args: string[];
    cwd: string;
    code: number;
    stdout: string;
    stderr: string;
  }) {
    super(
      `git ${params.args.join(" ")} (cwd=${params.cwd}) exited with code ${params.code}: ${params.stderr.trim()}`,
    );
    this.name = "GitCommandError";
    this.args = params.args;
    this.cwd = params.cwd;
    this.code = params.code;
    this.stdout = params.stdout;
    this.stderr = params.stderr;
  }
}

/**
 * Runs a git command and rejects (with `GitCommandError`) on any nonzero
 * exit code. Use for commands where nonzero always means failure.
 */
export function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : 0;
        if (error) {
          reject(
            new GitCommandError({
              args,
              cwd,
              code,
              stdout: stdout.toString(),
              stderr: stderr.toString(),
            }),
          );
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code: 0 });
      },
    );
  });
}

/**
 * Runs a git command and resolves with the result REGARDLESS of exit code
 * (still rejects on things like "git binary not found"). Use for commands
 * where a nonzero exit code is meaningful data, not a failure — e.g.
 * `merge-tree` (1 = conflicts), `merge-base --is-ancestor` (1 = not an
 * ancestor).
 */
export function runGitAllowNonZero(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          // Spawn-level failure (e.g. git not on PATH), not a git exit code.
          reject(error);
          return;
        }
        const code = error && typeof error.code === "number" ? error.code : 0;
        resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code });
      },
    );
  });
}
