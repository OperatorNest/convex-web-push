import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";

const root = resolve(import.meta.dirname, "..");
const convexBin = join(root, "node_modules/convex/bin/main.js");
const lockOwnerFile = join(tmpdir(), "operatornest-convex-local.lock", "owner");
const READY_TIMEOUT_MS = 300_000;
const STOP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;
const WAIT_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 4_000;
const DEFAULT_PATHS = ["src", "dist", "example", "package.json", "convex.json"];
const SCRUBBED_ENV_NAMES = new Set([
  "CONVEX_AGENT_MODE",
  "CONVEX_DEPLOYMENT",
  "CONVEX_DEPLOY_KEY",
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "CONVEX_URL",
  "CONVEX_SITE_URL",
]);

/**
 * Environment for every child process the smoke starts: the parent environment without the eight
 * Convex deployment-selection names, plus `CONVEX_AGENT_MODE=anonymous`.
 */
export const smokeEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !SCRUBBED_ENV_NAMES.has(name)),
  ),
  CONVEX_AGENT_MODE: "anonymous",
};

const stepResults = [];

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function tailText(text) {
  return text.slice(-OUTPUT_TAIL_CHARS);
}

/** Returns the string `code` of a `ConvexError`'s data object, else `undefined`. */
export function errorCodeOf(error) {
  if (!(error instanceof ConvexError)) return undefined;
  const { data } = error;
  return typeof data === "object" && data !== null && typeof data.code === "string"
    ? data.code
    : undefined;
}

function describeStepFailure(error) {
  return errorCodeOf(error) ?? describeError(error).split("\n", 1)[0];
}

