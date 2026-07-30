import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startConsoleHost } from "./server.js";
import { UnavailableControlBackend } from "./unavailable-backend.js";

const appRoot =
  process.env.BPA_CONSOLE_STATIC_ROOT ??
  resolve(fileURLToPath(new URL("../../operator-console/dist", import.meta.url)));

const handle = await startConsoleHost({
  backend: new UnavailableControlBackend(),
  staticRoot: appRoot
});

process.stdout.write(`${handle.launchUrl}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
