#!/usr/bin/env node
import { runSimulatorCli } from "../cli.js";

process.exitCode = runSimulatorCli(process.argv.slice(2));
