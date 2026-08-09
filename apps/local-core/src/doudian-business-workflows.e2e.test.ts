import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe,expect,it } from "vitest";
import {
  RuntimeProviderRegistry,
  type RuntimeInvocation,
  type RuntimeOutcome,
  type RuntimeProvider
} from "@bpa/node-runtime";
import type { ArtifactRef,JsonValue } from "@bpa/workflow-ir";
import type {
  RunRecord,
  TriggerAttemptRecord,
  TriggerOccurrenceRecord
} from "@bpa/persistence";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { LocalCoreService } from "./control.js";
import type { TriggerFireResult } from "./trigger-runtime.js";

const root = new URL("../../../",import.meta.url);
const observedAt = "2026-08-09T08:00:00.000Z";
const browserInstanceId = "doudian-company-main";

function source(path:string):unknown {
  return parse(readFileSync(new URL(path,root),"utf8"));
}

function json(value:unknown):JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function success(output:unknown):RuntimeOutcome {
  return {
    status:"succeeded",output:json(output),evidence:[],riskSignals:[]
  };
}

function object(value:JsonValue | undefined):Record<string,JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Fixture invocation input must be an object");
  }
  return value as Record<string,JsonValue>;
}

function foreachItems(input:JsonValue):Array<Record<string,JsonValue>> {
  const outcome = object(object(input).foreachOutcome);
  const succeeded = object(outcome.succeeded);
  return (succeeded.items as JsonValue[]).map((item) => {
    const value = object(item);
    return object(value.output);
  });
}

class FixtureProvider implements RuntimeProvider {
  constructor(
    readonly id:string,
    readonly invocations:string[],
    readonly failedNodeId?:string
  ) {}

  supports(_node:ArtifactRef & { readonly kind:"node" }):boolean {
    return true;
  }

