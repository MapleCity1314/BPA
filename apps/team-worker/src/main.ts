import { TeamWorkerServer } from "@bpa/team-runtime";
import {
  TEAM_WORKER_CODE_DIGEST,
  teamHandlerRegistry
} from "./handlers.js";

const server = new TeamWorkerServer(
  process.stdin,
  process.stdout,
  TEAM_WORKER_CODE_DIGEST,
  teamHandlerRegistry
);
server.start();

const shutdown = (): void => {
  server.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
