import { createEmbeddedPostgresStorageForTests } from "../src/index.js";
import { runRepositoryStorageContract } from "../../core/test/support/repository-storage-contract.js";

runRepositoryStorageContract("PostgresStorageAdapter (pglite)", () =>
  createEmbeddedPostgresStorageForTests(),
);
