import { z } from "zod";
import type { DaemonResult } from "./internal-client.js";

/**
 * Every tool in this package returns a discriminated `{ ok: true, ... } |
 * { ok: false, error }` shape rather than throwing. This is the spec's own
 * requirement ("MCP tool responses must be structured and schema
 * validated" / "never throw an opaque error to the calling agent") applied
 * uniformly to every tool, not only `gitamesh_claim_task`'s 409 case: a
 * 404, a network-unreachable daemon, or a validation failure all become a
 * structured `ok: false` result an AI agent can branch on, instead of a
 * thrown exception that would need its own out-of-band handling in every
 * caller.
 */
export const ToolErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    /** Machine-readable category: an RFC 9457 `type` URI from the daemon,
     * or one of this package's own synthetic types (`unreachable`,
     * `invalid-input`, `not-supported`). */
    type: z.string(),
    title: z.string().optional(),
    status: z.number().int().optional(),
    detail: z.string().optional(),
  }),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

export function unreachableError(detail: string): ToolError {
  return {
    ok: false,
    error: { type: "https://gitamesh.dev/mcp-problems/daemon-unreachable", detail },
  };
}

export function daemonProblemError(status: number, problem: {
  type?: string;
  title?: string;
  detail?: string;
}): ToolError {
  return {
    ok: false,
    error: {
      type: problem.type ?? "https://gitamesh.dev/problems/unknown",
      title: problem.title,
      status,
      detail: problem.detail,
    },
  };
}

export function invalidInputError(detail: string): ToolError {
  return {
    ok: false,
    error: { type: "https://gitamesh.dev/mcp-problems/invalid-input", detail },
  };
}

/**
 * Runs `onSuccess` against a successful `DaemonResult`'s data, or converts
 * any daemon-level failure (network-unreachable or a non-2xx response,
 * including 409 conflicts) into a structured `ToolError`. This is the one
 * place every tool funnels its daemon call through so the "never throw"
 * contract is enforced in a single spot rather than re-implemented per
 * tool.
 */
export function fromDaemonResult<T, R>(
  result: DaemonResult<T>,
  onSuccess: (data: T) => R,
): R | ToolError {
  if (result.ok) {
    return onSuccess(result.data);
  }
  if (result.unreachable) {
    return unreachableError(result.detail);
  }
  return daemonProblemError(result.status, result.problem);
}
