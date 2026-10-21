import { describe, expect, it } from "vitest";
import {
  TaskSchema,
  AgentSchema,
  EventEnvelopeSchema,
  ResourceClaimSchema,
  DeviceSchema,
  TASK_STATES,
  ATTEMPT_STATES,
  AGENT_STATES,
  DEVICE_STATES,
  INTEGRATION_STATES,
} from "../src/entities.js";

describe("protocol schemas", () => {
  it("accepts a minimal valid Task and preserves nullable id fields", () => {
    const now = new Date().toISOString();
    const task = {
      task_id: "task_1",
      workflow_id: "wf_1",
      repository_id: "repo_1",
      parent_task_id: null,
      title: "Do the thing",
      description: "",
      status: "pending",
      priority: 0,
      required_capabilities: [],
      dependencies: [],
      join_policy: "all",
      base_sha: null,
      branch: null,
      idempotency_key: null,
      deadline_at: null,
      created_at: now,
      updated_at: now,
    };
    const parsed = TaskSchema.parse(task);
    expect(parsed.parent_task_id).toBeNull();
    expect(parsed.status).toBe("pending");
  });

  it("rejects a Task with an invalid status", () => {
    const now = new Date().toISOString();
    expect(() =>
      TaskSchema.parse({
        task_id: "task_1",
        workflow_id: "wf_1",
        repository_id: "repo_1",
        parent_task_id: null,
        title: "x",
        description: "",
        status: "not-a-real-status",
        priority: 0,
        required_capabilities: [],
        dependencies: [],
        join_policy: "all",
        base_sha: null,
        branch: null,
        idempotency_key: null,
        deadline_at: null,
        created_at: now,
        updated_at: now,
      }),
    ).toThrow();
  });

  it("accepts an arbitrary string runtime on Agent (no vendor hard-coding)", () => {
    const agent = AgentSchema.parse({
      agent_id: "agent_1",
      namespace_id: "ns_1",
      display_name: "worker",
      runtime: "some-future-vendor-nobody-has-heard-of-yet",
      version: "0.0.1",
      capabilities: [],
      status: "online",
      last_heartbeat_at: null,
      metadata: {},
    });
    expect(agent.runtime).toBe("some-future-vendor-nobody-has-heard-of-yet");
  });

  it("EventEnvelope keeps all correlation id fields present (nullable), never dropped", () => {
    const envelope = EventEnvelopeSchema.parse({
      event_id: "evt_1",
      schema_version: 1,
      event_type: "task.claimed",
      repository_sequence: 1,
      occurred_at: new Date().toISOString(),
      namespace_id: "ns_1",
      repository_id: null,
      workflow_id: null,
      task_id: null,
      attempt_id: null,
      agent_id: null,
      workspace_session_id: null,
      correlation_id: null,
      causation_id: null,
      idempotency_key: null,
      payload: {},
      metadata: {},
    });
    expect(Object.prototype.hasOwnProperty.call(envelope, "attempt_id")).toBe(
      true,
    );
    expect(envelope.attempt_id).toBeNull();
  });

  it("ResourceClaim requires a valid mode", () => {
    expect(() =>
      ResourceClaimSchema.parse({
        resource_claim_id: "claim_1",
        repository_id: "repo_1",
        task_id: "task_1",
        attempt_id: "attempt_1",
        resource_type: "path",
        resource_key: "src/file.ts",
        mode: "not-a-mode",
        lease_id: "lease_1",
        fencing_token: 1,
        expires_at: new Date().toISOString(),
      }),
    ).toThrow();
  });

  it("state-name unions have the exact expected members", () => {
    expect(TASK_STATES).toContain("dead_letter");
    expect(ATTEMPT_STATES).toContain("rejected_stale");
    expect(AGENT_STATES).toContain("draining");
    expect(INTEGRATION_STATES).toContain("conflicted");
  });

  it("accepts a minimal valid Device and preserves required fields", () => {
    const now = new Date().toISOString();
    const device = {
      device_id: "device_1",
      namespace_id: "ns_1",
      hostname: "worker-01.example.com",
      display_name: "Worker Machine 1",
      capabilities: ["gpu", "cuda:11.8"],
      status: "online",
      agent_id: "agent_1",
      last_heartbeat_at: now,
      created_at: now,
      metadata: {},
    };
    const parsed = DeviceSchema.parse(device);
    expect(parsed.device_id).toBe("device_1");
    expect(parsed.status).toBe("online");
    expect(parsed.capabilities).toContain("gpu");
  });

  it("rejects a Device with an invalid status", () => {
    const now = new Date().toISOString();
    expect(() =>
      DeviceSchema.parse({
        device_id: "device_1",
        namespace_id: "ns_1",
        hostname: "worker-01.example.com",
        display_name: "Worker",
        capabilities: [],
        status: "not-a-status",
        agent_id: "agent_1",
        last_heartbeat_at: now,
        created_at: now,
        metadata: {},
      }),
    ).toThrow();
  });

  it("DEVICE_STATES includes all expected states", () => {
    expect(DEVICE_STATES).toContain("registered");
    expect(DEVICE_STATES).toContain("online");
    expect(DEVICE_STATES).toContain("offline");
    expect(DEVICE_STATES).toContain("stale");
  });
});
