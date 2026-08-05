import { validateResourceKey } from "@gitamesh/core";
import { GitameshError } from "@gitamesh/protocol";
import { buildSimTask, syntheticAgentIds } from "../fixtures.js";
import { describeError } from "./error-detail.js";
import { makeTimeline } from "./types.js";
import type { Scenario, ScenarioContext, ScenarioResult } from "./types.js";

/**
 * Scenario 10: path traversal / symlink escape attempts.
 *
 * `packages/core/src/resource-keys.ts`'s `validateResourceKey` is the
 * lexical, filesystem-free half of this defense (rejects absolute
 * paths, `..` traversal, NUL bytes; canonicalizes equivalent forms). The
 * filesystem-aware half (resolving an on-disk symlink that lexically
 * looks safe but escapes the repo root) is `packages/git-adapter`'s
 * `resolveAndValidateResourceKey`, which needs a real worktree — out of
 * scope for this protocol/engine-level simulator, exactly as
 * `docs/adr/0001-protocol-first-storage-agnostic-core.md` documents.
 *
 * What IS in scope and genuinely exercised here: a batch of malicious
 * resource keys (`../../etc/passwd`, `/etc/passwd`, `a/../../b`, a
 * NUL-byte key, `~/secrets`) fed both directly to `validateResourceKey`
 * AND through `engine.claimTask`'s `requiredResources`, proving the
 * engine's claim path rejects them BEFORE acquiring anything — plus a
 * batch of legitimate keys (including lexically-equivalent forms like
 * `./src/file.ts`) proving they are accepted and canonicalized.
 */
const MALICIOUS_KEYS = [
  "../../etc/passwd",
  "/etc/passwd",
  "a/../../b",
  "src/\0evil",
  "~/secrets",
  "..\\..\\windows\\system32",
];

const LEGITIMATE_KEYS: Array<{ input: string; expectedCanonical: string }> = [
  { input: "src/file.ts", expectedCanonical: "src/file.ts" },
  { input: "./src/file.ts", expectedCanonical: "src/file.ts" },
  { input: "src//file.ts", expectedCanonical: "src/file.ts" },
];

export const pathTraversalSymlinkScenario: Scenario = {
  name: "path-traversal-symlink",
  title: "Path traversal / symlink escape attempts",
  description:
    "Malicious resource keys must be rejected lexically before any claim is acquired; legitimate keys must canonicalize correctly.",
  run(ctx: ScenarioContext): ScenarioResult {
    const { entries, record } = makeTimeline();
    const repositoryId = "repo_path_traversal";
    const agentId = syntheticAgentIds(ctx.agentCount)[0]!;

    let maliciousRejectedDirect = 0;
    for (const key of MALICIOUS_KEYS) {
      try {
        validateResourceKey(key);
        record({
          action: "validateResourceKey (direct)",
          outcome: "error",
          detail: `UNEXPECTED: malicious key "${JSON.stringify(key)}" was accepted`,
        });
      } catch (error) {
        if (error instanceof GitameshError && error.status === 400) {
          maliciousRejectedDirect += 1;
          record({
            action: "validateResourceKey (direct)",
            outcome: "ok",
            detail: `correctly rejected "${JSON.stringify(key)}": ${error.detail}`,
          });
        } else {
          record({
            action: "validateResourceKey (direct)",
            outcome: "error",
            detail: `unexpected error type for "${JSON.stringify(key)}": ${describeError(error)}`,
          });
        }
      }
    }

    let maliciousRejectedViaClaim = 0;
    MALICIOUS_KEYS.forEach((key, i) => {
      const task = buildSimTask({
        taskId: `task_traversal_malicious_${i}`,
        repositoryId,
        workflowId: "wf_path_traversal",
        title: `Malicious claim attempt ${i}`,
      });
      ctx.storage.saveTask(task);
      try {
        ctx.engine.claimTask({
          taskId: task.task_id,
          agentId,
          workspaceSessionId: `ws-${agentId}`,
          requiredResources: [
            { resourceType: "path", resourceKey: key, mode: "write" },
          ],
        });
        record({
          action: "claimTask with malicious resourceKey",
          taskId: task.task_id,
          outcome: "error",
          detail: `UNEXPECTED: claim with "${JSON.stringify(key)}" succeeded`,
        });
      } catch (error) {
        if (error instanceof GitameshError && error.status === 400) {
          maliciousRejectedViaClaim += 1;
          record({
            action: "claimTask with malicious resourceKey",
            taskId: task.task_id,
            outcome: "ok",
            detail: `correctly rejected before acquiring anything: "${JSON.stringify(key)}"`,
          });
        } else {
          record({
            action: "claimTask with malicious resourceKey",
            taskId: task.task_id,
            outcome: "error",
            detail: `unexpected error type for "${JSON.stringify(key)}": ${describeError(error)}`,
          });
        }
      }
      // Task must remain untouched — the claim never got past validation.
      const after = ctx.storage.getTask(task.task_id);
      if (after?.status !== "pending") {
        record({
          action: "post-check: task status after rejected claim",
          taskId: task.task_id,
          outcome: "error",
          detail: `expected status "pending", got "${after?.status}"`,
        });
      }
    });

    let legitimateAccepted = 0;
    for (const { input, expectedCanonical } of LEGITIMATE_KEYS) {
      const canonical = validateResourceKey(input);
      const ok = canonical === expectedCanonical;
      if (ok) legitimateAccepted += 1;
      record({
        action: "validateResourceKey (legitimate)",
        outcome: ok ? "ok" : "error",
        detail: `"${input}" -> "${canonical}" (expected "${expectedCanonical}")`,
      });
    }

    const pass =
      maliciousRejectedDirect === MALICIOUS_KEYS.length &&
      maliciousRejectedViaClaim === MALICIOUS_KEYS.length &&
      legitimateAccepted === LEGITIMATE_KEYS.length;

    return {
      name: "path-traversal-symlink",
      title: "Path traversal / symlink escape attempts",
      status: pass ? "pass" : "fail",
      reason: pass
        ? `All ${MALICIOUS_KEYS.length} malicious keys rejected both directly and via claimTask; all ${LEGITIMATE_KEYS.length} legitimate keys canonicalized correctly. (Filesystem-level symlink escape is out of scope here — see packages/git-adapter's resolveAndValidateResourceKey.)`
        : `malicious rejected direct=${maliciousRejectedDirect}/${MALICIOUS_KEYS.length}, via claim=${maliciousRejectedViaClaim}/${MALICIOUS_KEYS.length}, legitimate accepted=${legitimateAccepted}/${LEGITIMATE_KEYS.length}.`,
      timeline: entries,
    };
  },
};