/** Throws an `Error` with `message` when `condition` is falsy. */
export function assertSmoke(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Awaits `check()` every 250 ms until it resolves a truthy value and returns that value. Throws
 * when `timeoutMs` (default 120000) elapses first; an error thrown by `check` propagates at once.
 */
export async function waitFor(check, { timeoutMs = WAIT_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Runs one smoke step and prints `PASS <number> <name>` or `FAIL <number> <name>: <reason>`, where
 * `<reason>` is the error's `errorCodeOf` code when present, else the first line of its message.
 * A failing step sets `process.exitCode = 1` and does not throw, so later steps still run.
 */
export async function step(name, fn) {
  const label = `${String(stepResults.length + 1).padStart(2, "0")} ${name}`;
  const result = { label, isPassed: false };
  stepResults.push(result);
  try {
    await fn();
    result.isPassed = true;
    console.log(`PASS ${label}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(`FAIL ${label}: ${describeStepFailure(error)}`);
  }
}

function assertLockHeld() {
  let owner = "";
  try {
    owner = readFileSync(lockOwnerFile, "utf8");
  } catch {
    owner = "";
  }
  if (!owner.startsWith(`${process.ppid}:`))
    throw new Error("Run the smoke as: node scripts/with-local-lock.mjs node scripts/smoke.mjs");
}

async function findFreePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (address === null || typeof address === "string") throw new Error("No free local port");
  return address.port;
}

function parseJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

function parseRunOutput(stdout) {
  const lines = stdout.trim().split("\n");
  if (lines.join("") === "") return null;
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseJson(lines.slice(index).join("\n"));
    if (parsed) return parsed.value;
  }
  throw new Error(`convex run printed no JSON result: ${tailText(stdout)}`);
}

function createWorkspace(paths) {
  const packageName = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
  const workspace = mkdtempSync(join(tmpdir(), `${packageName.split("/").at(-1)}-smoke-`));
  for (const path of paths) cpSync(join(root, path), join(workspace, path), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
  return workspace;
}

function runConvexCliIn(workspace, args, input) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [convexBin, ...args], {
      cwd: workspace,
      env: smokeEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveRun(stdout);
      else reject(new Error(`convex ${args[0]} exited with ${code}: ${tailText(stderr + stdout)}`));
    });
    child.stdin.end(input);
  });
}

async function startBackend(workspace) {
  const cloudPort = await findFreePort();
  const sitePort = await findFreePort();
  const child = spawn(
    process.execPath,
    [
      convexBin,
      "dev",
      "--typecheck",
      "disable",
      "--tail-logs",
      "disable",
      "--local-cloud-port",
      String(cloudPort),
      "--local-site-port",
      String(sitePort),
    ],
    { cwd: workspace, env: smokeEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const collectOutput = (chunk) => {
    output += chunk.toString();
  };
  child.stdout.on("data", collectOutput);
  child.stderr.on("data", collectOutput);
  const isRunning = () => child.exitCode === null && child.signalCode === null;
  const stop = async () => {
    if (!isRunning()) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      sleep(STOP_TIMEOUT_MS),
    ]);
    if (isRunning()) child.kill("SIGKILL");
  };
  const kill = () => {
    if (isRunning()) child.kill("SIGKILL");
  };
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!output.includes("Convex functions ready")) {
    if (!isRunning() || Date.now() > deadline) {
      await stop();
      throw new Error(`convex dev did not become ready: ${tailText(output)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const config = JSON.parse(
    readFileSync(join(workspace, ".convex/local/default/config.json"), "utf8"),
  );
  return { url: `http://127.0.0.1:${config.ports.cloud}`, adminKey: config.adminKey, stop, kill };
}

function printSummary() {
  const failed = stepResults.filter((result) => !result.isPassed);
  console.log(
    `\nSmoke summary: ${stepResults.length - failed.length} passed, ${failed.length} failed`,
  );
  for (const result of failed) console.log(`FAIL ${result.label}`);
  if (stepResults.length === 0) {
    process.exitCode = 1;
    console.error("No smoke step ran.");
  }
}

/**
 * Runs a smoke journey against an anonymous local Convex backend.
 *
 * Requires `node scripts/with-local-lock.mjs` to hold the local backend lock for this process.
 * Builds the package, copies `paths` (default `src`, `dist`, `example`, `package.json`,
 * `convex.json`) into a temporary workspace with a `node_modules` link, awaits
 * `prepareWorkspace(workspace)` so a journey can change files before the first deploy runs crons,
 * starts `convex dev` on free ports and calls `journey(backend)`. `backend` has:
 * - `url`, `adminKey` and `client`, a `ConvexHttpClient` with admin auth;
 * - `workspace`, the temporary directory;
 * - `runConvexCli(args, input?)`, which runs the Convex CLI in the workspace and resolves stdout;
 * - `runFunction(name, args?, { component }?)`, which runs `convex run` and resolves the parsed result;
 * - `setEnvironmentVariable(name, value)`, which passes `value` through stdin, never argv.
 * Always stops the backend, deletes the workspace and prints the step summary. Sets
 * `process.exitCode = 1` when setup or `journey` throws, when a step fails or when no step ran.
 */
export async function runSmoke(
  journey,
  { paths = DEFAULT_PATHS, prepareWorkspace = async () => {} } = {},
) {
  let workspace;
  let backend;
  const removeWorkspace = () => {
    if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
  };
  const teardownNow = () => {
    backend?.kill();
    removeWorkspace();
  };
  const exitOnSignal = (signal) => {
    teardownNow();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("exit", teardownNow);
  process.once("SIGINT", exitOnSignal);
  process.once("SIGTERM", exitOnSignal);
  try {
    assertLockHeld();
    execFileSync("pnpm", ["build"], { cwd: root, env: smokeEnv, stdio: "inherit" });
    workspace = createWorkspace(paths);
    await prepareWorkspace(workspace);
    backend = await startBackend(workspace);
    const client = new ConvexHttpClient(backend.url, { logger: false });
    client.setAdminAuth(backend.adminKey);
    const runConvexCli = (args, input) => runConvexCliIn(workspace, args, input);
    await journey({
      url: backend.url,
      adminKey: backend.adminKey,
      client,
      workspace,
      runConvexCli,
      runFunction: async (name, args = {}, { component } = {}) =>
        parseRunOutput(
          await runConvexCli([
            "run",
            ...(component === undefined ? [] : ["--component", component]),
            name,
            JSON.stringify(args),
          ]),
        ),
      setEnvironmentVariable: async (name, value) => {
        await runConvexCli(["env", "set", name], value);
      },
    });
  } catch (error) {
    process.exitCode = 1;
    console.error(`Smoke setup or journey failed: ${describeError(error)}`);
  } finally {
    await backend?.stop();
    removeWorkspace();
    process.off("SIGINT", exitOnSignal);
    process.off("SIGTERM", exitOnSignal);
    printSummary();
  }
}
