import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const runtimeBin = dirname(fileURLToPath(import.meta.url));
const installRoot = process.env.BPA_HOME?.trim();
if (!installRoot) {
  throw new Error("BPA_HOME is required to start BPA Core");
}

const logRoot = join(installRoot, "logs");
mkdirSync(logRoot, { recursive: true });
const stdout = openSync(join(logRoot, "core.out.log"), "a");
const stderr = openSync(join(logRoot, "core.err.log"), "a");
const entryPoint = join(runtimeBin, "bpa-core.js");
let child;
try {
  child = spawn(process.execPath, [entryPoint], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", stdout, stderr],
    env: process.env
  });
} finally {
  closeSync(stdout);
  closeSync(stderr);
}

const runtimeIdentity = process.env.BPA_RUNTIME_ID?.trim();
const lockPath = join(installRoot, "run", "core.lock");
const normalizePath = (value) =>
  resolve(value).replaceAll("\\", "/").toLowerCase();
const expectedExecutable = normalizePath(process.execPath);
const expectedEntryPoint = normalizePath(entryPoint);
const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

let ready = false;
for (let attempt = 0; attempt < 50; attempt += 1) {
  if (child.exitCode !== null) break;
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    ready =
      lock?.version === 1 &&
      lock.pid === child.pid &&
      lock.runtimeIdentity === runtimeIdentity &&
      normalizePath(lock.executablePath) === expectedExecutable &&
      normalizePath(lock.entryPointPath) === expectedEntryPoint;
    if (ready) break;
  } catch {
    // A missing or partially written lock remains pending until the bounded
    // startup deadline. No unrelated process is accepted as readiness.
  }
  await delay(100);
}

if (!ready) {
  if (child.exitCode === null) {
    child.kill();
    for (
      let attempt = 0;
      attempt < 20 && child.exitCode === null;
      attempt += 1
    ) {
      await delay(100);
    }
  }
  throw new Error("BPA Core did not publish a matching identity lock in time");
}
child.unref();
