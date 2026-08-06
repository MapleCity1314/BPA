import { join } from "node:path";
import {
  resolveDefaultBpaHome,
  resolveDefaultBpaLogRoot,
  resolveLocalIpcEndpoint
} from "@bpa/platform-runtime";

export interface BpaPaths {
  root: string;
  run: string;
  data: string;
  logs: string;
  socket: string;
  transferSocket: string;
  database: string;
  signingKey: string;
  lock: string;
  resourceMetrics: string;
}

export function resolveBpaPaths(
  root = resolveDefaultBpaHome(
    process.env.BPA_HOME ? { bpaHome: process.env.BPA_HOME } : {}
  ),
  platform: NodeJS.Platform = process.platform
): BpaPaths {
  const data = join(root, "data");
  const run = join(root, "run");
  return {
    root,
    run,
    data,
    logs: resolveDefaultBpaLogRoot({
      bpaHome: root,
      platform
    }),
    socket: resolveLocalIpcEndpoint(root, "core", platform),
    transferSocket: resolveLocalIpcEndpoint(root, "staging", platform),
    database: join(data, "bpa.sqlite"),
    signingKey: join(data, "core-signing-key.pem"),
    lock: join(run, "core.lock"),
    resourceMetrics: join(run, "runtime-resource-metrics.json")
  };
}