  async invoke(invocation:RuntimeInvocation):Promise<RuntimeOutcome> {
    this.invocations.push(invocation.node.id);
    if (invocation.node.id === this.failedNodeId) {
      return {
        status:"failed",
        error:{ code:"FIXTURE_ORDINARY_FAILURE",message:"Fixture failure",retryable:false },
        evidence:[],riskSignals:[]
      };
    }
    const input = object(invocation.input);
    switch (invocation.node.id) {
      case "doudian.alliance.shops.discover": {
        const shop = {
          key:"id:10001",id:"10001",name:"测试店铺",status:"active",
          statusText:"经营中"
        };
        return success({
          shops:[shop],sourceShop:shop,discoveredShopCount:1,
          activeShopCount:1,skippedShopCount:0,observedAt
        });
      }
      case "doudian.alliance.shop.retired-products.scan":
        return success({
          shop:input.shop,status:"complete",retiredCount:1,
          updatedAt:"2026-08-09 15:00:00",
          products:[{
            treatmentId:"T-10001",productId:"90001",title:"测试清退商品",
            status:"已清退",processedAt:"2026-08-09",reason:"体验分不达标"
          }]
        });
      case "doudian.alliance.retired-products.aggregate": {
        const shops = foreachItems(invocation.input);
        const outcome = object(input.foreachOutcome);
        const failedCount = Number(object(outcome.failed).count) +
          Number(object(outcome.unresolved).count);
        const retiredProductCount = shops.reduce(
          (count,shop) => count + Number(shop.retiredCount ?? 0),0
        );
        return success({
          status:failedCount > 0
            ? "partial"
            : retiredProductCount > 0 ? "complete_with_items" : "complete_empty",
          businessDate:"2026-08-09",observedAt,
          discoveredShopCount:Number(outcome.total),scannedShopCount:shops.length,
          failedShopCount:failedCount,
          affectedShopCount:shops.filter((shop) => Number(shop.retiredCount ?? 0) > 0).length,
          retiredProductCount,
          shops,foreachOutcome:input.foreachOutcome
        });
      }
      case "doudian.experience.shops.discover": {
        const shop = {
          key:"id:10001",id:"10001",name:"测试店铺",status:"active",
          statusText:"经营中"
        };
        return success({
          status:"complete",shops:[shop],sourceShop:shop,discoveredCount:1,
          collectableCount:1,observedAt,diagnostics:[]
        });
      }
      case "doudian.experience.shop.snapshot.read":
        return success({
          status:"complete",shop:input.shop,observedAt,sourceUpdatedAt:null,
          summary:{ totalScore:96.5,level:"优秀" },
          dimensions:[
            { key:"product",label:"商品体验",score:97 },
            { key:"logistics",label:"物流体验",score:96 },
            { key:"service",label:"服务体验",score:96.5 }
          ],
          evidence:{ page:"experience-score" },diagnostics:[],formMutations:0
        });
      case "doudian.experience.daily.aggregate": {
        const snapshots = foreachItems(invocation.input);
        const outcome = object(input.foreachOutcome);
        const failedCount = Number(object(outcome.failed).count) +
          Number(object(outcome.unresolved).count);
        return success({
          status:failedCount === 0 ? "complete" : snapshots.length > 0 ? "partial" : "failed",
          businessDate:"2026-08-09",observedAt,
          discoveredCount:Number(outcome.total),attemptedCount:Number(outcome.total),
          persistedCount:snapshots.length,failedCount,skippedCount:0,
          snapshots,foreachOutcome:input.foreachOutcome
        });
      }
      case "doudian.shop.context.read":
        return success({
          supported:true,
          shop:{ id:"10001",name:"测试店铺",identity_confirmed:true },
          tab_ref:{
            browser_instance_id:browserInstanceId,tab_id:42,window_id:7,
            origin:"https://fxg.jinritemai.com"
          },
          page_epoch:"tab-42:1:doudian"
        });
      case "doudian.product.scope.collect": {
        const product = {
          id:"80001",title:"测试库存商品",
          editorUrl:"https://fxg.jinritemai.com/ffa/g/create?product_id=80001"
        };
        return success({
          status:"complete",collectorVersion:"1.1.0",
          fingerprint:{
            shopId:"10001",shopName:"测试店铺",filters:{},
            statusTab:{ id:"selling",label:"售卖中" },digest:"abcdef12"
          },
          expectedCount:1,scanRounds:1,products:[product],inspectionQueue:[product],
          restore:{
            listUrl:"https://fxg.jinritemai.com/ffa/g/list",page:1,scrollTop:0,
            shopId:"10001",shopName:"测试店铺",scopeDigest:"abcdef12",
            required:true
          },
          diagnostics:[]
        });
      }
      case "doudian.inventory.product.snapshot.read":
        return success({
          status:"complete",snapshotVersion:"1.0.0",observedAt,
          shop:input.shop,
          product:{ id:"80001",title:"测试库存商品",totalStock:12 },
          skus:[{
            platformSkuId:"70001",merchantCode:"TEST-001",currentStock:12,
            occupiedStock:2,unoccupiedStock:10,
            channels:[{ channelGoodsId:"60001",stock:4 }]
          }],
          diagnostics:[],formMutations:0
        });
      case "inventory.snapshot.persist":
        return success({
          snapshotId:"snapshot:80001",envelope:{
            runId:String(object(input.lease).runId ?? "fixture"),
            persisted:true
          }
        });
      default:
        throw new Error(`Unexpected fixture Node: ${invocation.node.id}`);
    }
  }
}

function publish(
  service:LocalCoreService,
  assetType:string,
  path:string
):void {
  expect(service.handle({
    id:`publish:${path}`,method:"asset.publish",
    params:{ assetType,content:source(path),actor:"test" }
  }),path).toMatchObject({ ok:true });
}

function seedBrowser(
  store:SqlitePersistence,
  capabilities:readonly {
    readonly id:string;
    readonly version:string;
    readonly riskLevel:"R0" | "R1" | "R2";
    readonly permissions:readonly string[];
    readonly adapterId:string;
    readonly adapterVersion:string;
  }[]
):void {
  store.openBrowserSession({
    session:{
      id:"session-doudian",browserInstanceId,
      extensionId:"extension-doudian",extensionVersion:"0.6.0",
      protocolVersion:"2.0.0",incomingSeq:0,outgoingSeq:0,
      lastAckedCommandSeq:0,capabilityDigest:`sha256:${"a".repeat(64)}`,
      resumeTokenDigest:`sha256:${"b".repeat(64)}`,
      resumeTokenExpiresAt:"2026-08-10T00:00:00.000Z",connectedAt:observedAt
    },
    now:observedAt
  });
  store.replaceBrowserCapabilities(
    "session-doudian",
    capabilities.map((capability) => ({
      nodeId:capability.id,nodeVersion:capability.version,
      riskLevel:capability.riskLevel,permissions:[...capability.permissions],
      routes:[{
        origin:"https://fxg.jinritemai.com",
        pathnamePrefixes:["/ffa/g/list","/ffa/eco/experience-score"],
        observerCapabilityId:"doudian.page"
      }],
      adapterId:capability.adapterId,adapterVersion:capability.adapterVersion
    }))
  );
  store.upsertBrowserPageObservation({
    sessionId:"session-doudian",browserInstanceId,tabId:42,windowId:7,
    origin:"https://fxg.jinritemai.com",pathname:"/ffa/g/list",
    contentScriptReady:true,authentication:"authenticated",
    authenticationContextRef:"auth-context-company-main",
    observationState:"ready",pageEpoch:"tab-42:1:doudian",
    observerCapabilityId:"doudian.page",revision:1,observedAt:new Date().toISOString()
  });
}

