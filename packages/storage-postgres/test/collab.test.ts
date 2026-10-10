import { createEmbeddedPostgresStorageForTests } from "../src/index.js";
import { runCollabStorageContract } from "../../core/test/support/collab-storage-contract.js";

runCollabStorageContract("PostgresStorageAdapter (pglite)", () =>
  createEmbeddedPostgresStorageForTests(),
);
