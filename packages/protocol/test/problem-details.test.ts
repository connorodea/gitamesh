import { describe, expect, it } from "vitest";
import {
  GitameshError,
  taskAlreadyClaimed,
  resourceConflict,
  staleAttemptToken,
  invalidStateTransition,
} from "../src/problem-details.js";

describe("problem-details", () => {
  it("produces an RFC 9457-shaped error with a stable type URI", () => {
    const err = taskAlreadyClaimed({ taskId: "task_1" });
    expect(err).toBeInstanceOf(GitameshError);
    expect(err.status).toBe(409);
    expect(err.type).toBe(
      "https://gitamesh.dev/problems/task-already-claimed",
    );
    expect(err.toProblemDetails()).toMatchObject({
      type: err.type,
      title: err.title,
      status: 409,
    });
  });

  it("resourceConflict carries the conflicting key in extensions", () => {
    const err = resourceConflict({
      resourceKey: "src/a.ts",
      mode: "write",
      conflictingResourceKey: "src",
    });
    expect(err.extensions?.conflicting_resource_key).toBe("src");
  });

  it("staleAttemptToken is a 409 distinct from invalidStateTransition's 422", () => {
    const stale = staleAttemptToken({ attemptId: "a1" });
    const invalid = invalidStateTransition({
      entity: "Task",
      entityId: "t1",
      from: "completed",
      to: "running",
    });
    expect(stale.status).toBe(409);
    expect(invalid.status).toBe(422);
  });
});
