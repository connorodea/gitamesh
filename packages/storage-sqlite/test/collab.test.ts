import { createInMemorySqliteStorage } from "../src/index.js";
import { runCollabStorageContract } from "../../core/test/support/collab-storage-contract.js";

runCollabStorageContract("SqliteStorageAdapter", () => createInMemorySqliteStorage());
