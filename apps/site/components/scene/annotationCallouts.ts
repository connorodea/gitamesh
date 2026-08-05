/**
 * Shared callout definitions for the annotation system.
 *
 * Deliberately dependency-free. The callout system has two halves that live
 * on opposite sides of the code-splitting boundary — the projector runs
 * inside the r3f tree (and therefore inside the lazily-loaded WebGL chunk),
 * while the labels are plain DOM rendered eagerly by the stage. This module
 * is the only thing they share, so importing it from the eager side cannot
 * drag three.js into the main bundle.
 */

/** Which constellation node each callout points at, and what it says. */
export const CALLOUTS = [
  { node: 2, id: "01", label: "CLAIM" },
  { node: 7, id: "02", label: "FENCE" },
  { node: 13, id: "03", label: "LEASE" },
  { node: 18, id: "04", label: "LOG" },
] as const;
