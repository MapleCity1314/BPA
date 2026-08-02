import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
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
try {
  const child = spawn(process.execPath, [join(runtimeBin, "bpa-core.js")], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", stdout, stderr],
    env: process.env
  });
  child.unref();
} finally {
  closeSync(stdout);
  closeSync(stderr);
}
