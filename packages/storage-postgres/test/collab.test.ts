import { beforeAll } from "vitest";
import { createEmbeddedPostgresStorageForTests } from "../src/index.js";
import { runCollabStorageContract } from "../../core/test/support/collab-storage-contract.js";
import { runRepositoryStorageContract } from "../../core/test/support/repository-storage-contract.js";

// Boot the embedded Postgres before any test so its cold start is not
// charged to the first test's timeout.
beforeAll(() => {
  createEmbeddedPostgresStorageForTests().close();
}, 60_000);

runCollabStorageContract("PostgresStorageAdapter (pglite)", () =>
  createEmbeddedPostgresStorageForTests(),
);
// Run from this file, not its own: each extra pglite test file boots
// another embedded Postgres in parallel, and that cold start pushed the
// first test of every file past the 5 s timeout on CI.
runRepositoryStorageContract("PostgresStorageAdapter (pglite)", () =>
  createEmbeddedPostgresStorageForTests(),
);
