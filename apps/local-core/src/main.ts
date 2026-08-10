import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { resolveSqliteObservabilityExtension } from "@bpa/sqlite-observability";
import { loadOrCreateCoreSigningKey } from "@bpa/gateway-core";
import { LocalWorkflowEngine } from "./compatibility/local-workflow-engine.js";
import { LocalBrowserGateway } from "./browser-gateway.js";
import { BrowserEvidenceReceiver } from "./browser-evidence.js";
import { LocalControlServer, LocalCoreService } from "./control.js";
import { resolveBpaPaths } from "./paths.js";
import { CoreInstanceLock } from "./instance-lock.js";
import { writeRuntimeResourceMetrics } from "./runtime-resource-metrics.js";
import { RuntimeEventLoopMonitor } from "./runtime-event-loop-monitor.js";
import {
  createOperatorNotificationDispatcher
} from "./operator-notification.js";
import {
  LocalStagingTransferServer,
  StagingTransferService
} from "./staging-transfer.js";

const paths = resolveBpaPaths();
mkdirSync(paths.run, { recursive: true, mode: 0o700 });
mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
const instanceLock = new CoreInstanceLock(paths.lock);
instanceLock.acquire();

const sqliteObservability = resolveSqliteObservabilityExtension();
const persistence = new SqlitePersistence({
  path: paths.database,
  ...(sqliteObservability.status === "available"
    ? { sqliteObservabilityExtensionPath: sqliteObservability.extensionPath }
    : {})
});
if (process.argv.includes("--migrate-only")) {
  persistence.close();
  instanceLock.release();
  process.stdout.write("BPA migrations completed successfully.\n");
  process.exit(0);
}
const notificationDispatcher = createOperatorNotificationDispatcher({
  persistence,
  environment: process.env
});
const signingKey = loadOrCreateCoreSigningKey(paths.signingKey);
const browserEvidence = new BrowserEvidenceReceiver(
  persistence,
  paths.data
);
const browserGateway = new LocalBrowserGateway(
  persistence,
  new LocalWorkflowEngine(persistence),
  signingKey,
  undefined,
  browserEvidence
);
const stagingTransfers = new StagingTransferService(
  persistence,
  paths.data
);
const stagingServer = new LocalStagingTransferServer(
  paths.transferSocket,
  stagingTransfers
);
const service = new LocalCoreService(
  persistence,
  browserGateway,
  undefined,
  stagingTransfers,
  paths.data,
  join(paths.run, "runtime-maintenance.lock")
);
const eventLoopMonitor = new RuntimeEventLoopMonitor();
const writeResourceMetrics = (): void => {
  if (sqliteObservability.status !== "available") return;
  const sampledAt = new Date();
  writeRuntimeResourceMetrics(
    paths.resourceMetrics,
    persistence.readSqliteResourceMetrics(),
    {
      now: () => sampledAt,
      runtimeIdentity: process.env.BPA_RUNTIME_ID?.trim() || null,
      eventLoop: eventLoopMonitor.snapshot(),
      activity: persistence.readRuntimeActivityMetrics(
        sampledAt.toISOString()
      ),
      teamWorker: service.runtimeProcessUsage().teamWorker,
      browserGateway: browserGateway.status().resourceUsage
    }
  );
  eventLoopMonitor.reset();
};
try {
  writeResourceMetrics();
} catch (error) {
  process.stderr.write(
    `[runtime-resource-metrics] ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`
  );
}
const resourceMetricsTimer = setInterval(() => {
  try {
    writeResourceMetrics();
  } catch (error) {
    process.stderr.write(
      `[runtime-resource-metrics] ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }\n`
    );
  }
}, 60_000);
resourceMetricsTimer.unref();
browserGateway.recoverTerminalResults();
browserGateway.recoverCancellations();
const server = new LocalControlServer(
  paths.socket,
  service
);
let drainingIr2 = false;
let coordinatingExternalDomainLeases = false;
let triggerTick = 0;
const gatewayTimer = setInterval(() => {
  try {
    browserGateway.tick();
    if (!coordinatingExternalDomainLeases) {
      coordinatingExternalDomainLeases = true;
      void service.externalDomainLeases
        .tick()
        .catch((error: unknown) => {
          process.stderr.write(
            `[external-domain-lease] ${
              error instanceof Error
                ? error.stack ?? error.message
                : String(error)
            }\n`
          );
        })
        .finally(() => {
          coordinatingExternalDomainLeases = false;
        });
    }
    triggerTick += 1;
    if (triggerTick >= 2) {
      triggerTick = 0;
      service.recoverySessions.sweepExpired();
      service.triggers.tick();
    }
    if (!drainingIr2) {
      drainingIr2 = true;
      void service.ir2Runtime
        .drainOnce()
        .catch((error: unknown) => {
          process.stderr.write(
            `[ir2-runtime] ${
              error instanceof Error
                ? error.stack ?? error.message
                : String(error)
            }\n`
          );
        })
        .finally(() => {
          drainingIr2 = false;
        });
    }
  } catch (error) {
    process.stderr.write(
      `[browser-gateway] ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }\n`
    );
  }
}, 500);
gatewayTimer.unref();

let deliveringAttention = false;
const drainAttentionDelivery = (): void => {
  if (!notificationDispatcher || deliveringAttention) return;
  deliveringAttention = true;
  void notificationDispatcher
    .dispatchNext()
    .catch(() => {
      process.stderr.write(
        "[attention-delivery] dispatch failed before a safe outcome was recorded.\n"
      );
    })
    .finally(() => {
      deliveringAttention = false;
    });
};
const attentionDeliveryTimer = notificationDispatcher
  ? setInterval(drainAttentionDelivery, 5_000)
  : undefined;
attentionDeliveryTimer?.unref();
drainAttentionDelivery();

const shutdown = async (): Promise<void> => {
  clearInterval(gatewayTimer);
  clearInterval(resourceMetricsTimer);
  eventLoopMonitor.close();
  if (attentionDeliveryTimer) clearInterval(attentionDeliveryTimer);
  await server.stop().catch(() => undefined);
  await stagingServer.stop().catch(() => undefined);
  await service.dispose().catch((error) => {
    process.stderr.write(
      `[runtime-provider-dispose] ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }\n`
    );
  });
  persistence.close();
  instanceLock.release();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await stagingServer.start();
await server.start().catch(async (error) => {
  await stagingServer.stop().catch(() => undefined);
  throw error;
});
process.stderr.write(`BPA Local Core listening on ${paths.socket}\n`);
