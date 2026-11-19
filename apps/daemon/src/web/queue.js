"use strict";

(() => {
  const element = (id) => document.getElementById(id);
  const state = {
    token: "", connected: false, version: 0, tasks: [], repositories: [],
    refreshPromise: null, controllers: new Set(), submitting: false,
    submission: null, selectedTask: null, detailVersion: 0, draftRepository: "",
    detailRequest: null, progress: { taskId: null, cursor: 0, events: [] },
  };
  const statusNames = {
    pending: "Pending", queued: "Queued", claiming: "Claiming", running: "Running",
    blocked: "Blocked", awaiting_approval: "Awaiting approval", completed: "Completed",
    failed: "Failed", cancelled: "Cancelled", dead_letter: "Dead letter",
  };
  const groups = {
    ready: (task) => ["pending", "queued"].includes(task.status) && task.readiness === "ready" && !task.owner,
    active: (task) => ["claiming", "running"].includes(task.status),
    blocked: (task) => task.readiness === "blocked" || task.status === "blocked",
    failed: (task) => ["failed", "dead_letter"].includes(task.status),
  };

  class ApiError extends Error {
    constructor(message, status = 0) { super(message); this.status = status; }
  }

  function showMessage(id, message, error = false) {
    const target = element(id);
    target.replaceChildren();
    target.textContent = message;
    target.classList.toggle("feedback-error", error);
    target.hidden = !message;
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function isCurrent(version) { return version === state.version; }

  async function api(path, options = {}) {
    if (!state.token) throw new ApiError("Connect to the workspace first.", 401);
    const version = state.version;
    const controller = new AbortController();
    state.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const headers = { Authorization: `Bearer ${state.token}`, Accept: "application/json" };
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
      const response = await fetch(path, {
        method: options.method || "GET", headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!isCurrent(version)) throw new DOMException("Session ended", "AbortError");
      if (response.status === 401) {
        disconnect("Your token is invalid, expired, or revoked. Connect with a valid token.");
        throw new ApiError("Your session ended. Reconnect to continue.", 401);
      }
      if (!response.ok) {
        const detail = data && typeof data.detail === "string" ? data.detail : null;
        throw new ApiError(detail || (response.status === 403
          ? "This token does not have access to that action."
          : `The server could not complete the request (${response.status}).`), response.status);
      }
      if (!data || typeof data !== "object") throw new ApiError("The server returned an unreadable response.");
      return data;
    } catch (error) {
      if (!isCurrent(version) || error instanceof ApiError) throw error;
      throw new ApiError(error.name === "AbortError"
        ? "The request timed out. Check your connection and try again."
        : "Could not reach the server. Check your connection and try again.");
    } finally {
      clearTimeout(timeout);
      state.controllers.delete(controller);
    }
  }

  function clearTasks() {
    state.tasks = [];
    state.repositories = [];
    element("task-list").replaceChildren();
    element("task-count").textContent = "0";
    for (const name of ["ready", "active", "blocked", "completed"]) element(`count-${name}`).textContent = "—";
    element("repository").replaceChildren(new Option("Connect to choose a repository", ""));
    element("empty-state").hidden = false;
    element("empty-title").textContent = "Your work, in one place";
    element("empty-description").textContent = "Connect to submit tasks and see what your agents are working on.";
    element("last-updated").textContent = "Connect to see your queue.";
    element("task-list").setAttribute("aria-busy", "false");
  }

  function setConnected(connected) {
    state.connected = connected;
    element("connection-panel").hidden = connected;
    element("disconnect").hidden = !connected;
    element("connection-dot").classList.toggle("connected", connected);
    element("connection-status").textContent = connected ? "Connected" : "Disconnected";
    for (const id of ["refresh", "search", "status-filter"]) element(id).disabled = !connected;
    element("task-fields").disabled = !connected || !state.repositories.length || state.submitting;
  }

  function disconnect(message = "") {
    state.draftRepository = element("repository").value || state.draftRepository;
    state.version += 1;
    state.token = "";
    state.refreshPromise = null;
    for (const controller of state.controllers) controller.abort();
    state.controllers.clear();
    element("token").value = "";
    element("connect-button").disabled = false;
    element("connect-button").textContent = "Connect";
    state.selectedTask = null;
    state.detailVersion += 1;
    state.detailRequest = null;
    state.progress = { taskId: null, cursor: 0, events: [] };
    if (element("task-dialog").open) element("task-dialog").close();
    element("detail-content").replaceChildren();
    element("detail-title").textContent = "Task details";
    element("detail-id").textContent = "";
    showMessage("detail-error", "");
    showMessage("queue-error", "");
    showMessage("submit-feedback", "");
    clearTasks();
    setConnected(false);
    showMessage("connection-error", message, !!message);
  }

  function repositoryName(id) {
    return state.repositories.find((repository) => repository.repository_id === id)?.display_name || id;
  }

  function formatTime(iso, relative = false) {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return "Unknown time";
    if (!relative) return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return "Just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function priorityName(priority) {
    return ({ "-10": "Low", 0: "Normal", 10: "High", 20: "Urgent" })[priority] || `Priority ${priority}`;
  }

  function statusPill(task) {
    const group = groups.blocked(task) ? "blocked" : groups.ready(task) ? "ready" : groups.active(task) ? "active" : task.status;
    const pill = make("span", `status-pill ${group}`, statusNames[task.status] || task.status);
    pill.title = `Task status: ${task.status}${task.readiness === "blocked" ? "; dependencies are incomplete" : ""}`;
    return pill;
  }

  function renderTasks() {
    const counts = {
      ready: state.tasks.filter(groups.ready).length,
      active: state.tasks.filter(groups.active).length,
      blocked: state.tasks.filter(groups.blocked).length,
      completed: state.tasks.filter((task) => task.status === "completed").length,
    };
    for (const [name, count] of Object.entries(counts)) element(`count-${name}`).textContent = String(count);
    element("task-count").textContent = String(state.tasks.length);
    const query = element("search").value.trim().toLowerCase();
    const status = element("status-filter").value;
    const tasks = state.tasks.filter((task) => {
      const matchesStatus = status === "all" || (groups[status] ? groups[status](task) : task.status === status);
      const content = [task.title, task.task_id, repositoryName(task.repository_id), task.owner?.display_name || ""].join(" ");
      return matchesStatus && (!query || content.toLowerCase().includes(query));
    }).sort((left, right) => right.priority - left.priority || right.created_at.localeCompare(left.created_at) || left.task_id.localeCompare(right.task_id));
    const fragment = document.createDocumentFragment();
    for (const task of tasks) {
      const row = make("button", "task-row");
      row.type = "button";
      row.dataset.taskId = task.task_id;
      const main = make("span", "task-row-main");
      main.append(make("span", "task-row-title", task.title));
      const meta = make("span", "task-row-secondary");
      const parts = [repositoryName(task.repository_id), priorityName(task.priority), task.owner?.display_name || (task.readiness === "blocked" ? "Waiting on dependencies" : "Unassigned")];
      parts.forEach((part, index) => {
        if (index) meta.append(make("span", "separator", "·"));
        meta.append(make("span", "", part));
      });
      main.append(meta);
      const right = make("span", "task-row-right");
      right.append(statusPill(task));
      const time = make("span", "task-row-time", formatTime(task.updated_at, true));
      time.title = formatTime(task.updated_at);
      right.append(time);
      row.append(main, right);
      fragment.append(row);
    }
    // Avoid destroying keyboard focus while refreshing an unchanged list.
    const focused = document.activeElement?.closest?.(".task-row")?.dataset.taskId;
    element("task-list").replaceChildren(fragment);
    if (focused) {
      const row = [...element("task-list").children].find((candidate) => candidate.dataset.taskId === focused);
      row?.focus({ preventScroll: true });
    }
    element("empty-state").hidden = tasks.length > 0;
    element("empty-title").textContent = state.tasks.length ? "No matching tasks" : "Ready for your first task";
    element("empty-description").textContent = state.tasks.length
      ? "Try another search or change the state filter."
      : "Submit a task to give your workers something to pick up. Tasks submitted through the API appear here too.";
  }

  function renderRepositories() {
    const select = element("repository");
    const previous = select.value || state.draftRepository;
    select.replaceChildren(...state.repositories.map((repository) => new Option(repository.display_name, repository.repository_id)));
    if (!state.repositories.length) select.append(new Option("No repositories registered", ""));
    else if (state.repositories.some((repository) => repository.repository_id === previous)) select.value = previous;
    state.draftRepository = select.value;
    element("submit-note").textContent = state.repositories.length
      ? "Tasks wait in the queue until a compatible worker claims them."
      : "Register a repository with the Gitamesh CLI to start submitting tasks.";
    element("task-fields").disabled = !state.connected || !state.repositories.length || state.submitting;
  }

  async function refresh() {
    if (!state.token) return;
    if (state.refreshPromise) return state.refreshPromise;
    const version = state.version;
    element("task-list").setAttribute("aria-busy", "true");
    element("refresh").disabled = true;
    const work = (async () => {
      const [repositories, tasks] = await Promise.all([api("/v1/repositories"), api("/v1/tasks")]);
      if (!isCurrent(version)) return;
      if (!Array.isArray(repositories.repositories) || !Array.isArray(tasks.tasks)) throw new ApiError("The server returned an invalid queue response.");
      state.repositories = repositories.repositories;
      state.tasks = tasks.tasks;
      renderRepositories();
      renderTasks();
      element("last-updated").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
      showMessage("queue-error", "");
    })();
    state.refreshPromise = work;
    try { await work; }
    finally {
      if (isCurrent(version)) {
        state.refreshPromise = null;
        element("task-list").setAttribute("aria-busy", "false");
        element("refresh").disabled = !state.connected;
      }
    }
  }

  async function refreshVisible() {
    if (!state.connected || document.hidden) return;
    const version = state.version;
    try {
      await refresh();
      if (isCurrent(version) && state.selectedTask && element("task-dialog").open) await loadDetails(state.selectedTask, false);
    } catch (error) {
      if (isCurrent(version) && state.connected) showMessage("queue-error", `${error.message} The queue below may be out of date.`, true);
    }
  }

  async function connect(event) {
    event.preventDefault();
    const credential = element("token").value.trim();
    if (!credential) return;
    // Do not send a reusable credential over a remote plaintext connection.
    if (location.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
      showMessage("connection-error", "Open this workspace over HTTPS before connecting.", true);
      return;
    }
    state.version += 1;
    const version = state.version;
    state.token = credential;
    element("token").value = "";
    element("connect-button").disabled = true;
    element("connect-button").textContent = "Connecting…";
    element("connection-status").textContent = "Connecting…";
    showMessage("connection-error", "");
    try {
      await refresh();
      if (!isCurrent(version)) return;
      setConnected(true);
      renderRepositories();
    } catch (error) {
      if (isCurrent(version)) disconnect(error.message);
    } finally {
      if (isCurrent(version)) {
        element("connect-button").disabled = false;
        element("connect-button").textContent = "Connect";
      }
    }
  }

  async function submitTask(event) {
    event.preventDefault();
    if (state.submitting || !state.connected || !element("task-form").reportValidity()) return;
    const body = {
      repository_id: element("repository").value,
      title: element("title").value.trim(),
      description: element("description").value.trim(),
      priority: Number(element("priority").value),
      required_capabilities: [...new Set(element("capabilities").value.split(",").map((item) => item.trim()).filter(Boolean))].sort(),
    };
    if (!body.title) {
      showMessage("submit-feedback", "Give the task a title before submitting it.", true);
      element("title").focus();
      return;
    }
    const fingerprint = JSON.stringify(body);
    if (!state.submission || state.submission.fingerprint !== fingerprint) {
      state.submission = { fingerprint, key: `web-queue-${crypto.randomUUID()}` };
    }
    const version = state.version;
    const key = state.submission.key;
    state.submitting = true;
    element("task-fields").disabled = true;
    element("submit-button").textContent = "Adding to queue…";
    showMessage("submit-feedback", "");
    try {
      const response = await api("/v1/tasks", { method: "POST", body, idempotencyKey: key });
      if (!isCurrent(version)) return;
      if (!response.task || typeof response.task.task_id !== "string") throw new ApiError("The server did not confirm the task ID.");
      state.submission = null;
      element("task-form").reset();
      element("repository").value = body.repository_id;
      state.draftRepository = body.repository_id;
      showMessage("submit-feedback", `${response.replayed ? "Previous submission recovered" : "Task saved"}: ${response.task.task_id}. Open the task to follow its status.`);
      const open = make("button", "button button-secondary", "View task");
      open.type = "button";
      open.addEventListener("click", () => openDetails(response.task.task_id));
      element("submit-feedback").append(open);
      if (Array.isArray(response.warnings) && response.warnings.length) {
        element("submit-feedback").append(make("p", "field-help", response.warnings.map((warning) => warning.detail || warning.code).join(" ")));
      }
      try { await refresh(); }
      catch (error) { if (isCurrent(version)) showMessage("queue-error", `Task was added, but refreshing the queue failed. ${error.message}`, true); }
    } catch (error) {
      if (isCurrent(version)) {
        const uncertain = !error.status || error.status >= 500;
        showMessage("submit-feedback", `${error.message}${uncertain ? " The task may have been saved. Submit the unchanged task again to retry safely." : ""}`, true);
      }
    } finally {
      state.submitting = false;
      element("submit-button").replaceChildren(document.createTextNode("Add to queue "), make("span", "", "↗"));
      element("task-fields").disabled = !state.connected || !state.repositories.length;
    }
  }

  function metadataItem(grid, title, value) {
    const cell = make("div");
    cell.append(make("dt", "", title));
    const detail = make("dd");
    detail.append(value instanceof Node ? value : document.createTextNode(String(value)));
    cell.append(detail);
    grid.append(cell);
  }

  function renderDetails(detail, progress) {
    const task = detail.task;
    element("detail-title").textContent = task.title;
    element("detail-id").textContent = task.task_id;
    const content = document.createDocumentFragment();
    const grid = make("dl", "detail-grid");
    metadataItem(grid, "Status", statusPill(task));
    metadataItem(grid, "Repository", repositoryName(task.repository_id));
    metadataItem(grid, "Priority", priorityName(task.priority));
    metadataItem(grid, "Assigned to", task.owner?.display_name || "Unassigned");
    metadataItem(grid, "Created", formatTime(task.created_at));
    metadataItem(grid, "Last updated", formatTime(task.updated_at));
    if (task.owner) metadataItem(grid, "Lease expires", formatTime(task.owner.expires_at));
    if (task.required_capabilities?.length) metadataItem(grid, "Required capabilities", task.required_capabilities.join(", "));
    if (task.dependencies?.length) metadataItem(grid, "Dependencies", task.dependencies.join(", "));
    if (task.blocked_by?.length) metadataItem(grid, "Waiting on", task.blocked_by.join(", "));
    content.append(grid, make("h3", "", "Instructions"), make("p", "detail-description", task.description || "No additional instructions."));
    content.append(make("h3", "", "Progress"));
    const reports = (progress.events || []).slice().reverse().slice(0, 20);
    if (progress.catchingUp) content.append(make("p", "muted field-help", "Loading remaining task history…"));
    if (!reports.length && !progress.catchingUp) content.append(make("p", "muted field-help", "No progress reports yet. A worker can report updates after claiming this task."));
    else {
      const list = make("ol", "progress-list");
      for (const report of reports) {
        const item = make("li");
        const phase = String(report.payload?.phase || "update").replaceAll("_", " ");
        item.append(make("p", "progress-meta", `${phase} · ${formatTime(report.occurred_at)}`));
        item.append(make("p", "progress-body", report.payload?.summary || ""));
        if (Array.isArray(report.payload?.evidence) && report.payload.evidence.length) item.append(make("pre", "progress-evidence", report.payload.evidence.join("\n")));
        list.append(item);
      }
      content.append(list);
    }
    if (Array.isArray(detail.notes) && detail.notes.length) {
      content.append(make("h3", "", "Notes"));
      const list = make("ol", "progress-list");
      for (const note of detail.notes.slice(-20).reverse()) {
        const item = make("li");
        item.append(make("p", "progress-meta", `${note.agent_id} · ${formatTime(note.created_at)}`), make("p", "progress-body", note.body));
        list.append(item);
      }
      content.append(list);
    }
    element("detail-content").replaceChildren(content);
  }

  async function readProgress(taskId, version, detailVersion) {
    const cached = state.progress.taskId === taskId ? state.progress : { cursor: 0, events: [] };
    let cursor = cached.cursor;
    let events = cached.events.slice();
    // The API pages through repository events before filtering for this task.
    // An empty page may still advance the cursor, so read until it stops moving.
    // Bound each refresh; a busy repository continues from this cursor next time.
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      if (!isCurrent(version) || detailVersion !== state.detailVersion) throw new DOMException("Task changed", "AbortError");
      const page = await api(`/v1/tasks/${encodeURIComponent(taskId)}/progress?limit=500&since=${cursor}`);
      if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < cursor || !Array.isArray(page.events)) throw new ApiError("The server returned invalid task history.");
      const unique = new Map(events.map((event) => [event.event_id, event]));
      for (const event of page.events) unique.set(event.event_id, event);
      events = [...unique.values()].slice(-20);
      if (page.nextCursor === cursor) return { events, cursor, catchingUp: false };
      cursor = page.nextCursor;
    }
    return { events, cursor, catchingUp: true };
  }

  async function loadDetails(taskId, loading = true) {
    if (state.detailRequest?.taskId === taskId && state.detailRequest.version === state.version) return state.detailRequest.promise;
    const version = state.version;
    const detailVersion = ++state.detailVersion;
    if (loading) {
      element("detail-title").textContent = "Loading task…";
      element("detail-id").textContent = taskId;
      element("detail-content").replaceChildren();
    }
    element("detail-content").setAttribute("aria-busy", "true");
    const work = (async () => {
      try {
        const encoded = encodeURIComponent(taskId);
        const [detail, progress] = await Promise.all([api(`/v1/tasks/${encoded}`), readProgress(taskId, version, detailVersion)]);
        if (!isCurrent(version) || detailVersion !== state.detailVersion || state.selectedTask !== taskId) return;
        state.progress = { taskId, cursor: progress.cursor, events: progress.events };
        renderDetails(detail, progress);
        showMessage("detail-error", "");
      } catch (error) {
        if (isCurrent(version) && detailVersion === state.detailVersion) showMessage("detail-error", error.message, true);
      } finally {
        if (isCurrent(version) && detailVersion === state.detailVersion) element("detail-content").setAttribute("aria-busy", "false");
        if (state.detailRequest?.detailVersion === detailVersion) state.detailRequest = null;
      }
    })();
    state.detailRequest = { taskId, version, detailVersion, promise: work };
    return work;
  }

  function openDetails(taskId) {
    if (!state.connected) return;
    state.selectedTask = taskId;
    showMessage("detail-error", "");
    element("task-dialog").showModal();
    void loadDetails(taskId);
  }

  element("connect-form").addEventListener("submit", connect);
  element("disconnect").addEventListener("click", () => { disconnect(); element("token").focus(); });
  element("refresh").addEventListener("click", refreshVisible);
  element("task-form").addEventListener("submit", submitTask);
  for (const eventName of ["input", "change"]) element("task-form").addEventListener(eventName, () => {
    // Keep the retry receipt until a confirmed response or a different
    // normalized payload. Whitespace edits must not duplicate a saved task.
    if (!state.submitting) showMessage("submit-feedback", "");
  });
  element("search").addEventListener("input", renderTasks);
  element("status-filter").addEventListener("change", renderTasks);
  element("task-list").addEventListener("click", (event) => {
    const row = event.target.closest(".task-row");
    if (row) openDetails(row.dataset.taskId);
  });
  element("close-dialog").addEventListener("click", () => element("task-dialog").close());
  element("task-dialog").addEventListener("close", () => { state.selectedTask = null; state.detailVersion += 1; state.detailRequest = null; });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshVisible(); });
  window.addEventListener("pagehide", () => disconnect());
  setInterval(refreshVisible, 5_000);
})();
