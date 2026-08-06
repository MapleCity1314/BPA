import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === "--lock") options.lockPath = value;
    else if (argument === "--pid") options.pid = Number(value);
    else if (argument === "--identity") options.runtimeIdentity = value;
    else if (argument === "--executable") options.executablePath = value;
    else if (argument === "--entrypoint") options.entryPointPath = value;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function validPath(value) {
  return typeof value === "string" && value.length > 0 && resolve(value) === value;
}

export function verifyCoreProcessIdentity(options) {
  if (!options.lockPath || !Number.isSafeInteger(options.pid) || options.pid <= 0) {
    throw new Error("Core identity verification requires a lock and positive PID");
  }
  const lock = JSON.parse(readFileSync(options.lockPath, "utf8"));
  if (
    lock?.version !== 1 ||
    lock.pid !== options.pid ||
    typeof lock.instanceToken !== "string" ||
    lock.instanceToken.length < 16 ||
    !validPath(lock.executablePath) ||
    !validPath(lock.entryPointPath)
  ) {
    throw new Error("Core identity lock is invalid or belongs to another PID");
  }
  if (
    options.runtimeIdentity !== undefined &&
    lock.runtimeIdentity !== options.runtimeIdentity
  ) {
    throw new Error("Core runtime identity does not match the expected release");
  }
  if (
    options.executablePath !== undefined &&
    resolve(options.executablePath) !== resolve(lock.executablePath)
  ) {
    throw new Error("Core executable path does not match the expected release");
  }
  if (
    options.entryPointPath !== undefined &&
    resolve(options.entryPointPath) !== resolve(lock.entryPointPath)
  ) {
    throw new Error("Core entrypoint path does not match the expected release");
  }
  process.kill(options.pid, 0);
  const command = execFileSync(
    "ps",
    ["-p", String(options.pid), "-o", "command="],
    { encoding: "utf8" }
  ).trim();
  if (
    !command.includes(lock.executablePath) ||
    !command.includes(lock.entryPointPath)
  ) {
    throw new Error("Live process command does not match the Core identity lock");
  }
  return {
    pid: lock.pid,
    runtimeIdentity: lock.runtimeIdentity ?? null,
    executablePath: lock.executablePath,
    entryPointPath: lock.entryPointPath
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = verifyCoreProcessIdentity(parseArguments(process.argv.slice(2)));
  process.stdout.write(
    `${JSON.stringify({
      status: "verified",
      pid: result.pid,
      runtimeIdentity: result.runtimeIdentity
    })}\n`
  );
}
