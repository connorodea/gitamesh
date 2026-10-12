import {
  attemptNotFound,
  staleAttemptToken,
  type TaskAttempt,
} from "@gitamesh/protocol";
import type { StorageAdapter } from "./storage-adapter.js";

/** Task statuses in which the holder of an attempt is still working on it. */
const REPORTABLE_TASK_STATUSES = new Set(["running", "blocked", "awaiting_approval"]);

/**
 * The attempt a progress report is allowed to speak for: the task's current
 * one, with a matching fencing token and a lease that is active and unexpired.
 * Unlike a heartbeat this checks and returns; it never renews the lease, so a
 * stream of reports cannot keep a dead worker's claim alive.
 *
 * Throws `attemptNotFound` (404) for an unknown attempt and
 * `staleAttemptToken` (409) for every other way the report is out of date.
 */
export function currentProgressAttempt(
  storage: StorageAdapter,
  taskId: string,
  attemptId: string,
  fencingToken: number,
): TaskAttempt {
  const attempt = storage.getAttempt(attemptId);
  if (!attempt) throw attemptNotFound(attemptId);

  const stale = (detail: string) =>
    staleAttemptToken({
      attemptId,
      providedToken: fencingToken,
      currentToken: attempt.fencing_token,
      detail,
    });

  if (attempt.task_id !== taskId) {
    throw stale(`Attempt ${attemptId} does not belong to task ${taskId}.`);
  }
  if (attempt.fencing_token !== fencingToken) throw stale(`Fencing token for attempt ${attemptId} is stale.`);
  if (attempt.status !== "leased" && attempt.status !== "running") {
    throw stale(`Attempt ${attemptId} is "${attempt.status}", not active.`);
  }
  const task = storage.getTask(taskId);
  if (!task || !REPORTABLE_TASK_STATUSES.has(task.status)) {
    throw stale(`Task ${taskId} is "${task?.status ?? "missing"}"; progress can only be reported while it is being worked on.`);
  }
  const lease = storage.getLeaseByAttempt(attemptId);
  const now = Date.parse(storage.now());
  if (
    !lease ||
    lease.status !== "active" ||
    lease.fencing_token !== fencingToken ||
    lease.owner_agent_id !== attempt.agent_id ||
    Date.parse(lease.expires_at) <= now ||
    Date.parse(attempt.expires_at) <= now
  ) {
    throw stale(`The lease for attempt ${attemptId} is no longer active.`);
  }
  return attempt;
}
