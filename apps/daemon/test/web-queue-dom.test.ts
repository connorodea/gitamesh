import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemorySqliteStorage, type SqliteStorageAdapter } from "@gitamesh/storage-sqlite";
import { buildServer, type BuiltServer } from "../src/server.js";
import { mintToken } from "../src/auth.js";

let storage: SqliteStorageAdapter;
let built: BuiltServer;
let dom: JSDOM;
let token: string;
let dropNextSubmission: boolean;
let requests: { url: string; method: string; headers: Record<string, string> }[];
let scriptErrors: string[];

const element = (id: string) => dom.window.document.getElementById(id)!;
const field = (id: string) => element(id) as HTMLInputElement;
const submit = (id: string) => element(id).dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
const input = (id: string, value: string) => {
  field(id).value = value;
  element(id).dispatchEvent(new dom.window.Event("input", { bubbles: true }));
};
const waitForText = (id: string, text: string) => vi.waitFor(() => {
  expect(element(id).textContent).toContain(text);
}, { timeout: 3_000, interval: 10 });
const waitForSubmission = async (text: string) => {
  await waitForText("submit-feedback", text);
  await vi.waitFor(() => expect((element("task-fields") as HTMLFieldSetElement).disabled).toBe(false));
};

async function post(url: string, payload: unknown) {
  const response = await built.app.inject({
    method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload,
  });
  expect(response.statusCode, response.body).toBeLessThan(300);
  return response.json();
}

async function connect(credential = token) {
  input("token", credential);
  submit("connect-form");
  await waitForText("connection-status", "Connected");
}

beforeEach(async () => {
  storage = createInMemorySqliteStorage();
  built = buildServer({ storage, logger: false, rateLimitPerMinute: 10_000 });
  token = mintToken(storage, ["admin"]).rawToken;
  dropNextSubmission = false;
  requests = [];
  scriptErrors = [];
  await post("/v1/repositories", {
    display_name: "Queue interaction fixture", git_common_dir: "/test/queue/.git", default_branch: "main",
    metadata: { local_repository_id: "repo-dom" },
  });
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => scriptErrors.push(error.message));
  const page = await built.app.inject("/queue");
  dom = new JSDOM(page.body, {
    url: "http://localhost/queue", pretendToBeVisual: true, runScripts: "outside-only", virtualConsole,
  });
  // Exercise the real HTTP handlers while keeping these interaction tests
  // independent of a browser installation or an external listening port.
  dom.window.fetch = async (url: string, options: RequestInit) => {
    const headers = options.headers as Record<string, string>;
    const method = options.method || "GET";
    requests.push({ url, method, headers });
    const response = await built.app.inject({ method, url, headers, payload: options.body });
    if (method === "POST" && url === "/v1/tasks" && dropNextSubmission) {
      dropNextSubmission = false;
      throw new TypeError("Simulated lost response after the durable write");
    }
    return new Response(response.body, { status: response.statusCode });
  };
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new dom.window.Event("close"));
  };
  dom.window.eval((await built.app.inject("/queue/queue.js")).body);
});

afterEach(async () => {
  dom?.window.close();
  await built.app.close();
  storage.close();
  expect(scriptErrors).toEqual([]);
});

