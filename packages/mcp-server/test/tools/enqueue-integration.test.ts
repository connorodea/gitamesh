import { describe, expect, it } from "vitest";
import {
  handleEnqueueIntegration,
  EnqueueIntegrationInputSchema,
  EnqueueIntegrationOutputSchema,
} from "../../src/tools/enqueue-integration.js";

describe("gitamesh_enqueue_integration", () => {
  it("always returns a structured, honest not-supported result (no daemon route exists yet)", () => {
    const input = EnqueueIntegrationInputSchema.parse({ taskId: "task_1", repositoryId: "repo_1" });
    const result = handleEnqueueIntegration(input);
    const parsed = EnqueueIntegrationOutputSchema.parse(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.supported).toBe(false);
    expect(parsed.reason).toContain("integration-candidate");
  });

  it("rejects malformed input via schema validation", () => {
    expect(() => EnqueueIntegrationInputSchema.parse({ repositoryId: "repo_1" })).toThrow();
  });
});
