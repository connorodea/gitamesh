import type { FetchLike } from "./internal-client.js";

/** Bound new context reads without changing existing coordination writes. */
export function createKnowledgeFetch(
  fetchImpl: FetchLike = fetch,
  timeoutMs = 5_000,
  maxBytes = 1_048_576,
): FetchLike {
  return async (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await fetchImpl(input, { ...init, signal });
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error("Coordination response exceeded the context read limit.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return new Response(Buffer.concat(chunks), {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  };
}