async function runTrigger(
  service:LocalCoreService,
  store:SqlitePersistence,
  input:{
    readonly id:string;
    readonly appId:string;
    readonly workflowId:string;
    readonly workflowVersion:string;
    readonly workflowInput:Record<string,unknown>;
  }
):Promise<{
  readonly run:RunRecord;
  readonly triggerOccurrence:TriggerOccurrenceRecord;
  readonly triggerAttempt:TriggerAttemptRecord;
}> {
  expect(service.handle({
    id:`put:${input.id}`,method:"trigger.put",params:{
      actor:"test",
      spec:{
        apiVersion:"bpa.trigger/v1alpha2",id:input.id,version:"1.0.0",
        appId:input.appId,kind:"manual",
        workflow:{ id:input.workflowId,version:input.workflowVersion },
        enabled:true,inputSchemaVersion:`${input.id}/1`,input:input.workflowInput,
        concurrencyKey:"doudian-account:company-main",browserInstanceId,
        idempotencyPolicy:"request_key",retryPolicy:"none"
      }
    }
  })).toMatchObject({ ok:true });
  const fired = service.handle({
    id:`fire:${input.id}`,method:"trigger.fire",
    params:{ id:input.id,requestKey:"local-e2e" }
  });
  const triggerResult = fired.result as TriggerFireResult;
  if (!fired.ok || triggerResult.attempt?.status !== "running") {
    throw new Error(`Trigger did not create a Run: ${JSON.stringify(fired)}`);
  }
  const triggerAttempt = triggerResult.attempt;
  for (let turn = 0;turn < 80;turn += 1) {
    await service.ir2Runtime.drainOnce();
    const status = store.getRun(triggerAttempt.workflowRunId!)?.status;
    if (["succeeded","failed","rejected","uncertain","cancelled"].includes(String(status))) {
      break;
    }
  }
  service.triggers.tick();
  const run = store.getRun(triggerAttempt.workflowRunId!);
  if (!run) throw new Error(`Workflow Run missing: ${triggerAttempt.workflowRunId}`);
  return {
    run,
    triggerOccurrence:store.getTriggerOccurrence(
      triggerResult.occurrence.occurrenceId
    )!,
    triggerAttempt:store.getTriggerAttempt(triggerAttempt.attemptId)!
  };
}

