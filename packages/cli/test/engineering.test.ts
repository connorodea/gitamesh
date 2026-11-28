import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { createFakeSink } from "./support/fake-sink.js";

describe("gitamesh engineering", () => {
  it.each(["", "doctor", "status", "plan", "next", "audit", "run", "verify", "reconcile"])(
    "shows help for engineering %s without adapter configuration",
    async (command) => {
      const sink = createFakeSink();
      const code = await runCli(
        ["node", "gitamesh", "engineering", ...(command ? [command] : []), "--help"],
        { cwd: process.cwd(), env: {}, sink },
      );
      expect(code).toBe(0);
      expect(sink.logs.join("\n")).toContain(`Usage: gitamesh engineering${command ? ` ${command}` : ""}`);
      expect(sink.errors).toEqual([]);
    },
  );
});
