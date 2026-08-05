/**
 * Small, dependency-free output helpers shared by every command:
 * human-readable table/text by default, `--json` for machine-readable
 * output, and a uniform way to fail with a clear message + nonzero exit
 * code.
 */

export interface OutputSink {
  log(line: string): void;
  error(line: string): void;
}

export const consoleSink: OutputSink = {
  log: (line: string) => console.log(line),
  error: (line: string) => console.error(line),
};

export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export function printJson(sink: OutputSink, value: unknown): void {
  sink.log(JSON.stringify(value, null, 2));
}

/**
 * Renders an array of flat records as a simple, aligned text table. Falls
 * back to "(none)" for an empty list rather than printing an empty table.
 */
export function printTable(
  sink: OutputSink,
  columns: string[],
  rows: readonly unknown[],
): void {
  if (rows.length === 0) {
    sink.log("(none)");
    return;
  }

  const asRecord = (row: unknown): Record<string, unknown> => row as Record<string, unknown>;

  const cellText = (value: unknown): string => {
    if (value === null || value === undefined) return "-";
    if (typeof value === "boolean") return value ? "yes" : "no";
    return String(value);
  };

  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((row) => cellText(asRecord(row)[col]).length)),
  );

  const formatRow = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? cell.length)).join("  ");

  sink.log(formatRow(columns));
  sink.log(formatRow(widths.map((w) => "-".repeat(w))));
  for (const row of rows) {
    sink.log(formatRow(columns.map((col) => cellText(asRecord(row)[col]))));
  }
}

export function printCheck(sink: OutputSink, label: string, ok: boolean, detail?: string): void {
  const mark = ok ? "PASS" : "FAIL";
  const suffix = detail ? ` — ${detail}` : "";
  sink.log(`[${mark}] ${label}${suffix}`);
}
