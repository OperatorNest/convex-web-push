// Serializes access to the anonymous local Convex backend across sibling repos.
// Usage: node scripts/with-local-lock.mjs <command> [...args]
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const LOCK_DIR = join(tmpdir(), "operatornest-convex-local.lock");
const OWNER_FILE = join(LOCK_DIR, "owner");
const RETRY_MS = 2_000;
const WAIT_MS = 30 * 60_000;
const HEARTBEAT_MS = 30_000;
const STALE_MS = 3 * 60_000;

function readOwner() {
  try {
    return readFileSync(OWNER_FILE, "utf8");
  } catch {
    return undefined;
  }
}

// The lock directory only ever appears with its owner file inside (atomic rename),
// so its mtime, refreshed by the heartbeat, is the liveness signal.
function isStale() {
  try {
    return Date.now() - statSync(LOCK_DIR).mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

function tryCreate(token) {
  const staging = mkdtempSync(join(tmpdir(), "operatornest-convex-local-"));
  writeFileSync(join(staging, "owner"), token);
  try {
    renameSync(staging, LOCK_DIR);
    return true;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") return false;
    throw error;
  }
}

function reclaimIfStale(staleOwner) {
  // Only remove the lock if it still belongs to the process we judged stale.
  if (staleOwner !== undefined && readOwner() === staleOwner && isStale()) {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

/** Acquires the shared lock and returns a release function. */
export async function acquireLock() {
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + WAIT_MS;
  while (!tryCreate(token)) {
    if (isStale()) {
      reclaimIfStale(readOwner());
      continue;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${LOCK_DIR}`);
    await sleep(RETRY_MS);
  }
  const heartbeat = setInterval(() => {
    if (readOwner() !== token) return;
    const now = new Date();
    utimesSync(LOCK_DIR, now, now);
  }, HEARTBEAT_MS);
  heartbeat.unref();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    if (readOwner() === token) rmSync(LOCK_DIR, { recursive: true, force: true });
  };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error("Usage: node scripts/with-local-lock.mjs <command> [...args]");
    process.exit(2);
  }
  const release = await acquireLock();
  const onSignal = (signal) => {
    release();
    process.kill(process.pid, signal);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let status = 1;
  try {
    status = await run(command, args);
  } finally {
    release();
  }
  process.exit(status);
}
