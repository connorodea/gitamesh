/**
 * Runnable example: async multi-agent orchestration (ADR-0002).
 *
 *   pnpm build
 *   pnpm --filter @gitamesh/daemon exec tsx examples/async-orchestration.ts
 *
 * With no environment it starts a throwaway in-memory daemon on a free port.
 * Set GITAMESH_URL and GITAMESH_TOKEN to run it against a live daemon instead
 * (it creates one parent task and three children in repository "example-repo").
 *
 * One orchestrator dispatches three subtasks and returns at once. Three
 * workers run concurrently: two complete with a `result`, one is slow. The
 * orchestrator waits for `until: "all"` with a short timeout, reads the
 * partial fan-in, then cancels the straggler.
 */
import { createInMemorySqliteStorage } from "@gitamesh/storage-sqlite";
import { buildServer } from "../src/server.js";
import { mintToken } from "../src/auth.js";

async function startLocalDaemon(): Promise<{ url: string; token: string; stop: () => Promise<void> }> {
  const storage = createInMemorySqliteStorage();
  const { app } = buildServer({ storage, logger: false });
  const token = mintToken(storage, ["admin"]).rawToken;
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    url,
    token,
    stop: async () => {
      await app.close();
      storage.close();
    },
  };
}

function api(url: string, token: string) {
  return async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as T;
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
    return json;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const local = process.env.GITAMESH_URL ? null : await startLocalDaemon();
  const url = process.env.GITAMESH_URL ?? local!.url;
  const token = process.env.GITAMESH_TOKEN ?? local!.token;
  const call = api(url, token);

  try {
    const register = async (name: string) =>
      (await call<{ agent: { agent_id: string } }>("POST", "/v1/agents", { display_name: name, runtime: "custom" }))
        .agent.agent_id;
    const orchestrator = await register("example-orchestrator");

    // 1. The orchestrator holds a parent task and fans out.
    const { task: parent } = await call<{ task: { task_id: string } }>("POST", "/v1/tasks", {
      repository_id: "example-repo",
      title: "Summarise three modules",
    });
    await call("POST", `/v1/tasks/${parent.task_id}/claim`, { agentId: orchestrator, workspaceSessionId: "orch" });
    const { subtasks } = await call<{ subtasks: Array<{ task_id: string; title: string }> }>(
      "POST",
      `/v1/tasks/${parent.task_id}/dispatch`,
      { subtasks: [{ title: "summarise core" }, { title: "summarise daemon" }, { title: "summarise cli" }] },
    );
    console.log(`dispatched ${subtasks.length} subtasks under ${parent.task_id}`);

    // 2. Workers run in the background, in parallel with the orchestrator.
    const worker = async (taskId: string, delayMs: number, result: Record<string, unknown>) => {
      const agentId = await register(`worker-${taskId}`);
      const claim = await call<{ attempt: { attempt_id: string }; fencingToken: number }>(
        "POST",
        `/v1/tasks/${taskId}/claim`,
        { agentId, workspaceSessionId: `ws-${taskId}` },
      );
      await sleep(delayMs);
      await call("POST", `/v1/tasks/${taskId}/complete`, {
        attemptId: claim.attempt.attempt_id,
        fencingToken: claim.fencingToken,
        result,
      }).catch(() => undefined); // the slow worker's task may be cancelled first
    };
    const workers = [
      worker(subtasks[0]!.task_id, 100, { lines: 120 }),
      worker(subtasks[1]!.task_id, 200, { lines: 340 }),
      worker(subtasks[2]!.task_id, 5_000, { lines: 0 }),
    ];

    // 3. The orchestrator blocks until all children settle, or 1 s passes.
    const waited = await call<{ woke: string; waited_ms: number; summary: { outcome: string; succeeded: number } }>(
      "POST",
      `/v1/tasks/${parent.task_id}/wait`,
      { until: "all", timeout_ms: 1_000 },
    );
    console.log(`woke: ${waited.woke} after ${waited.waited_ms} ms, ${waited.summary.succeeded} succeeded`);

    // 4. Partial failure policy: keep what finished, cancel the straggler.
    const cancelled = await call<{ cancelled: unknown[]; summary: { outcome: string; subtasks: Array<{ title: string; status: string; result: unknown }> } }>(
      "POST",
      `/v1/tasks/${parent.task_id}/cancel-subtasks`,
      {},
    );
    console.log(`cancelled ${cancelled.cancelled.length}; outcome: ${cancelled.summary.outcome}`);
    for (const s of cancelled.summary.subtasks) {
      console.log(`  ${s.status.padEnd(9)} ${s.title}  result=${JSON.stringify(s.result)}`);
    }
    await Promise.all(workers);
  } finally {
    await local?.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
