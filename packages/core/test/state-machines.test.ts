import { describe, expect, it } from "vitest";
import {
  canTransitionTask,
  canTransitionAttempt,
  canTransitionAgent,
  canTransitionIntegration,
  isTerminalTaskState,
} from "../src/state-machines.js";

describe("state machines", () => {
  it("allows the canonical happy-path task walk", () => {
    expect(canTransitionTask("pending", "queued")).toBe(true);
    expect(canTransitionTask("queued", "claiming")).toBe(true);
    expect(canTransitionTask("claiming", "running")).toBe(true);
    expect(canTransitionTask("running", "completed")).toBe(true);
  });

  it("rejects completed -> running", () => {
    expect(canTransitionTask("completed", "running")).toBe(false);
  });

  it("treats completed/cancelled/dead_letter as terminal", () => {
    expect(isTerminalTaskState("completed")).toBe(true);
    expect(isTerminalTaskState("cancelled")).toBe(true);
    expect(isTerminalTaskState("dead_letter")).toBe(true);
    expect(isTerminalTaskState("pending")).toBe(false);
  });

  it("allows running -> blocked -> running", () => {
    expect(canTransitionTask("running", "blocked")).toBe(true);
    expect(canTransitionTask("blocked", "running")).toBe(true);
  });

  it("allows any non-terminal task state to escalate to dead_letter", () => {
    for (const state of [
      "pending",
      "queued",
      "claiming",
      "running",
      "blocked",
      "awaiting_approval",
      "failed",
    ] as const) {
      expect(canTransitionTask(state, "dead_letter")).toBe(true);
    }
  });

  it("attempt machine rejects completed -> running", () => {
    expect(canTransitionAttempt("completed", "running")).toBe(false);
  });

  it("attempt machine allows created -> leased -> running -> completed", () => {
    expect(canTransitionAttempt("created", "leased")).toBe(true);
    expect(canTransitionAttempt("leased", "running")).toBe(true);
    expect(canTransitionAttempt("running", "completed")).toBe(true);
  });

  it("agent machine has revoked as a true terminal state", () => {
    expect(canTransitionAgent("revoked", "online")).toBe(false);
    expect(canTransitionAgent("registered", "revoked")).toBe(true);
  });

  it("integration machine allows retry from failed back to queued", () => {
    expect(canTransitionIntegration("failed", "queued")).toBe(true);
    expect(canTransitionIntegration("integrated", "queued")).toBe(false);
  });
});
