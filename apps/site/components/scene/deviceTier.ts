export type DeviceTier = "low" | "mid" | "high";

/**
 * A deliberately simple heuristic — viewport width plus reported core count
 * — rather than full GPU/UA sniffing. Good enough to keep particle counts
 * and post-processing cost sane on phones and low-end laptops without
 * over-engineering device detection.
 */
export function getDeviceTier(width: number): DeviceTier {
  const cores =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;

  if (width < 640 || cores <= 2) return "low";
  if (width < 1024 || cores <= 4) return "mid";
  return "high";
}

export const TIER_SETTINGS: Record<
  DeviceTier,
  { particles: number; dpr: [number, number]; postFx: boolean }
> = {
  low: { particles: 140, dpr: [1, 1.25], postFx: true },
  mid: { particles: 380, dpr: [1, 1.5], postFx: true },
  high: { particles: 700, dpr: [1, 1.9], postFx: true },
};
