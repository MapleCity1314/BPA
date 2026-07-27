import { homedir } from "node:os";
import { join } from "node:path";

export interface BpaPaths {
  root: string;
  data: string;
  logs: string;
  socket: string;
  database: string;
  signingKey: string;
  lock: string;
}

export function resolveBpaPaths(
  root =
    process.env.BPA_HOME ??
    join(homedir(), "Library", "Application Support", "BPA")
): BpaPaths {
  const data = join(root, "data");
  return {
    root,
    data,
    logs: join(homedir(), "Library", "Logs", "BPA"),
    socket: join(root, "run", "core.sock"),
    database: join(data, "bpa.sqlite"),
    signingKey: join(data, "core-signing-key.pem"),
    lock: join(root, "run", "core.lock")
  };
}
