#!/usr/bin/env node
import { runCli } from "../dist/shared/cli.js";

const result = await runCli(process.argv.slice(2));
if (result.stdout) console.log(result.stdout.trimEnd());
if (result.stderr) console.error(result.stderr.trimEnd());
process.exitCode = result.code;
