import { join } from "node:path";

export const macosArm64ExtensionPath = join(
  import.meta.dirname,
  "dist/bpa_sqlite_observability.dylib"
);
