import { join } from "node:path";

export function resolveSqliteObservabilityExtension(
  platform = process.platform,
  architecture = process.arch
) {
  const target = `${platform}-${architecture}`;
  if (target !== "darwin-arm64") {
    return { status: "not_supported", target };
  }
  return {
    status: "available",
    target,
    extensionPath: join(
      import.meta.dirname,
      "dist/bpa_sqlite_observability.dylib"
    )
  };
}
