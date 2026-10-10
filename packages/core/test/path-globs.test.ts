import { describe, expect, it } from "vitest";
import { GitameshError } from "@gitamesh/protocol";
import { canonicalizePathGlob, pathGlobsOverlap } from "../src/path-globs.js";

describe("canonicalizePathGlob", () => {
  it("normalizes ./, duplicate and trailing slashes", () => {
    expect(canonicalizePathGlob("./src//app/")).toBe("src/app");
    expect(canonicalizePathGlob(" src/**/*.ts ")).toBe("src/**/*.ts");
  });

  it.each(["", "   ", "/etc/passwd", "src/../secrets", ".", "./"])(
    "rejects %j",
    (raw) => {
      expect(() => canonicalizePathGlob(raw)).toThrow(GitameshError);
    },
  );
});

describe("pathGlobsOverlap", () => {
  it.each([
    // plain vs plain: hierarchical, at segment boundaries
    ["src/app.ts", "src/app.ts", true],
    ["src", "src/app.ts", true],
    ["src", "src2/app.ts", false],
    ["src/a.ts", "src/b.ts", false],
    // plain vs glob
    ["src/app.ts", "src/*.ts", true],
    ["src/app.ts", "**/*.ts", true],
    ["src", "src/**", true],
    ["docs/readme.md", "src/**", false],
    ["src", "src2/*.ts", false],
    // glob vs glob
    ["src/**", "src/api/**", true],
    ["src/**", "docs/**", false],
    ["src/*.ts", "src/*.md", false],
    ["**/*.ts", "src/**", true],
    ["packages/cli/**", "packages/core/**", false],
    ["**", "anything/at/all.txt", true],
  ])("%s vs %s -> %s", (a, b, expected) => {
    expect(pathGlobsOverlap(a, b)).toBe(expected);
    expect(pathGlobsOverlap(b, a)).toBe(expected);
  });
});
