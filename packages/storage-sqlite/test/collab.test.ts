import { createInMemorySqliteStorage } from "../src/index.js";
import { runCollabStorageContract } from "../../core/test/support/collab-storage-contract.js";
import { runRepositoryStorageContract } from "../../core/test/support/repository-storage-contract.js";

runCollabStorageContract("SqliteStorageAdapter", () => createInMemorySqliteStorage());
runRepositoryStorageContract("SqliteStorageAdapter", () => createInMemorySqliteStorage());
