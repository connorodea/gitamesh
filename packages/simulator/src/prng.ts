/**
 * A tiny, dependency-free, deterministic PRNG (mulberry32) plus a handful
 * of derived helpers used by every scenario module.
 *
 * IMPORTANT: this is the ONLY source of randomness anywhere in
 * `packages/simulator`. No scenario, fixture, or runner may call
 * `Math.random()`, read wall-clock time to make a scheduling decision, or
 * rely on object/Map iteration order that isn't itself seeded from this
 * generator. That is what makes `gitamesh simulate --seed N` reproduce the
 * exact same sequence of claims, heartbeats, crashes, and outcomes every
 * time it runs.
 */

export type Rng = () => number;

/**
 * mulberry32: a 32-bit state PRNG. Not cryptographically secure — it does
 * not need to be. It is fast, allocation-free, and (critically) fully
 * deterministic: the same `seed` always produces the same infinite output
 * sequence.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random integer in [min, max] inclusive. */
export function randInt(rng: Rng, min: number, max: number): number {
  if (max < min) {
    throw new Error(`randInt: max (${max}) < min (${min})`);
  }
  return min + Math.floor(rng() * (max - min + 1));
}

/** True with probability `p` (0..1). */
export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}

/** Picks one element of a non-empty array. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error("pick: cannot pick from an empty array");
  }
  const idx = Math.floor(rng() * items.length);
  return items[Math.min(idx, items.length - 1)] as T;
}

/** Fisher-Yates shuffle, using `rng` for every swap decision. Returns a new array; does not mutate the input. */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = result[i] as T;
    result[i] = result[j] as T;
    result[j] = tmp;
  }
  return result;
}
