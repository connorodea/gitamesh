"use client";

import { useEffect } from "react";
import Lenis from "lenis";
import { useReducedMotion } from "./useReducedMotion";
import { measureScroll, publishScrollVars } from "@/lib/scrollStore";

/**
 * Scroll runtime for the whole page.
 *
 * Two responsibilities, deliberately in one place so there is exactly one
 * scroll authority on the document:
 *
 * 1. Lenis smooth scroll. The four-act camera track is scrubbed by scroll
 *    position; with raw OS wheel input that scrub arrives in coarse ~100px
 *    jumps and the camera visibly stair-steps between keyframes. Lenis
 *    interpolates the scroll position itself, so the camera receives a
 *    continuous signal and the whole page reads as one damped, weighted
 *    object rather than a scene being nudged.
 *
 *    Lenis is configured against the real window scroll (its default), NOT a
 *    transformed virtual wrapper — so `window.scrollY`, `scrollHeight`, and
 *    `getBoundingClientRect()` all stay truthful. That matters: the scroll
 *    store and every `position: sticky` element on the page keep working
 *    unchanged, which a transform-based smooth-scroll implementation would
 *    have broken.
 *
 * 2. Publishing scroll state. Whether or not Lenis is running, this component
 *    keeps `scrollState` and the CSS scroll variables current.
 *
 * Under prefers-reduced-motion Lenis is never constructed at all — scroll
 * stays fully native and instantaneous — while the measurement path still
 * runs so layout-dependent values remain correct.
 */
export function SmoothScroll() {
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const sync = () => {
      measureScroll();
      publishScrollVars();
    };

    sync();
    window.addEventListener("resize", sync);

    if (reducedMotion) {
      // Native scroll only. A passive listener is enough; no rAF loop, no
      // interpolation, no wheel interception.
      window.addEventListener("scroll", sync, { passive: true });
      return () => {
        window.removeEventListener("scroll", sync);
        window.removeEventListener("resize", sync);
      };
    }

    const lenis = new Lenis({
      duration: 1.05,
      // Gentle exponential ease-out: fast to respond, long tail. This is the
      // single knob that most determines whether the page feels "expensive".
      easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      // Touch devices already have native inertial scrolling; smoothing on
      // top of it fights the platform and feels laggy.
      syncTouch: false,
    });

    lenis.on("scroll", sync);

    let frame = 0;
    const raf = (time: number) => {
      lenis.raf(time);
      frame = requestAnimationFrame(raf);
    };
    frame = requestAnimationFrame(raf);

    // In-page anchors must be handed to Lenis, otherwise the browser's own
    // instant jump fights the interpolated position and the camera snaps.
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.(
        'a[href^="#"]'
      ) as HTMLAnchorElement | null;
      if (!anchor) return;
      const id = anchor.getAttribute("href")?.slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      event.preventDefault();
      lenis.scrollTo(target, { offset: -72 });
    };
    document.addEventListener("click", onClick);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("click", onClick);
      window.removeEventListener("resize", sync);
      lenis.destroy();
    };
  }, [reducedMotion]);

  return null;
}
