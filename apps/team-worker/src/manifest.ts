import { createHash } from "node:crypto";
import {
  TEAM_PROTOCOL_VERSION,
  teamCodeDigest
} from "@bpa/team-runtime";

export const TEAM_WORKER_VERSION = "0.1.0";

function implementationDigest(ref: string, implementation: string): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({ ref, implementation }))
    .digest("hex")}`;
}

export const TEAM_WORKER_HANDLER_MANIFEST = [
  {
    ref: "packaging.master.match.batch@1.0.0",
    implementationDigest: implementationDigest(
      "packaging.master.match.batch@1.0.0",
      "packaging-smart-v1:trusted-static-v1"
    )
  },
  {
    ref: "packaging.dataset.parse@1.0.0",
    implementationDigest: implementationDigest(
      "packaging.dataset.parse@1.0.0",
      "not-implemented"
    )
  },
  {
    ref: "issues.reconcile@1.0.0",
    implementationDigest: implementationDigest(
      "issues.reconcile@1.0.0",
      "not-implemented"
    )
  },
  {
    ref: "report.issue.build@1.0.0",
    implementationDigest: implementationDigest(
      "report.issue.build@1.0.0",
      "not-implemented"
    )
  }
] as const;

export const TEAM_WORKER_HANDLER_REFS = TEAM_WORKER_HANDLER_MANIFEST.map(
  ({ ref }) => ref
);

export const TEAM_WORKER_CODE_DIGEST = teamCodeDigest({
  protocolVersion: TEAM_PROTOCOL_VERSION,
  workerVersion: TEAM_WORKER_VERSION,
  handlers: TEAM_WORKER_HANDLER_MANIFEST
});
