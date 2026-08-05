import { describe, expect, it } from "vitest";
import { mulberry32, randInt, pick, shuffle, chance } from "../src/prng.js";

describe("mulberry32", () => {
  it("the same seed produces the exact same sequence of values", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("different seeds produce different sequences", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it("always produces values in [0, 1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 1000; i += 1) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("randInt", () => {
  it("is deterministic for a given seed", () => {
    const values1 = Array.from({ length: 50 }, () => 0);
    const values2 = Array.from({ length: 50 }, () => 0);
    const rng1 = mulberry32(99);
    const rng2 = mulberry32(99);
    for (let i = 0; i < 50; i += 1) {
      values1[i] = randInt(rng1, 0, 100);
      values2[i] = randInt(rng2, 0, 100);
    }
    expect(values1).toEqual(values2);
  });

  it("stays within [min, max] inclusive", () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 500; i += 1) {
      const v = randInt(rng, 3, 8);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(8);
    }
  });

  it("throws when max < min", () => {
    const rng = mulberry32(1);
    expect(() => randInt(rng, 5, 1)).toThrow();
  });
});

describe("pick", () => {
  it("only ever returns elements of the input array, deterministically", () => {
    const items = ["a", "b", "c", "d"];
    const rng1 = mulberry32(123);
    const rng2 = mulberry32(123);
    const picks1 = Array.from({ length: 30 }, () => pick(rng1, items));
    const picks2 = Array.from({ length: 30 }, () => pick(rng2, items));
    expect(picks1).toEqual(picks2);
    for (const p of picks1) {
      expect(items).toContain(p);
    }
  });

  it("throws on an empty array", () => {
    const rng = mulberry32(1);
    expect(() => pick(rng, [])).toThrow();
  });
});

describe("shuffle", () => {
  it("is a deterministic permutation of the input for a given seed", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const rng1 = mulberry32(55);
    const rng2 = mulberry32(55);
    const shuffled1 = shuffle(rng1, items);
    const shuffled2 = shuffle(rng2, items);
    expect(shuffled1).toEqual(shuffled2);
    expect([...shuffled1].sort()).toEqual([...items].sort());
  });

  it("does not mutate the input array", () => {
    const items = [1, 2, 3];
    const rng = mulberry32(1);
    const copy = [...items];
    shuffle(rng, items);
    expect(items).toEqual(copy);
  });
});

describe("chance", () => {
  it("p=0 never fires, p=1 always fires", () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 50; i += 1) {
      expect(chance(rng, 0)).toBe(false);
    }
    const rng2 = mulberry32(1);
    for (let i = 0; i < 50; i += 1) {
      expect(chance(rng2, 1)).toBe(true);
    }
  });
});
