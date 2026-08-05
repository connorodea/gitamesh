/**
 * Design choice: heartbeat failures are surfaced via `onError`, never
 * thrown into the `setInterval` callback. An uncaught rejection inside an
 * interval tick would (depending on runtime) either crash the process or
 * silently vanish as an unhandled rejection — neither is acceptable for a
 * background loop the caller isn't actively awaiting. `onError` lets the
 * caller decide what a heartbeat failure means for them (e.g. a
 * `GitameshConflictError`/`stale-attempt-token` means their lease was
 * superseded and they should stop working and call `.stop()`), without
 * the loop itself making that policy decision.
 */
export interface HeartbeatLoopOptions {
  leaseDurationMs?: number;
  idempotencyKey?: string;
  onError?: (error: unknown) => void;
  /** Injectable timer functions, for deterministic tests with `vi.useFakeTimers()`. */
  timers?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
}

export interface HeartbeatLoopHandle {
  stop(): void;
}

export interface HeartbeatSender {
  (): Promise<unknown>;
}

/**
 * Generic interval-driven loop that calls `sendHeartbeat` every
 * `intervalMs`, routing failures to `onError` instead of throwing.
 * `GitameshClient.startHeartbeatLoop` is a thin wrapper that supplies
 * `sendHeartbeat` as a call to `POST /v1/tasks/:taskId/heartbeat`.
 */
export function startHeartbeatLoop(
  sendHeartbeat: HeartbeatSender,
  intervalMs: number,
  options?: HeartbeatLoopOptions,
): HeartbeatLoopHandle {
  const timers = options?.timers ?? { setInterval, clearInterval };
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    sendHeartbeat().catch((error: unknown) => {
      options?.onError?.(error);
    });
  };

  const handle = timers.setInterval(tick, intervalMs);

  return {
    stop: () => {
      stopped = true;
      timers.clearInterval(handle);
    },
  };
}
