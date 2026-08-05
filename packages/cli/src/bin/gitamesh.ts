#!/usr/bin/env node
import { runCli } from "../cli.js";
import { consoleSink } from "../output.js";

const exitCode = await runCli(process.argv, {
  cwd: process.cwd(),
  env: process.env,
  sink: consoleSink,
});
process.exitCode = exitCode;
