import type { FastifyReply } from "fastify";
import { GitameshError } from "@gitamesh/protocol";

/** Sends any thrown error as an RFC 9457 problem-details response. */
export function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof GitameshError) {
    return reply
      .code(error.status)
      .type("application/problem+json")
      .send(error.toProblemDetails());
  }
  // Unexpected error — do not leak internals, but still respond in the
  // same envelope shape for consistency.
  const err = error as Error;
  return reply
    .code(500)
    .type("application/problem+json")
    .send({
      type: "https://gitamesh.dev/problems/internal-error",
      title: "Internal Server Error",
      status: 500,
      detail: err?.message ?? "Unknown error",
    });
}