describe("web queue interactions against the daemon", () => {
  it("recovers a saved submission after equivalent edits without duplicating work or claiming it is still queued", async () => {
    await connect();
    input("title", "Verify deployment");
    input("description", "Run the verification suite.");
    input("capabilities", "typescript, node");
    dropNextSubmission = true;
    submit("task-form");
    await waitForSubmission("may have been saved");
    expect(storage.listTasks()).toHaveLength(1);
    const task = storage.listTasks()[0]!;
    const { agent } = await post("/v1/agents", {
      display_name: "Fast worker", runtime: "custom", capabilities: ["typescript", "node"],
    });
    const claim = await post(`/v1/tasks/${task.task_id}/claim`, {
      agentId: agent.agent_id, workspaceSessionId: "dom-worker",
    });
    await post(`/v1/tasks/${task.task_id}/complete`, {
      attemptId: claim.attempt.attempt_id, fencingToken: claim.fencingToken,
      result: { summary: "Completed before the browser retried" },
    });
    // An edit followed by undo, trimmed whitespace, duplicate capabilities,
    // and capability ordering all preserve the same logical request.
    input("title", "An abandoned edit");
    input("title", "  Verify deployment  ");
    input("description", " Run the verification suite.\n");
    input("capabilities", "node, typescript, node");
    submit("task-form");
    await waitForSubmission("Previous submission recovered");
    const submissions = requests.filter((request) => request.method === "POST");
    expect(submissions).toHaveLength(2);
    expect(submissions[0]!.headers["Idempotency-Key"]).toBeTruthy();
    expect(submissions[1]!.headers["Idempotency-Key"]).toBe(submissions[0]!.headers["Idempotency-Key"]);
    expect(storage.listTasks()).toHaveLength(1);
    expect(element("count-completed").textContent).toBe("1");
    expect(element("submit-feedback").textContent).not.toContain("queued");
    element("submit-feedback").querySelector("button")!.click();
    await waitForText("detail-content", "Completed");
  });

  it("uses a new submission key when the operator submits different work after an uncertain response", async () => {
    await connect();
    input("title", "First task");
    dropNextSubmission = true;
    submit("task-form");
    await waitForSubmission("may have been saved");
    input("title", "Second task");
    submit("task-form");
    await waitForSubmission("Task saved:");
    const keys = requests.filter((request) => request.method === "POST")
      .map((request) => request.headers["Idempotency-Key"]);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(storage.listTasks().map((task) => task.title).sort()).toEqual(["First task", "Second task"]);
  });

  it("renders accurate counts and untrusted task text, including progress beyond an unrelated event page", async () => {
    const { task: running } = await post("/v1/tasks", { repository_id: "repo-dom", title: "Running task" });
    const { task: pending } = await post("/v1/tasks", {
      repository_id: "repo-dom", title: "Pending task", description: "<script>window.__xss = true</script>",
    });
    await post("/v1/tasks", { repository_id: "repo-dom", title: "Blocked task", dependencies: [pending.task_id] });
    const { agent } = await post("/v1/agents", { display_name: "Progress worker", runtime: "custom" });
    const claim = await post(`/v1/tasks/${running.task_id}/claim`, {
      agentId: agent.agent_id, workspaceSessionId: "dom-progress-worker",
    });
    for (let index = 0; index < 520; index += 1) storage.appendEvent({
      schema_version: 1, event_type: "test.background", occurred_at: storage.now(), namespace_id: "repo-dom",
      repository_id: "repo-dom", workflow_id: null, task_id: pending.task_id, attempt_id: null,
      agent_id: null, workspace_session_id: null, correlation_id: null, causation_id: null,
      idempotency_key: null, payload: {}, metadata: {},
    });
    await post(`/v1/tasks/${running.task_id}/progress`, {
      attemptId: claim.attempt.attempt_id, fencingToken: claim.fencingToken,
      summary: "Latest verification update", phase: "verifying", evidence: ["<img src=x onerror=alert(1)>"],
    });
    await connect();
    expect(element("count-ready").textContent).toBe("1");
    expect(element("count-active").textContent).toBe("1");
    expect(element("count-blocked").textContent).toBe("1");
    (element("task-list").querySelector(`[data-task-id="${running.task_id}"]`) as HTMLButtonElement).click();
    await waitForText("detail-content", "Latest verification update");
    expect(element("detail-content").textContent).toContain("<img src=x onerror=alert(1)>");
    expect(element("detail-content").querySelectorAll("img")).toHaveLength(0);
    element("close-dialog").click();
    input("search", "Pending task");
    expect(element("task-list").children).toHaveLength(1);
    (element("task-list").firstElementChild as HTMLButtonElement).click();
    await waitForText("detail-content", "<script>");
    expect(element("detail-content").querySelectorAll("script")).toHaveLength(0);
    expect(dom.window.__xss).toBeUndefined();
  });

  it("keeps credentials out of storage and URLs, rejects read-only submission, and clears the disconnected view", async () => {
    const readOnly = mintToken(storage, ["repository:read", "task:read"]).rawToken;
    await connect(readOnly);
    expect(field("token").value).toBe("");
    input("title", "Unauthorized task");
    submit("task-form");
    await waitForSubmission("lacks required scope");
    expect(storage.listTasks()).toHaveLength(0);
    expect(dom.window.localStorage.length).toBe(0);
    expect(dom.window.sessionStorage.length).toBe(0);
    expect(requests.every((request) => !request.url.includes(readOnly) && !request.url.includes("token="))).toBe(true);
    element("disconnect").click();
    expect(element("connection-status").textContent).toBe("Disconnected");
    expect(element("task-list").children).toHaveLength(0);
    expect((element("task-fields") as HTMLFieldSetElement).disabled).toBe(true);
    expect(field("token").value).toBe("");
  });
});
