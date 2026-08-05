import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Builds a small, real, throwaway git repository under a fresh
 * `fs.mkdtemp` directory, with a deterministic committer identity (so
 * these tests never depend on the machine's global git config).
 */
export async function createTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gitamesh-git-adapter-"));
  git(dir, ["init", "--initial-branch=main"]);
  configureIdentity(dir);
  return dir;
}

export function configureIdentity(repoDir: string): void {
  git(repoDir, ["config", "user.email", "test@gitamesh.dev"]);
  git(repoDir, ["config", "user.name", "Gitamesh Test"]);
  git(repoDir, ["config", "commit.gpgsign", "false"]);
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export async function writeFile(
  repoDir: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const fullPath = path.join(repoDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, contents, "utf8");
}

export function commitAll(repoDir: string, message: string): string {
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", message]);
  return git(repoDir, ["rev-parse", "HEAD"]).trim();
}

export async function removeTempRepo(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
