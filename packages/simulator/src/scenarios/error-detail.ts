import { GitameshError } from "@gitamesh/protocol";

/**
 * A report-safe, DETERMINISTIC description of a caught error.
 *
 * `GitameshError.type` and `.title` are static per error factory (e.g.
 * always `"Task already claimed"` / `.../task-already-claimed`) — safe
 * to embed in `simulation-report.json`. `.detail` and `Error.message`
 * are NOT safe in general: several factories (e.g.
 * `invalidStateTransition`, `taskAlreadyClaimed`) interpolate a
 * storage-generated id (`attempt_id`, etc.) into the message, and
 * `@gitamesh/storage-sqlite`'s `generateId` uses a module-level counter
 * that is only reset by starting a fresh process — embedding that text
 * verbatim would make two in-process scenario runs (as exercised by
 * `test/scenarios.test.ts`'s "same seed -> identical timeline" check)
 * diverge even though nothing about the simulation's LOGIC differed.
 */
export function describeError(error: unknown): string {
  if (error instanceof GitameshError) {
    return `${error.title} (status ${error.status}, type: ${error.type.split("/").pop()})`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.constructor.name}`;
  }
  return "unknown error";
}
