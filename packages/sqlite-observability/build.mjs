import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = import.meta.dirname;
const require = createRequire(import.meta.url);
const packageRoot = dirname(
  realpathSync(require.resolve("better-sqlite3/package.json"))
);
const includeRoot = join(packageRoot, "deps/sqlite3");
const source = join(root, "bpa_sqlite_observability.c");
const outputRoot = join(root, "dist");
mkdirSync(outputRoot, { recursive: true });

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(
    `SQLite observability build target is unsupported: ${process.platform}-${process.arch}`
  );
}

const output = join(outputRoot, "bpa_sqlite_observability.dylib");
const reproduceRoot = mkdtempSync(
  join(tmpdir(), "bpa-sqlite-observability-build-")
);
const reproduceOutput = join(reproduceRoot, "bpa_sqlite_observability.dylib");
function compile(target) {
  execFileSync(process.env.CC?.trim() || "cc", [
    "-std=c11",
    "-O2",
    "-fPIC",
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-I",
    includeRoot,
    source,
    "-o",
    target
  ], { stdio: "inherit" });
}
compile(output);
const digest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
try {
  compile(reproduceOutput);
  if (digest(output) !== digest(reproduceOutput)) {
    throw new Error("SQLite observability bundle build is not reproducible");
  }
} finally {
  rmSync(reproduceRoot, { recursive: true, force: true });
}
const loadCommands = execFileSync("otool", ["-l", output], {
  encoding: "utf8"
});
if (loadCommands.includes("LC_ID_DYLIB")) {
  throw new Error("SQLite observability bundle must not contain an install name");
}
process.stdout.write(`${output}\n`);
