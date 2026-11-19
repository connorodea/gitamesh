import { existsSync } from "node:fs";
import { CoordinationEngine } from "@gitamesh/core";
import { createPostgresStorage } from "../../dist/index.js";

// A separate OS process, and therefore a separate synckit worker and real
// server connection. The parent supplies only a disposable test database.
const url = new URL(process.env.GITAMESH_TEST_POSTGRES_URL);
url.searchParams.set("application_name", process.env.GITAMESH_CONCURRENCY_APP_NAME);
const storage = createPostgresStorage(url.toString());
const pause = new Int32Array(new SharedArrayBuffer(4));

function barrier(path) {
  process.send({ type: "snapshot" });
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("Concurrent-process test barrier timed out");
    Atomics.wait(pause, 0, 0, 5);
  }
}

process.once("message", (message) => {
  let result;
  try {
    if (message.mode === "claim") {
      const getAttempts = storage.getActiveAttemptsForTask.bind(storage);
      let paused = false;
      storage.getActiveAttemptsForTask = (taskId) => {
        const attempts = getAttempts(taskId);
        if (!paused) {
          paused = true;
          barrier(message.gate);
        }
        return attempts;
      };
      const claimed = new CoordinationEngine(storage).claimTask({
        taskId: message.task.task_id,
        agentId: `agent_${process.pid}`,
        workspaceSessionId: `session_${process.pid}`,
        requiredResources: [],
      });
      result = { ok: true, attemptId: claimed.attempt.attempt_id };
    } else if (message.mode === "idempotency") {
      result = storage.transaction(() => {
        const receipt = storage.lookupIdempotentResult(message.key);
        barrier(message.gate);
        if (receipt) return { ok: true, taskId: receipt.taskId, replayed: true };
        storage.saveTask(message.task);
        storage.recordIdempotentResult(message.key, { taskId: message.task.task_id });
        return { ok: true, taskId: message.task.task_id, replayed: false };
      });
    } else {
      throw new Error("Unknown concurrent-process test mode");
    }
  } catch (error) {
    result = { ok: false, errorType: error.type ?? null, message: error.message };
  }
  try {
    storage.close();
  } finally {
    process.send({ type: "result", ...result }, () => process.exit(0));
  }
});

process.send({ type: "ready" });
