import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir,rename,writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAppPostgresPool } from "@bpa/app-postgres";
import {
  ControlClient,
  resolveControlSocketPath,
  UnixSocketControlTransport
} from "@bpa/control-client";
import {
  acquireBrowserLeaseOrReleaseAppLease,
  evaluateProductionCycleRenewal,
  PRODUCTION_CYCLE_LEASE_TTL_SECONDS,
  releaseProductionCycleLeases,
  type ProductionCycleBrowserLease
} from "./production-cycle-lease.js";
import { InventoryRepository } from "./repository.js";
import { inventoryShopsFromEnvironment } from "./shop-config.js";

interface ProcessResult {
  readonly exitCode:number;
  readonly stdout:string;
  readonly stderr:string;
}

interface CollectionSummary {
  readonly discovered:number;
  readonly attempted:number;
  readonly persisted:number;
  readonly failed:number;
  readonly skipped:number;
  readonly coverage:number;
  readonly outcome:"complete"|"partial"|"blocked";
  readonly failedProducts:readonly Record<string,unknown>[];
}

function required(name:string):string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function lastJsonLine(value:string):Record<string,unknown>|undefined {
  for (const line of value.trim().split(/\r?\n/u).reverse()) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string,unknown>;
      }
    } catch {
      // Non-JSON progress lines are intentionally ignored.
    }
  }
  return undefined;
}

function boundedDiagnostic(result:ProcessResult):string {
  const source = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return source.replace(/[\r\n]+/gu," ").slice(-1_000);
}

