/**
 * Minimal hand-rolled per-token sliding-window rate limiter for mutating
 * routes. No dependency — the coordination engine already does the
 * concurrency-safety work; this just caps abusive/broken clients.
 *
 * Limits (documented in apps/daemon/README.md):
 *   - 60 mutating requests per rolling 60-second window, per token.
 *   - A separate, more generous cap (600/min) applies to unauthenticated
 *     identity (used only for the rare pre-auth paths, currently none —
 *     kept here for completeness/extension).
 */
const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 60;

interface Window {
  timestamps: number[];
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly limit: number = DEFAULT_LIMIT) {}

  /** Returns `{ allowed: true }` or `{ allowed: false, retryAfterMs }`. */
  check(key: string, now: number = Date.now()): { allowed: true } | { allowed: false; retryAfterMs: number } {
    let win = this.windows.get(key);
    if (!win) {
      win = { timestamps: [] };
      this.windows.set(key, win);
    }
    const cutoff = now - WINDOW_MS;
    win.timestamps = win.timestamps.filter((t) => t > cutoff);
    if (win.timestamps.length >= this.limit) {
      const oldest = win.timestamps[0]!;
      return { allowed: false, retryAfterMs: oldest + WINDOW_MS - now };
    }
    win.timestamps.push(now);
    return { allowed: true };
  }

  /** For tests / clean shutdown. */
  reset(): void {
    this.windows.clear();
  }
}
