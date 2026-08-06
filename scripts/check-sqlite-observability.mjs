import { execFileSync } from "node:child_process";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  process.stdout.write(
    `SQLite page-cache observability is not a Phase 0 target on ${process.platform}-${process.arch}; skipped.\n`
  );
  process.exit(0);
}

const pnpmCli = process.env.npm_execpath?.trim();
if (!pnpmCli) throw new Error("npm_execpath is required");
execFileSync(
  process.execPath,
  [pnpmCli, "--filter", "@bpa/sqlite-observability", "check"],
  { stdio: "inherit" }
);
