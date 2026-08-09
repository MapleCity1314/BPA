import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ControlClient,
  resolveControlSocketPath,
  UnixSocketControlTransport
} from "@bpa/control-client";
import { UdsControlBackend } from "./control-backend.js";
import { startConsoleHost } from "./server.js";
import { UnixSocketStagingUploader } from "./staging-uploader.js";

const appRoot =
  process.env.BPA_CONSOLE_STATIC_ROOT ??
  resolve(fileURLToPath(new URL("../../operator-console/dist", import.meta.url)));

const socketPath =
  process.env.BPA_SOCKET?.trim() || resolveControlSocketPath();
const configuredAccessMode = process.env.BPA_CONSOLE_ACCESS_MODE?.trim();
if (
  configuredAccessMode !== undefined &&
  configuredAccessMode !== "operator" &&
  configuredAccessMode !== "viewer"
) {
  throw new Error("BPA_CONSOLE_ACCESS_MODE must be operator or viewer");
}
const accessMode = configuredAccessMode ?? "operator";
const controlClient = new ControlClient(
  new UnixSocketControlTransport(socketPath, {
    runtime: { name: "bpa-console-host", version: "0.6.1" },
    features: ["operator-console", "staging-lease", "trusted-evidence"]
  })
);
const handle = await startConsoleHost({
  backend: new UdsControlBackend(controlClient, {
    ...(process.env.BPA_ACTOR_ID?.trim()
      ? { actorId: process.env.BPA_ACTOR_ID.trim() }
      : {}),
    stagingUploader: new UnixSocketStagingUploader()
  }),
  staticRoot: appRoot,
  accessMode
});

process.stdout.write(`${handle.launchUrl}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