async function runProcess(
  executable:string,
  args:readonly string[],
  env:NodeJS.ProcessEnv,
  timeoutMs:number
):Promise<ProcessResult> {
  return new Promise((resolveResult,reject) => {
    const child = spawn(executable,[...args],{
      cwd:process.cwd(),env:{ ...process.env,...env },stdio:["ignore","pipe","pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data",(chunk:string) => { stdout = `${stdout}${chunk}`.slice(-1_000_000); });
    child.stderr.on("data",(chunk:string) => { stderr = `${stderr}${chunk}`.slice(-1_000_000); });
    const timer = setTimeout(() => child.kill("SIGTERM"),timeoutMs);
    child.once("error",(error) => { clearTimeout(timer);reject(error); });
    child.once("exit",(code,signal) => {
      clearTimeout(timer);
      resolveResult({
        exitCode:code ?? (signal ? 124 : 1),stdout,stderr:
          signal ? `${stderr}\nPROCESS_TERMINATED:${signal}` : stderr
      });
    });
  });
}

const databaseUrl = required("BPA_APP_DATABASE_URL");
const browserInstanceId = required("BPA_INVENTORY_BROWSER_INSTANCE_ID");
const nodeBin = required("BPA_NODE_BIN");
const runtimeRoot = required("BPA_RUNTIME_ROOT");
const configuredShops = inventoryShopsFromEnvironment(process.env);
const targetedShopIds = new Set(
  (process.env.BPA_INVENTORY_RECOVERY_SHOP_IDS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean)
);
const shops = targetedShopIds.size === 0
  ? configuredShops
  : configuredShops.filter((shop) => targetedShopIds.has(shop.id));
if (shops.length === 0) throw new Error("BPA_INVENTORY_TARGET_SHOPS_EMPTY");
const collectionRunId = `collection:${new Date().toISOString()}:${randomUUID()}`;
const triggerKind = (process.env.BPA_INVENTORY_TRIGGER_KIND?.trim() || "schedule") as
  "manual"|"schedule"|"recovery";
if (!["manual","schedule","recovery"].includes(triggerKind)) {
  throw new Error("BPA_INVENTORY_TRIGGER_KIND_INVALID");
}
const projectRoot = process.cwd();
const helperPath = resolve(projectRoot,"apps/inventory-monitor/deploy/inventory-browser-shop-switch.mjs");
const recentPath = resolve(projectRoot,"apps/inventory-monitor/src/refresh-recent.ts");
const salesPath = resolve(projectRoot,"apps/inventory-monitor/src/refresh-sales.ts");
const inventoryPath = resolve(projectRoot,"apps/inventory-monitor/src/refresh-missing.ts");
const riskPath = resolve(projectRoot,"apps/inventory-monitor/src/refresh-risk.ts");
const diagnosticRoot = resolve(runtimeRoot,"diagnostics/inventory",collectionRunId.replaceAll(":","_"));
const legacyStatusPath = resolve(runtimeRoot,"run/inventory-multishop-recovery.status.json");
async function writeLegacyStatus(state:string,reason?:string):Promise<void> {
  const temporary = `${legacyStatusPath}.${process.pid}.tmp`;
  await mkdir(resolve(runtimeRoot,"run"),{ recursive:true,mode:0o700 });
  await writeFile(temporary,`${JSON.stringify({
    state,updatedAt:new Date().toISOString(),collectionRunId,...(reason ? { reason } : {})
  })}\n`,{ encoding:"utf8",mode:0o600 });
  await rename(temporary,legacyStatusPath);
}
const pool = createAppPostgresPool({
  connectionString:databaseUrl,applicationName:"bpa-inventory-production-cycle",maximumConnections:4
});
const repository = new InventoryRepository(pool);
const core = new ControlClient(
  new UnixSocketControlTransport(resolveControlSocketPath(),{
    runtime:{ name:"bpa-inventory-production-cycle",version:"2.0.0" },
    features:["resource_bindings","browser_control_leases"]
  }),
  { timeoutMs:30_000 }
);
const holderId = `production-cycle:${process.pid}:${randomUUID()}`;
const appLeaseKey = "inventory-production-cycle";
// This lease is renewed every 30 seconds. Keep the crash residue bounded so a
// dead process cannot suppress the half-hour production schedule for hours.
const appFencingToken = await repository.acquireLease({
  leaseKey:appLeaseKey,holderId,
  ttlSeconds:PRODUCTION_CYCLE_LEASE_TTL_SECONDS
});
if (appFencingToken === undefined) {
  process.stdout.write(`${JSON.stringify({ status:"skipped",reason:"cycle_lease_busy" })}\n`);
  await pool.end();
  process.exit(0);
}
const browserResourceId = `browser-instance:${browserInstanceId}`;
let browserLease:ProductionCycleBrowserLease =
  await acquireBrowserLeaseOrReleaseAppLease({
    core,repository,pool,browserResourceId,holderId,appLeaseKey,appFencingToken
  });

try {
  await repository.startCollectionRun({
    collectionRunId,triggerKind,browserInstanceId,
    fencingToken:appFencingToken,shopCount:shops.length
  });
  await writeLegacyStatus("running");
  await mkdir(diagnosticRoot,{ recursive:true,mode:0o700 });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await repository.completeCollectionRun({
    collectionRunId,status:"failed",completedShopCount:0,
    summary:{ shops:shops.length,setupFailed:true },diagnostics:[message]
  }).catch(() => undefined);
  await writeLegacyStatus("failed",message).catch(() => undefined);
  await releaseProductionCycleLeases({
    core,repository,pool,browserResourceId,holderId,appLeaseKey,appFencingToken,
    browserFencingToken:browserLease.fencingToken
  });
  throw error;
}

let stopped = false;
let leaseLossReason:string|undefined;
let renewalInFlight = false;
let appLeaseExpiresAtMs = Date.now() + PRODUCTION_CYCLE_LEASE_TTL_SECONDS * 1_000;
const renewalDiagnostics:string[] = [];
const renewals = setInterval(() => {
  if (renewalInFlight) return;
  renewalInFlight = true;
  void (async () => {
    const [appResult,browserResult] = await Promise.allSettled([
      repository.renewLease({
        leaseKey:appLeaseKey,holderId,fencingToken:appFencingToken,
        ttlSeconds:PRODUCTION_CYCLE_LEASE_TTL_SECONDS
      }),
      core.request<ProductionCycleBrowserLease|null>("browser.control-lease.renew",{
        resourceId:browserResourceId,ownerId:holderId,
        fencingToken:browserLease!.fencingToken,ttlSeconds:180
      })
    ]);
    const evaluated = evaluateProductionCycleRenewal({
      appResult,browserResult,currentBrowserLease:browserLease,
      appLeaseExpiresAtMs,nowMs:Date.now(),
      appTtlSeconds:PRODUCTION_CYCLE_LEASE_TTL_SECONDS
    });
    browserLease = evaluated.browserLease;
    appLeaseExpiresAtMs = evaluated.appLeaseExpiresAtMs;
    if (evaluated.lossReason) leaseLossReason = evaluated.lossReason;
    if (evaluated.diagnostic && renewalDiagnostics.length < 20) {
      renewalDiagnostics.push(evaluated.diagnostic);
    }
  })().catch((error) => {
    leaseLossReason = "CONTROL_LEASE_RENEWAL_INTERNAL_ERROR";
    if (renewalDiagnostics.length < 20) {
      renewalDiagnostics.push(
        error instanceof Error ? error.message.slice(0,1_000) : String(error).slice(0,1_000)
      );
    }
  }).finally(() => { renewalInFlight = false; });
},30_000);
renewals.unref();
for (const signal of ["SIGINT","SIGTERM"] as const) {
  process.once(signal,() => { stopped = true; });
}

const diagnostics:string[] = [];
const riskTasks:Array<{
  shopId:string;shopName:string;run:() => Promise<ProcessResult>;
}> = [];
let completedShops = 0;
let usableInventoryShops = 0;
let blockedShops = 0;
let partialShops = 0;
let reusedOrderShops = 0;
let refreshedOrderShops = 0;

async function diagnostic(shopId:string,component:string,result:ProcessResult):Promise<void> {
  const payload = {
    collectionRunId,shopId,component,recordedAt:new Date().toISOString(),
    exitCode:result.exitCode,diagnostic:boundedDiagnostic(result)
  };
  await writeFile(
    resolve(diagnosticRoot,`${shopId}-${component}.json`),
    `${JSON.stringify(payload,null,2)}\n`,{ encoding:"utf8",mode:0o600 }
  );
}

async function helper(mode:string,shopName?:string,retries=1):Promise<ProcessResult> {
  let result:ProcessResult = { exitCode:1,stdout:"",stderr:"not started" };
  for (let attempt=1;attempt<=retries;attempt+=1) {
    result = await runProcess(nodeBin,[helperPath,mode,...(shopName ? [shopName] : [])],{},90_000);
    if (result.exitCode === 0 || result.exitCode === 42) return result;
    await new Promise((resolveDelay) => setTimeout(resolveDelay,2_000));
  }
  return result;
}

try {
  for (const shop of shops) {
    if (stopped || leaseLossReason) {
      throw new Error(leaseLossReason ?? "CYCLE_STOPPED");
    }
    const shopEnv = {
      BPA_INVENTORY_SHOP_ID:shop.id,BPA_INVENTORY_SHOP_NAME:shop.name,
      BPA_INVENTORY_BROWSER_INSTANCE_ID:browserInstanceId,
      BPA_INVENTORY_SCOPE_MODE:"persisted",
      BPA_INVENTORY_REFRESH_SINCE:new Date().toISOString()
    };
    await repository.recordCollectionStep({
      collectionRunId,shopId:shop.id,shopName:shop.name,
      component:"canary",status:"running",completed:false
    });
    let result = await helper("restore-product",undefined,3);
    if (result.exitCode === 0) result = await helper("switch",shop.name,3);
    if (result.exitCode === 0) result = await helper("restore-product",undefined,3);
    if (result.exitCode === 0) await helper("dismiss-known-modal");
    if (result.exitCode === 0) result = await helper("canary",shop.name,2);
    const canary = lastJsonLine(result.stdout);
    if (result.exitCode !== 0 || canary?.status !== "passed") {
      const auth = result.exitCode === 42;
      const message = boundedDiagnostic(result);
      await diagnostic(shop.id,"canary",result);
      await repository.recordCollectionStep({
        collectionRunId,shopId:shop.id,shopName:shop.name,component:"canary",
        status:auth ? "blocked" : "failed",diagnostic:message,
        details:{ diagnosticFile:`${shop.id}-canary.json` }
      });
      diagnostics.push(`${shop.id}:canary:${message}`);
      blockedShops += 1;
      if (auth) throw new Error("BROWSER_AUTH_REQUIRED");
      continue;
    }
    await repository.recordCollectionStep({
      collectionRunId,shopId:shop.id,shopName:shop.name,component:"canary",
      status:"succeeded",details:{
        structureDigest:canary.structureDigest,productRows:canary.productRows
      }
    });

    const orderFreshness = await repository.recentOrderFreshness(shop.id);
    if (orderFreshness.fresh) {
      reusedOrderShops += 1;
      await repository.recordCollectionStep({
        collectionRunId,shopId:shop.id,shopName:shop.name,component:"orders",
        status:"fresh_reused",details:orderFreshness
      });
    } else {
      await repository.recordCollectionStep({
        collectionRunId,shopId:shop.id,shopName:shop.name,component:"orders",
        status:"running",completed:false,details:{ previous:orderFreshness }
      });
      result = await helper("restore-orders",undefined,3);
      if (result.exitCode === 0) {
        result = await runProcess(nodeBin,["--import","tsx",recentPath],shopEnv,15*60_000);
      }
      if (result.exitCode === 0) {
        refreshedOrderShops += 1;
        await repository.recordCollectionStep({
          collectionRunId,shopId:shop.id,shopName:shop.name,component:"orders",
          status:"succeeded",details:{ previous:orderFreshness }
        });
      } else {
        const browserMessage = boundedDiagnostic(result);
        await diagnostic(shop.id,"orders-browser",result);
        const fallback = await runProcess(
          nodeBin,["--import","tsx",salesPath],shopEnv,15*60_000
        );
        if (fallback.exitCode === 0) {
          refreshedOrderShops += 1;
          await repository.recordCollectionStep({
            collectionRunId,shopId:shop.id,shopName:shop.name,component:"orders",
            status:"succeeded",details:{
              previous:orderFreshness,
              primaryRead:"degraded",
              fallbackSource:"wdt",
              primaryDiagnostic:browserMessage
            }
          });
        } else {
          const fallbackMessage = boundedDiagnostic(fallback);
          const message = `${browserMessage} WDT_FALLBACK:${fallbackMessage}`.slice(-1_000);
          await diagnostic(shop.id,"orders-wdt",fallback);
          diagnostics.push(`${shop.id}:orders:${message}`);
          await repository.recordCollectionStep({
            collectionRunId,shopId:shop.id,shopName:shop.name,component:"orders",
            status:"degraded",diagnostic:message,details:{
              previous:orderFreshness,primaryRead:"degraded",fallbackSource:"wdt"
            }
          });
        }
      }
      result = await helper("restore-product",undefined,3);
      if (result.exitCode === 0) await helper("dismiss-known-modal");
      if (result.exitCode === 0) result = await helper("canary",shop.name,2);
      if (result.exitCode !== 0) {
        const message = boundedDiagnostic(result);
        await diagnostic(shop.id,"product-restore",result);
        diagnostics.push(`${shop.id}:product-restore:${message}`);
        blockedShops += 1;
        continue;
      }
    }

    let summary:CollectionSummary|undefined;
    await repository.recordCollectionStep({
      collectionRunId,shopId:shop.id,shopName:shop.name,component:"inventory",
      status:"running",completed:false
    });
    for (let attempt=1;attempt<=3;attempt+=1) {
      result = await runProcess(nodeBin,["--import","tsx",inventoryPath],shopEnv,60*60_000);
      const output = lastJsonLine(result.stdout);
      if (output?.summary && typeof output.summary === "object") {
        summary = output.summary as unknown as CollectionSummary;
      }
      if (summary?.outcome === "complete") break;
      if (result.exitCode === 1) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay,2_000));
    }
    if (!summary || summary.outcome === "blocked") {
      const message = boundedDiagnostic(result);
      await diagnostic(shop.id,"inventory",result);
      diagnostics.push(`${shop.id}:inventory:${message}`);
      blockedShops += 1;
      await repository.recordCollectionStep({
        collectionRunId,shopId:shop.id,shopName:shop.name,component:"inventory",
        status:"blocked",diagnostic:message
      });
      continue;
    }
    usableInventoryShops += 1;
    if (summary.outcome === "partial") partialShops += 1;
    await repository.recordCollectionStep({
      collectionRunId,shopId:shop.id,shopName:shop.name,component:"inventory",
      status:summary.outcome === "complete" ? "succeeded" : "partial",
      attempted:summary.attempted,persisted:summary.persisted,failed:summary.failed,
      coverage:summary.coverage,details:{
        discovered:summary.discovered,skipped:summary.skipped,
        failedProducts:summary.failedProducts.slice(0,50)
      }
    });
    completedShops += 1;
    await repository.updateCollectionProgress({
      collectionRunId,completedShopCount:completedShops
    });
    riskTasks.push({
      shopId:shop.id,shopName:shop.name,
      run:() => runProcess(nodeBin,["--import","tsx",riskPath],shopEnv,45*60_000)
    });
  }

  let riskCursor = 0;
  await Promise.all(Array.from(
    { length:Math.min(3,riskTasks.length) },
    async () => {
      while (riskCursor < riskTasks.length) {
        const task = riskTasks[riskCursor++];
        if (!task) return;
        await repository.recordCollectionStep({
          collectionRunId,shopId:task.shopId,shopName:task.shopName,component:"risk",
          status:"running",completed:false
        });
        const result = await task.run();
        const ok = result.exitCode === 0;
        if (!ok) {
          const message = boundedDiagnostic(result);
          diagnostics.push(`${task.shopId}:risk:${message}`);
          await diagnostic(task.shopId,"risk",result);
        }
        await repository.recordCollectionStep({
          collectionRunId,shopId:task.shopId,shopName:task.shopName,component:"risk",
          status:ok ? "succeeded" : "degraded",
          ...(ok ? {} : { diagnostic:boundedDiagnostic(result) })
        });
      }
    }
  ));

  const status = usableInventoryShops === 0
    ? "failed"
    : blockedShops > 0 || partialShops > 0
      ? "partial"
      : diagnostics.length > 0
        ? "degraded"
        : "succeeded";
  await repository.completeCollectionRun({
    collectionRunId,status,completedShopCount:completedShops,
    summary:{
      shops:shops.length,usableInventoryShops,blockedShops,partialShops,
      reusedOrderShops,refreshedOrderShops,riskRuns:riskTasks.length,
      notificationDelivery:"disabled"
    },diagnostics:[...renewalDiagnostics,...diagnostics]
  });
  await writeLegacyStatus(status);
  process.stdout.write(`${JSON.stringify({
    status,collectionRunId,shops:shops.length,usableInventoryShops,
    blockedShops,partialShops,reusedOrderShops,refreshedOrderShops
  })}\n`);
  if (status === "failed") process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  diagnostics.push(...renewalDiagnostics,message);
  await repository.completeCollectionRun({
    collectionRunId,status:message === "BROWSER_AUTH_REQUIRED" ? "blocked" : "failed",
    completedShopCount:completedShops,
    summary:{ shops:shops.length,usableInventoryShops,blockedShops,partialShops },
    diagnostics
  }).catch(() => undefined);
  await writeLegacyStatus(
    message === "BROWSER_AUTH_REQUIRED" ? "auth_required" : "failed",message
  ).catch(() => undefined);
  process.stderr.write(`${JSON.stringify({ status:"failed",collectionRunId,error:message })}\n`);
  process.exitCode = message === "BROWSER_AUTH_REQUIRED" ? 75 : 1;
} finally {
  clearInterval(renewals);
  await releaseProductionCycleLeases({
    core,repository,pool,browserResourceId,holderId,appLeaseKey,appFencingToken,
    browserFencingToken:browserLease.fencingToken
  });
}
