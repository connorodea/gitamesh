"use client";

import { useEffect, useRef } from "react";
import { scrollState } from "@/lib/scrollStore";

/**
 * Scroll is the time cursor — this is the readout that says so.
 *
 * The page's scroll position is not a page position in this piece; it is a
 * position in the event log. Without a readout that claim lives only in the
 * camera motion, where a reader can miss it. A monospace scrubbing counter
 * makes it explicit and costs nothing:
 *
 *   EVENT ────────  04412 / 10000
 *   FENCE #04412
 *
 * The fencing token is shown separately because it is the one number in the
 * system that is *monotonic* — it only ever increases, which is precisely why
 * a stale writer's late arrival can be rejected. Rendering it as a counter
 * that climbs with the scroll is time's arrow made literal, and it is the
 * honest visualisation: the daemon really does hand out strictly increasing
 * tokens, and `listEventsSince(cursor)` really does take a position in this
 * log.
 *
 * Written directly to the DOM from a rAF loop reading the shared scroll store
 * — no React state, so scrubbing the page never triggers a render.
 *
 * Under reduced motion the loop still runs (the readout is information, not
 * animation, and a frozen counter next to a moving scrollbar would just be
 * wrong) but it is fed by native scroll rather than eased scroll.
 */

const TOTAL_EVENTS = 10000;
const TRACK_WIDTH = 14;

export function TimeCursorHud() {
  const eventRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const fenceRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let frame = 0;
    let lastCursor = -1;

    const update = () => {
      frame = requestAnimationFrame(update);
      const cursor = Math.round(scrollState.page * TOTAL_EVENTS);
      // Only touch the DOM when the displayed value actually changes.
      if (cursor === lastCursor) return;
      lastCursor = cursor;

      const padded = String(cursor).padStart(5, "0");
      if (eventRef.current) eventRef.current.textContent = padded;
      if (fenceRef.current) fenceRef.current.textContent = padded;

      if (trackRef.current) {
        const head = Math.round((cursor / TOTAL_EVENTS) * (TRACK_WIDTH - 1));
        let track = "";
        for (let i = 0; i < TRACK_WIDTH; i++) {
          track += i === head ? "+" : i < head ? "=" : "─";
        }
        trackRef.current.textContent = track;
      }
    };

    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-10 left-6 flex flex-col gap-1 font-mono text-[9px] uppercase leading-relaxed tracking-[0.24em] text-fg-faint/80 sm:left-10"
    >
      <span className="flex items-center gap-2">
        <span className="text-fg-faint/60">Event</span>
        <span ref={trackRef} className="text-mesh/70">
          ──────────────
        </span>
        <span ref={eventRef} className="text-fg-muted">
          00000
        </span>
        <span className="text-fg-faint/50">/ {TOTAL_EVENTS}</span>
      </span>
      <span className="flex items-center gap-2">
        <span className="text-fg-faint/60">Fence</span>
        <span className="text-claim/80">
          #<span ref={fenceRef}>00000</span>
        </span>
      </span>
    </div>
  );
}
