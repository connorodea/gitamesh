import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Run in a child so an addon abort is a test failure, not a crashed test runner.
// Allocation-driven GC matters: explicit global.gc() does not reproduce the
// node::ObjectWrap cleanup failure reported in nodejs/node#65446.
it("survives native statement collection and reopens its durable database", () => {
  const directory = mkdtempSync(join(tmpdir(), "gitamesh-native-cleanup-"));
  try {
    const result = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", `
      import Database from "better-sqlite3";
      const path = process.argv[1];
      let db = new Database(path);
      db.exec("CREATE TABLE evidence (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      db.prepare("INSERT INTO evidence VALUES (?, ?)").run(1, "retained");
      let junk = [];
      for (let i = 0; i < 100000; i++) {
        const row = db.prepare("SELECT value FROM evidence WHERE id = ?").get(1);
        if (row.value !== "retained") throw new Error("Lost evidence during statement collection");
        junk.push({ i, row });
        if (junk.length > 1000) junk = [];
      }
      db.close();
      db = new Database(path);
      const retained = db.prepare("SELECT value FROM evidence WHERE id = ?").get(1);
      db.close();
      console.log(JSON.stringify(retained));
    `, join(directory, "evidence.sqlite")], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      timeout: 20000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ value: "retained" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 25000);