describe("local Doudian business Workflow acceptance",() => {
  it("runs retired products, experience score, and inventory on one bounded browser",async () => {
    const store = new SqlitePersistence({ path:":memory:" });
    const providers = new RuntimeProviderRegistry();
    const invocations:string[] = [];
    providers.register(new FixtureProvider("browser",invocations));
    providers.register(new FixtureProvider("team",invocations));
    const service = new LocalCoreService(store,undefined,providers);

    const nodeAssets = [
      "nodes/core/doudian.alliance.shops.discover.node.yaml",
      "nodes/core/doudian.alliance.shop.retired-products.scan.node.yaml",
      "nodes/core/doudian.alliance.retired-products.aggregate.node.yaml",
      "nodes/core/doudian.experience.shops.discover.node.yaml",
      "nodes/core/doudian.experience.shop.snapshot.read.node.yaml",
      "nodes/core/doudian.experience.daily.aggregate.node.yaml",
      "nodes/core/doudian.shop.context.read.node.yaml",
      "nodes/core/doudian.shop.context.read@1.3.0.node.yaml",
      "nodes/core/doudian.product.scope.collect.node.yaml",
      "nodes/core/doudian.product.scope.collect@1.1.0.node.yaml",
      "nodes/core/doudian.product.scope.restore.node.yaml",
      "nodes/core/doudian.product.editor.open.node.yaml",
      "nodes/core/doudian.product.editor.open@1.1.0.node.yaml",
      "nodes/core/doudian.editor.priority-items.inspect.node.yaml",
      "nodes/core/doudian.editor.priority-items.inspect@1.1.0.node.yaml",
      "nodes/core/doudian.inventory.product.snapshot.read.node.yaml",
      "nodes/core/doudian.orders.recent.read.node.yaml",
      "nodes/core/inventory.snapshot.persist.node.yaml"
    ];
    for (const path of nodeAssets) publish(service,"node",path);
    for (const path of [
      "adapters/doudian/doudian.adapter.yaml",
      "adapters/doudian/doudian-alliance.adapter.yaml",
      "adapters/doudian/doudian-experience.adapter.yaml",
      "adapters/doudian/doudian-inventory.adapter.yaml"
    ]) publish(service,"adapter",path);
    for (const path of [
      "workflows/examples/doudian.alliance-retired-products-monitor.workflow.yaml",
      "workflows/examples/doudian.experience-score.daily.workflow.yaml",
      "workflows/examples/doudian.inventory.snapshot.refresh.workflow.yaml"
    ]) publish(service,"workflow",path);

    seedBrowser(store,[
      {
        id:"doudian.alliance.shops.discover",version:"1.0.0",riskLevel:"R2",
        permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
        adapterId:"doudian-alliance",adapterVersion:"1.0.0"
      },
      {
        id:"doudian.alliance.shop.retired-products.scan",version:"1.0.0",riskLevel:"R2",
        permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
        adapterId:"doudian-alliance",adapterVersion:"1.0.0"
      },
      {
        id:"doudian.alliance.retired-products.aggregate",version:"1.0.0",riskLevel:"R0",
        permissions:["browser.dom.read","browser.tabs.read"],
        adapterId:"doudian-alliance",adapterVersion:"1.0.0"
      },
      {
        id:"doudian.experience.shops.discover",version:"1.0.0",riskLevel:"R1",
        permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
        adapterId:"doudian-experience",adapterVersion:"1.0.0"
      },
      {
        id:"doudian.experience.shop.snapshot.read",version:"1.0.0",riskLevel:"R1",
        permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
        adapterId:"doudian-experience",adapterVersion:"1.0.0"
      },
      {
        id:"doudian.experience.daily.aggregate",version:"1.0.0",riskLevel:"R0",
        permissions:["browser.dom.read","browser.tabs.read"],
        adapterId:"doudian-experience",adapterVersion:"1.0.0"
      },
      {
        id:"doudian.shop.context.read",version:"1.3.0",riskLevel:"R0",
        permissions:["browser.dom.read","browser.tabs.read"],
        adapterId:"doudian",adapterVersion:"1.2.0"
      },
      {
        id:"doudian.product.scope.collect",version:"1.1.0",riskLevel:"R0",
        permissions:["browser.dom.read","browser.tabs.read"],
        adapterId:"doudian",adapterVersion:"1.2.0"
      },
      {
        id:"doudian.inventory.product.snapshot.read",version:"1.0.0",riskLevel:"R1",
        permissions:["browser.dom.read","browser.dom.write","browser.tabs.read"],
        adapterId:"doudian-inventory",adapterVersion:"1.0.0"
      }
    ]);

    const retired = await runTrigger(service,store,{
      id:"doudian-retired-local",appId:"retired-products-monitor",
      workflowId:"doudian.alliance-retired-products-monitor",
      workflowVersion:"2.0.1",workflowInput:{ maxShops:100 }
    });
    expect(retired).toMatchObject({
      run:{ status:"succeeded",output:{ alert:true,dailyRecord:{ status:"complete_with_items" } } },
      triggerOccurrence:{ status:"terminal",terminalOutcome:"complete" },
      triggerAttempt:{
        status:"terminal",terminalOutcome:"complete",browserFencingToken:1
      }
    });
    expect(store.listBrowserControlLeases(new Date().toISOString())).toEqual([]);

    const experience = await runTrigger(service,store,{
      id:"doudian-experience-local",appId:"experience-score-monitor",
      workflowId:"doudian.experience-score.daily",workflowVersion:"1.0.1",
      workflowInput:{ maxShops:100 }
    });
    expect(experience).toMatchObject({
      run:{ status:"succeeded",output:{ status:"complete",daily:{ persistedCount:1 } } },
      triggerOccurrence:{ status:"terminal",terminalOutcome:"complete" },
      triggerAttempt:{
        status:"terminal",terminalOutcome:"complete",browserFencingToken:2
      }
    });
    expect(store.listBrowserControlLeases(new Date().toISOString())).toEqual([]);

    const inventory = await runTrigger(service,store,{
      id:"doudian-inventory-local",appId:"inventory-monitor",
      workflowId:"doudian.inventory.snapshot.refresh",workflowVersion:"1.0.0",
      workflowInput:{
        shopId:"10001",shopName:"测试店铺",
        lease:{ runId:"local-e2e",fencingToken:1 }
      }
    });
    expect(inventory).toMatchObject({
      run:{ status:"succeeded",output:{ shop:{ id:"10001",name:"测试店铺" } } },
      triggerOccurrence:{ status:"terminal",terminalOutcome:"complete" },
      triggerAttempt:{
        status:"terminal",terminalOutcome:"complete",browserFencingToken:3
      }
    });
    expect(store.listBrowserControlLeases(new Date().toISOString())).toEqual([]);
    expect(store.listBrowserSessions({ limit:10 }).records).toHaveLength(1);
    expect(store.listBrowserPageObservations({ limit:10 })).toHaveLength(1);
    expect(invocations).toEqual([
      "doudian.alliance.shops.discover",
      "doudian.alliance.shop.retired-products.scan",
      "doudian.alliance.retired-products.aggregate",
      "doudian.experience.shops.discover",
      "doudian.experience.shop.snapshot.read",
      "doudian.experience.daily.aggregate",
      "doudian.shop.context.read",
      "doudian.product.scope.collect",
      "doudian.inventory.product.snapshot.read",
      "inventory.snapshot.persist"
    ]);
    store.close();
  });

  it("keeps a normal retired-product shop failure as an auditable partial result",async () => {
    const store = new SqlitePersistence({ path:":memory:" });
    const providers = new RuntimeProviderRegistry();
    const invocations:string[] = [];
    providers.register(new FixtureProvider(
      "browser",invocations,"doudian.alliance.shop.retired-products.scan"
    ));
    const service = new LocalCoreService(store,undefined,providers);
    for (const path of [
      "nodes/core/doudian.alliance.shops.discover.node.yaml",
      "nodes/core/doudian.alliance.shop.retired-products.scan.node.yaml",
      "nodes/core/doudian.alliance.retired-products.aggregate.node.yaml"
    ]) publish(service,"node",path);
    publish(service,"adapter","adapters/doudian/doudian-alliance.adapter.yaml");
    publish(
      service,"workflow",
      "workflows/examples/doudian.alliance-retired-products-monitor.workflow.yaml"
    );
    seedBrowser(store,[
      {
        id:"doudian.alliance.shops.discover",version:"1.0.0",riskLevel:"R2",
        permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
        adapterId:"doudian-alliance",adapterVersion:"1.0.0"
      },
      {
        id:"doudian.alliance.shop.retired-products.scan",version:"1.0.0",riskLevel:"R2",
        permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
        adapterId:"doudian-alliance",adapterVersion:"1.0.0"
      },
      {
        id:"doudian.alliance.retired-products.aggregate",version:"1.0.0",riskLevel:"R0",
        permissions:["browser.dom.read","browser.tabs.read"],
        adapterId:"doudian-alliance",adapterVersion:"1.0.0"
      }
    ]);

    const result = await runTrigger(service,store,{
      id:"doudian-retired-partial",appId:"retired-products-monitor",
      workflowId:"doudian.alliance-retired-products-monitor",
      workflowVersion:"2.0.1",workflowInput:{ maxShops:100 }
    });

    expect(result).toMatchObject({
      run:{
        status:"uncertain",
        output:{ dailyRecord:{ status:"partial" },scan:{ status:"partial" } }
      },
      triggerOccurrence:{ status:"terminal",terminalOutcome:"uncertain" },
      triggerAttempt:{
        status:"terminal",terminalOutcome:"uncertain",browserFencingToken:1
      }
    });
    expect(invocations).toEqual([
      "doudian.alliance.shops.discover",
      "doudian.alliance.shop.retired-products.scan",
      "doudian.alliance.retired-products.aggregate"
    ]);
    expect(store.listBrowserControlLeases(new Date().toISOString())).toEqual([]);
    store.close();
  });
});
