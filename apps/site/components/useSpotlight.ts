"use client";

import { useCallback, useRef } from "react";

/**
 * Cursor-tracking spotlight for card surfaces.
 *
 * Writes the pointer's card-local position straight to two CSS custom
 * properties on the element and lets a `radial-gradient` in the stylesheet do
 * the rest. Deliberately NOT React state: a card that re-rendered on every
 * mousemove would be a render storm sitting on top of a live WebGL canvas.
 * This path touches one element's inline style and composites — no React
 * work, no layout, no repaint outside the card.
 *
 * The visual is a faint mesh-teal wash that follows the cursor across the
 * card and a border that lights only near it, so a grid of cards responds to
 * the pointer as one surface rather than as four independent hover targets.
 *
 * Motion preference is honoured in CSS (`prefers-reduced-motion` hides the
 * spotlight layer entirely), so this hook stays a pure pointer-position feed.
 */
export function useSpotlight<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  const onPointerMove = useCallback((event: React.PointerEvent<T>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--spot-x", `${event.clientX - rect.left}px`);
    el.style.setProperty("--spot-y", `${event.clientY - rect.top}px`);
  }, []);

  return { ref, spotlightProps: { onPointerMove } };
}
