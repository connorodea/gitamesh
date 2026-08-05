import type { OutputSink } from "../../src/output.js";

export function createFakeSink(): OutputSink & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (line: string) => logs.push(line),
    error: (line: string) => errors.push(line),
  };
}
