import type { CoordinationEngine } from "@gitamesh/core";
import type { SqliteStorageAdapter } from "@gitamesh/storage-sqlite";
import type { Rng } from "../prng.js";

/**
 * One entry in a scenario's failure/operation timeline. Deliberately
 * excludes any wall-clock field (no `occurred_at`, no raw entity
 * `created_at`/`expires_at`) — including one would make
 * `simulation-report.json` different byte-for-byte on every run even at
 * a fixed seed, since `StorageAdapter.now()` reads the real clock and
 * `packages/core` does not accept an injected clock for most operations.
 * Everything here is either caller-supplied (deterministic) or a pure
 * function of scenario logic.
 */
export interface TimelineEntry {
  step: number;
  action: string;
  actorAgentId?: string;
  taskId?: string;
  outcome: "ok" | "error" | "info";
  detail?: string;
  /** For `outcome: "error"`, the ProblemDetails `type` suffix (e.g. "resource-conflict"). */
  errorType?: string;
}

export type ScenarioStatus = "pass" | "fail" | "skipped";

export interface ScenarioResult {
  name: string;
  title: string;
  status: ScenarioStatus;
  /** Human-readable reason: why it passed, why it failed, or why it was skipped. */
  reason: string;
  timeline: TimelineEntry[];
  /** Present only when status === "skipped": names the missing packages/core capability this scenario is blocked on. */
  blockedOn?: string;
}

export interface ScenarioContext {
  rng: Rng;
  engine: CoordinationEngine;
  storage: SqliteStorageAdapter;
  agentCount: number;
  taskCount: number;
}

export interface Scenario {
  name: string;
  title: string;
  description: string;
  run(ctx: ScenarioContext): ScenarioResult;
}

/** Small helper so every scenario builds its ScenarioResult the same way. */
export function makeTimeline(): {
  entries: TimelineEntry[];
  record: (entry: Omit<TimelineEntry, "step">) => void;
} {
  const entries: TimelineEntry[] = [];
  return {
    entries,
    record: (entry) => {
      entries.push({ step: entries.length + 1, ...entry });
    },
  };
}
