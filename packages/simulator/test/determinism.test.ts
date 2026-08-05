import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const TSX_BIN = join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");
const BIN_ENTRY = join(PACKAGE_ROOT, "src", "bin", "gitamesh-simulate.ts");

/**
 * The strongest form of the determinism claim: two ENTIRELY SEPARATE
 * process invocations of the actual `gitamesh-simulate` CLI entrypoint
 * (not two in-process function calls — see the report.ts comment on why
 * that distinction matters: `@gitamesh/storage-sqlite`'s `generateId`
 * uses a module-level counter that only resets on a fresh process) with
 * the same `--seed` must produce byte-for-byte identical
 * `simulation-report.json` files.
 */
function runCliToFile(seed: number, outPath: string): void {
  execFileSync(TSX_BIN, [BIN_ENTRY, "--seed", String(seed), "--out", outPath], {
    cwd: PACKAGE_ROOT,
    stdio: "pipe",
  });
}

describe("end-to-end CLI determinism", () => {
  it("two separate process invocations with the same seed produce byte-identical simulation-report.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "gitamesh-sim-determinism-"));
    const outA = join(dir, "report-a.json");
    const outB = join(dir, "report-b.json");
    try {
      runCliToFile(1234, outA);
      runCliToFile(1234, outB);

      const contentA = readFileSync(outA, "utf8");
      const contentB = readFileSync(outB, "utf8");

      expect(contentA.length).toBeGreaterThan(0);
      expect(contentB).toBe(contentA);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("a different seed produces a different report", () => {
    const dir = mkdtempSync(join(tmpdir(), "gitamesh-sim-determinism-"));
    const outA = join(dir, "report-a.json");
    const outC = join(dir, "report-c.json");
    try {
      runCliToFile(1234, outA);
      runCliToFile(5678, outC);

      const contentA = readFileSync(outA, "utf8");
      const contentC = readFileSync(outC, "utf8");

      // Seeds differ -> at minimum the "seed" field differs, so the
      // files cannot be byte-identical even if every scenario's pass/
      // fail outcome happens to be seed-invariant.
      expect(contentC).not.toBe(contentA);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
