import { describe, expect, it } from "vitest";
import { validateResourceKey, claimsConflict, pathsOverlap } from "../src/resource-keys.js";
import { GitameshError } from "@gitamesh/protocol";

describe("validateResourceKey", () => {
  it("canonically normalizes equivalent paths (invariant #4)", () => {
    expect(validateResourceKey("./src/file.ts")).toBe(
      validateResourceKey("src/file.ts"),
    );
    expect(validateResourceKey("src//file.ts")).toBe("src/file.ts");
    expect(validateResourceKey("./src/./file.ts")).toBe("src/file.ts");
  });

  it("rejects absolute paths, traversal, and NUL bytes (invariant #5)", () => {
    expect(() => validateResourceKey("/etc/passwd")).toThrow(GitameshError);
    expect(() => validateResourceKey("../../etc/passwd")).toThrow(
      GitameshError,
    );
    expect(() => validateResourceKey("src/../../etc/passwd")).toThrow(
      GitameshError,
    );
    expect(() => validateResourceKey("src/\0file")).toThrow(GitameshError);
    expect(() => validateResourceKey("C:\\Windows\\System32")).toThrow(
      GitameshError,
    );
  });

  it("rejects empty keys", () => {
    expect(() => validateResourceKey("")).toThrow(GitameshError);
    expect(() => validateResourceKey(".")).toThrow(GitameshError);
  });
});

describe("hierarchical path overlap (invariant #3)", () => {
  it("src overlaps src/file.ts but not src2", () => {
    expect(pathsOverlap("src", "src/file.ts")).toBe(true);
    expect(pathsOverlap("src", "src2")).toBe(false);
    expect(pathsOverlap("src2", "src")).toBe(false);
  });
});

describe("claimsConflict (invariant #6)", () => {
  it("read/read on the same or overlapping path never conflicts", () => {
    expect(claimsConflict("src/file.ts", "read", "src/file.ts", "read")).toBe(
      false,
    );
    expect(claimsConflict("src", "read", "src/file.ts", "read")).toBe(false);
  });

  it("write/read, write/write, and exclusive/anything on overlapping paths conflict", () => {
    expect(claimsConflict("src/file.ts", "write", "src/file.ts", "read")).toBe(
      true,
    );
    expect(
      claimsConflict("src/file.ts", "write", "src/file.ts", "write"),
    ).toBe(true);
    expect(
      claimsConflict("src/file.ts", "exclusive", "src/file.ts", "read"),
    ).toBe(true);
    expect(
      claimsConflict("src/file.ts", "exclusive", "src/file.ts", "exclusive"),
    ).toBe(true);
  });

  it("non-overlapping paths never conflict regardless of mode", () => {
    expect(claimsConflict("src", "write", "src2", "write")).toBe(false);
    expect(claimsConflict("a/b", "exclusive", "a/c", "exclusive")).toBe(false);
  });
});
