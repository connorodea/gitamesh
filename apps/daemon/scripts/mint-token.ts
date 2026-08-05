/**
 * Dev/bootstrap utility: mints a bearer token directly against a
 * gitamesh SQLite database file, without starting the daemon.
 *
 * Usage:
 *   pnpm --filter @gitamesh/daemon mint-token -- --db ./gitamesh.db --scopes admin
 *   pnpm --filter @gitamesh/daemon mint-token -- --db ./gitamesh.db --scopes task:read,events:read
 *
 * This is a development convenience, not a production secret-management
 * tool — it prints the raw token to stdout exactly once. Treat the
 * output like any other credential.
 */
import { createFileSqliteStorage } from "@gitamesh/storage-sqlite";
import { mintToken, SCOPES, type Scope } from "../src/auth.js";

function parseArgs(argv: string[]): { db: string; scopes: Scope[] } {
  let db = "./gitamesh.db";
  let scopes: Scope[] = ["admin"];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--db" && argv[i + 1]) {
      db = argv[i + 1]!;
      i += 1;
    } else if (argv[i] === "--scopes" && argv[i + 1]) {
      const requested = argv[i + 1]!.split(",").map((s) => s.trim());
      for (const s of requested) {
        if (!(SCOPES as readonly string[]).includes(s)) {
          throw new Error(`Unknown scope "${s}". Valid scopes: ${SCOPES.join(", ")}`);
        }
      }
      scopes = requested as Scope[];
      i += 1;
    }
  }
  return { db, scopes };
}

const { db, scopes } = parseArgs(process.argv.slice(2));
const storage = createFileSqliteStorage(db);
const minted = mintToken(storage, scopes);
storage.close();

// eslint-disable-next-line no-console
console.log(
  [
    "",
    `Minted token (scopes: ${scopes.join(", ")}) against ${db}:`,
    `  ${minted.rawToken}`,
    "",
    "Shown once — only the SHA-256 hash is persisted.",
    "",
  ].join("\n"),
);
