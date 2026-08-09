import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { contentDigest } from "@bpa/compiler";
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

function experienceSnapshot(
  shop:Record<string,JsonValue>,
  status:"complete" | "no_score" = "complete"
):Record<string,unknown> {
  const shopId = String(shop.id);
  const metric = (
    key:string,
    label:string
  ) => ({
    key,label,rawValue:"96.5分",value:96.5,unit:"分",score:96.5,
    scoreRaw:"得分96.5分",weight:100,weightRaw:"权重100%",
    numerator:null,denominator:null,change:null,note:null
  });
  return {
    status,
    shop:{ id:shopId,name:String(shop.name) },
    observedAt,sourceUpdatedAt:null,
    summary:{
      totalScore:status === "complete" ? 96.5 : null,
      totalScoreRaw:status === "complete" ? "96.5分" : null,
      level:status === "complete" ? "优秀" : null,
      industry:"食品",orders30d:status === "complete" ? 100 : 12,
      orders30dRaw:status === "complete" ? "100" : "12"
    },
    dimensions:status === "complete"
      ? [
          {
            key:"goods",label:"商品体验",score:97,scoreRaw:"得分97分",
            metrics:[metric("goods.composite_rating","商品综合评分")]
          },
          {
            key:"logistics",label:"物流体验",score:96,scoreRaw:"得分96分",
            metrics:[metric("logistics.delivery_sla_rate","运单配送时效达成率")]
          },
          {
            key:"service",label:"服务体验",score:96.5,scoreRaw:"得分96.5分",
            metrics:[metric("service.im_dissatisfaction_rate","飞鸽会话不满意率")]
          }
        ]
      : [],
    evidence:{
      pageUrl:`https://fxg.jinritemai.com/ffa/eco/experience-score?shop_id=${shopId}&session=must-not-persist#private`,
      capturedAt:observedAt,structuredSnapshotRef:"inline:abcdef12"
    },
    diagnostics:status === "no_score" ? ["EXPERIENCE_SCORE_NOT_AVAILABLE_LOW_ORDERS"] : ["PRIVATE_DIAGNOSTIC"],
    formMutations:0
  };
}

class FixtureProvider implements RuntimeProvider {
  constructor(
    readonly id:string,
    readonly invocations:string[],
    readonly failedNodeId?:string,
    readonly experience?:{
      readonly shops:ReadonlyArray<{
        readonly key:string;
        readonly id?:string;
        readonly name:string;
        readonly status:"active" | "blocked";
        readonly statusText:string;
      }>;
      readonly failedShopId?:string;
      readonly snapshotStatus?:"complete" | "no_score";
    },
    readonly retired?:{
      readonly shops:ReadonlyArray<{
        readonly key:string;
        readonly id?:string;
        readonly name:string;
        readonly status:"active" | "blocked";
        readonly statusText:string;
      }>;
      readonly failedShopId?:string;
    }
  ) {}

  supports(_node:ArtifactRef & { readonly kind:"node" }):boolean {
    return true;
  }

  async invoke(invocation:RuntimeInvocation):Promise<RuntimeOutcome> {
    this.invocations.push(invocation.node.id);
    if (
      invocation.node.id === this.failedNodeId &&
      invocation.node.id !== "doudian.alliance.shop.retired-products.scan"
    ) {
      return {
        status:"failed",
        error:{ code:"FIXTURE_ORDINARY_FAILURE",message:"Fixture failure",retryable:false },
        evidence:[],riskSignals:[]
      };
    }
    const input = object(invocation.input);
    switch (invocation.node.id) {
      case "doudian.alliance.shops.discover": {
        const shops = this.retired?.shops ?? [{
          key:"id:10001",id:"10001",name:"测试店铺",status:"active",
          statusText:"经营中" as const
        }];
        if (shops.some((shop) =>
          shop.status === "active" && !/^[0-9]{5,30}$/u.test(shop.id ?? "")
        )) {
          return {
            status:"failed",
            error:{
              code:"SHOP_IDENTITY_UNCERTAIN",
              message:"Active shop identity is incomplete.",retryable:false
            },
            evidence:[],riskSignals:[]
          };
        }
        return success({
          status:"complete",shops,sourceShop:shops[0],
          discoveredCount:shops.length,
          collectableCount:shops.filter((shop) => shop.status === "active").length,
          observedAt,diagnostics:[]
        });
      }
      case "doudian.alliance.shop.retired-products.scan": {
        const shop = object(input.shop);
        if (shop.status === "blocked") {
          return success({
            shop:input.shop,status:"skipped",retiredCount:0,products:[],
            diagnostics:["SHOP_NOT_ACTIVE"]
          });
        }
        if (
          invocation.node.id === this.failedNodeId ||
          shop.id === this.retired?.failedShopId
        ) {
          return {
            status:"failed",
            error:{ code:"FIXTURE_ORDINARY_FAILURE",message:"Fixture failure",retryable:false },
            evidence:[],riskSignals:[]
          };
        }
        return success({
          shop:input.shop,status:"complete",retiredCount:1,
          updatedAt:"2026-08-09 15:00:00",observedAt,
          products:[{
            treatmentId:"T-10001",productId:"90001",title:"测试清退商品",
            status:"已清退",processedAt:"2026-08-09",reason:"体验分不达标"
          }],
          evidence:{
            pageUrl:"https://buyin.jinritemai.com/dashboard/regulation/clear-out?session=private#fragment",
            capturedAt:observedAt
          },
          diagnostics:["PRIVATE_DIAGNOSTIC"]
        });
      }
      case "doudian.experience.shops.discover": {
        const shops = this.experience?.shops ?? [{
          key:"id:10001",id:"10001",name:"测试店铺",status:"active" as const,
          statusText:"经营中"
        }];
        if (shops.some((shop) =>
          shop.status === "active" && !/^[0-9]{5,30}$/u.test(shop.id ?? "")
        )) {
          return {
            status:"failed",
            error:{
              code:"SHOP_IDENTITY_UNCERTAIN",
              message:"Active shop identity is incomplete.",
              retryable:false
            },
            evidence:[],riskSignals:[]
          };
        }
        return success({
          status:"complete",shops,sourceShop:shops[0],
          discoveredCount:shops.length,
          collectableCount:shops.filter((shop) => shop.status === "active").length,
          observedAt,diagnostics:[]
        });
      }
      case "doudian.experience.shop.snapshot.read": {
        const shop = object(input.shop);
        if (shop.status === "blocked") {
          return success({
            status:"skipped",shop,diagnostics:["SHOP_NOT_ACTIVE"]
          });
        }
        if (shop.id === this.experience?.failedShopId) {
          return {
            status:"failed",
            error:{ code:"FIXTURE_EXPERIENCE_READ_FAILED",message:"Fixture failure",retryable:false },
            evidence:[],riskSignals:[]
          };
        }
        return success(experienceSnapshot(
          shop,this.experience?.snapshotStatus ?? "complete"
        ));
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
      extensionId:"extension-doudian",extensionVersion:"0.6.1",
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

function publishExperience(service:LocalCoreService):void {
  for (const path of [
    "nodes/core/doudian.experience.shops.discover.node.yaml",
    "nodes/core/doudian.experience.shop.snapshot.read.node.yaml",
    "nodes/core/doudian.experience.shop.fact.persist.node.yaml",
    "nodes/core/doudian.experience.daily.aggregate.node.yaml",
    "nodes/core/doudian.experience.daily.dataset.prepare.node.yaml"
  ]) publish(service,"node",path);
  publish(service,"adapter","adapters/doudian/doudian-experience.adapter.yaml");
  publish(
    service,"workflow",
    "workflows/examples/doudian.experience-score.daily.workflow.yaml"
  );
}

function seedExperienceBrowser(store:SqlitePersistence):void {
  seedBrowser(store,[
    {
      id:"doudian.experience.shops.discover",version:"2.0.0",riskLevel:"R1",
      permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
      adapterId:"doudian-experience",adapterVersion:"2.0.0"
    },
    {
      id:"doudian.experience.shop.snapshot.read",version:"2.0.0",riskLevel:"R1",
      permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
      adapterId:"doudian-experience",adapterVersion:"2.0.0"
    }
  ]);
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
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observedAt));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
      "nodes/core/doudian.alliance.shop.retired-products.fact.persist.node.yaml",
      "nodes/core/doudian.alliance.retired-products.aggregate.node.yaml",
      "nodes/core/doudian.alliance.retired-products.dataset.prepare.node.yaml",
      "nodes/core/doudian.experience.shops.discover.node.yaml",
      "nodes/core/doudian.experience.shop.snapshot.read.node.yaml",
      "nodes/core/doudian.experience.shop.fact.persist.node.yaml",
      "nodes/core/doudian.experience.daily.aggregate.node.yaml",
      "nodes/core/doudian.experience.daily.dataset.prepare.node.yaml",
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
        id:"doudian.alliance.shops.discover",version:"2.0.0",riskLevel:"R2",
        permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
        adapterId:"doudian-alliance",adapterVersion:"2.0.0"
      },
      {
        id:"doudian.alliance.shop.retired-products.scan",version:"2.0.0",riskLevel:"R2",
        permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
        adapterId:"doudian-alliance",adapterVersion:"2.0.0"
      },
      {
        id:"doudian.experience.shops.discover",version:"2.0.0",riskLevel:"R1",
        permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
        adapterId:"doudian-experience",adapterVersion:"2.0.0"
      },
      {
        id:"doudian.experience.shop.snapshot.read",version:"2.0.0",riskLevel:"R1",
        permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
        adapterId:"doudian-experience",adapterVersion:"2.0.0"
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
      workflowVersion:"3.0.0",workflowInput:{ maxShops:100 }
    });
    expect(retired).toMatchObject({
      run:{ status:"succeeded",output:{ alert:true,dailyRecord:{ status:"complete_with_items" } } },
      triggerOccurrence:{ status:"terminal",terminalOutcome:"complete" },
      triggerAttempt:{
        status:"terminal",terminalOutcome:"complete",browserFencingToken:1
      }
    });
    expect(store.listBrowserControlLeases(new Date().toISOString())).toEqual([]);
    const retiredFacts = store.listOperationalFactsForRun(retired.run.id);
    expect(retiredFacts).toHaveLength(1);
    expect(retiredFacts[0]?.record).toMatchObject({
      id:"10001",businessDate:"2026-08-09",status:"complete_with_items",
      retiredCount:1,
      evidence:{
        pageUrl:"https://buyin.jinritemai.com/dashboard/regulation/clear-out",
        capturedAt:observedAt
      }
    });
    expect(JSON.stringify(retiredFacts[0]?.record)).not.toContain("diagnostic");
    expect(JSON.stringify(retiredFacts[0]?.record)).not.toContain("session=");
    const retiredDatasetIntent = object(object(json(retired.run.output)).datasetIntent);
    expect(store.getOperationalDatasetPublicationLineage(
      String(retiredDatasetIntent.datasetId),String(retiredDatasetIntent.version)
    )).toMatchObject({
      runId:retired.run.id,terminalStatus:"succeeded",quality:"complete",
      coverage:{ discovered:1,collectable:1,attempted:1,persisted:1,failed:0,skipped:0 }
    });
    const retiredAttentionId = `run-business-finding:${retired.run.id}`;
    expect(store.getAttention(retiredAttentionId)).toMatchObject({
      sourceRef:{ kind:"workflow-run",runId:retired.run.id },
      item:{
        id:retiredAttentionId,runId:retired.run.id,kind:"action",
        groupKey:"business-finding:retired-products-found",blocking:false
      }
    });
    expect(
      store.getAttentionDeliveryForAttention(retiredAttentionId)
    ).toMatchObject({ state:"pending",attentionId:retiredAttentionId });

    const experience = await runTrigger(service,store,{
      id:"doudian-experience-local",appId:"experience-score-monitor",
      workflowId:"doudian.experience-score.daily",workflowVersion:"2.0.0",
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
    expect(
      store.getRunPlanSnapshot(experience.run.id)?.planJson.artifactClosure.entries
        .filter((entry) => entry.kind === "dataset_profile")
    ).toEqual([]);
    const experienceFacts = store.listOperationalFactsForRun(experience.run.id);
    expect(experienceFacts).toHaveLength(1);
    expect(experienceFacts[0]?.record).toMatchObject({
      id:"10001",businessDate:"2026-08-09",status:"complete",
      evidence:{
        pageUrl:"https://fxg.jinritemai.com/ffa/eco/experience-score",
        capturedAt:observedAt
      }
    });
    expect(JSON.stringify(experienceFacts[0]?.record)).not.toContain("diagnostic");
    expect(JSON.stringify(experienceFacts[0]?.record)).not.toContain("structuredSnapshotRef");
    expect(JSON.stringify(experienceFacts[0]?.record)).not.toContain("session=");
    const intent = object(json(experience.run.output)).operationalDatasetPublicationIntentId;
    expect(typeof intent).toBe("string");
    const datasetIntent = object(object(json(experience.run.output)).datasetIntent);
    expect(store.getDataset(
      String(datasetIntent.datasetId),String(datasetIntent.version)
    )).toBeDefined();
    expect(store.getOperationalDatasetPublicationLineage(
      String(datasetIntent.datasetId),String(datasetIntent.version)
    )).toMatchObject({
      runId:experience.run.id,terminalStatus:"succeeded",quality:"complete",
      coverage:{ discovered:1,collectable:1,attempted:1,persisted:1,failed:0,skipped:0 }
    });

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
      "doudian.experience.shops.discover",
      "doudian.experience.shop.snapshot.read",
      "doudian.shop.context.read",
      "doudian.product.scope.collect",
      "doudian.inventory.product.snapshot.read",
      "inventory.snapshot.persist"
    ]);
    store.close();
  });

  it("publishes a partial Dataset only with an uncertain terminal marker",async () => {
    const store = new SqlitePersistence({ path:":memory:" });
    const providers = new RuntimeProviderRegistry();
    const invocations:string[] = [];
    providers.register(new FixtureProvider("browser",invocations,undefined,{
      shops:[
        { key:"id:10001",id:"10001",name:"测试店铺一",status:"active",statusText:"经营中" },
        { key:"id:10002",id:"10002",name:"测试店铺二",status:"active",statusText:"经营中" }
      ],
      failedShopId:"10002"
    }));
    const service = new LocalCoreService(store,undefined,providers);
    publishExperience(service);
    seedExperienceBrowser(store);

    const result = await runTrigger(service,store,{
      id:"doudian-experience-partial",appId:"experience-score-monitor",
      workflowId:"doudian.experience-score.daily",workflowVersion:"2.0.0",
      workflowInput:{ maxShops:100 }
    });

    expect(result).toMatchObject({
      run:{
        status:"uncertain",
        output:{
          status:"partial",
          daily:{
            status:"partial",discoveredCount:2,collectableCount:2,
            attemptedCount:2,persistedCount:1,failedCount:1,skippedCount:0
          },
          operationalDatasetPublicationIntentId:expect.any(String)
        }
      },
      triggerOccurrence:{ status:"terminal",terminalOutcome:"uncertain" },
      triggerAttempt:{ status:"terminal",terminalOutcome:"uncertain" }
    });
    const datasetIntent = object(object(json(result.run.output)).datasetIntent);
    expect(store.getOperationalDatasetPublicationLineage(
      String(datasetIntent.datasetId),String(datasetIntent.version)
    )).toMatchObject({
      runId:result.run.id,terminalStatus:"uncertain",quality:"partial",
      coverage:{ discovered:2,collectable:2,attempted:2,persisted:1,failed:1,skipped:0 }
    });
    expect(store.listOperationalFactsForRun(result.run.id)).toHaveLength(1);
    expect(store.getPreparedOperationalDatasetPublication(result.run.id)).toBeUndefined();
    expect(store.listBrowserControlLeases(new Date().toISOString())).toEqual([]);
    store.close();
  });

  it("keeps no-score facts and normal inactive skips in a complete Dataset",async () => {
    const store = new SqlitePersistence({ path:":memory:" });
    const providers = new RuntimeProviderRegistry();
    const invocations:string[] = [];
    providers.register(new FixtureProvider("browser",invocations,undefined,{
      shops:[
        { key:"id:10001",id:"10001",name:"测试店铺一",status:"active",statusText:"经营中" },
        { key:"name:测试店铺二",name:"测试店铺二",status:"blocked",statusText:"SHOP_ID_UNAVAILABLE" }
      ],
      snapshotStatus:"no_score"
    }));
    const service = new LocalCoreService(store,undefined,providers);
    publishExperience(service);
    seedExperienceBrowser(store);

    const result = await runTrigger(service,store,{
      id:"doudian-experience-no-score",appId:"experience-score-monitor",
      workflowId:"doudian.experience-score.daily",workflowVersion:"2.0.0",
      workflowInput:{ maxShops:100 }
    });

    expect(result.run).toMatchObject({
      status:"succeeded",
      output:{
        status:"complete",
        daily:{
          status:"complete",discoveredCount:2,collectableCount:1,
          attemptedCount:1,persistedCount:1,failedCount:0,skippedCount:1
        },
        operationalDatasetPublicationIntentId:expect.any(String)
      }
    });
    expect(store.listOperationalFactsForRun(result.run.id)[0]?.record).toMatchObject({
      status:"no_score",summary:{ totalScore:null },dimensions:[]
    });
    const datasetIntent = object(object(json(result.run.output)).datasetIntent);
    expect(store.getOperationalDatasetPublicationLineage(
      String(datasetIntent.datasetId),String(datasetIntent.version)
    )).toMatchObject({
      terminalStatus:"succeeded",quality:"complete",
      coverage:{ discovered:2,collectable:1,attempted:1,persisted:1,failed:0,skipped:1 }
    });
    store.close();
  });

  it("fails discovery and publishes no Dataset when an active shop lacks a stable id",async () => {
    const store = new SqlitePersistence({ path:":memory:" });
    const providers = new RuntimeProviderRegistry();
    providers.register(new FixtureProvider("browser",[],undefined,{
      shops:[{
        key:"name:测试店铺",name:"测试店铺",status:"active",statusText:"经营中"
      }]
    }));
    const service = new LocalCoreService(store,undefined,providers);
    publishExperience(service);
    seedExperienceBrowser(store);

    const result = await runTrigger(service,store,{
      id:"doudian-experience-active-no-id",appId:"experience-score-monitor",
      workflowId:"doudian.experience-score.daily",workflowVersion:"2.0.0",
      workflowInput:{ maxShops:100 }
    });

    expect(result.run).toMatchObject({ status:"uncertain" });
    expect(store.getEngineCheckpoint(result.run.id)?.state).toMatchObject({
      status:"uncertain",
      error:{ code:"DOUDIAN_EXPERIENCE_DISCOVERY_INCOMPLETE" }
    });
    expect(store.listEvents(result.run.id).at(-1)).toMatchObject({
      type:"RUNTIME_RESULT_APPLIED",
      payload:{
        errorCode:"SHOP_IDENTITY_UNCERTAIN",
        error:{ code:"DOUDIAN_EXPERIENCE_DISCOVERY_INCOMPLETE" }
      }
    });
    expect(store.getAttention(`run-terminal:${result.run.id}`)).toMatchObject({
      sourceRef:{ kind:"workflow-run",runId:result.run.id },
      item:{
        source:"runtime",kind:"blocking",groupKey:"uncertain",
        runId:result.run.id
      }
    });
    expect(store.listOperationalFactsForRun(result.run.id)).toEqual([]);
    expect(
      store.getPreparedOperationalDatasetPublication(result.run.id)
    ).toBeUndefined();
    store.close();
  });

  it("keeps a zero-fact experience Run failed and publishes no Dataset",async () => {
    const store = new SqlitePersistence({ path:":memory:" });
    const providers = new RuntimeProviderRegistry();
    const invocations:string[] = [];
    providers.register(new FixtureProvider("browser",invocations,undefined,{
      shops:[
        { key:"id:10001",id:"10001",name:"测试店铺一",status:"active",statusText:"经营中" }
      ],
      failedShopId:"10001"
    }));
    const service = new LocalCoreService(store,undefined,providers);
    publishExperience(service);
    seedExperienceBrowser(store);

    const result = await runTrigger(service,store,{
      id:"doudian-experience-zero",appId:"experience-score-monitor",
      workflowId:"doudian.experience-score.daily",workflowVersion:"2.0.0",
      workflowInput:{ maxShops:100 }
    });

    expect(result.run).toMatchObject({
      status:"failed",
      output:{
        status:"failed",
        daily:{ status:"failed",persistedCount:0,failedCount:1 }
      }
    });
    expect(object(json(result.run.output)).operationalDatasetPublicationIntentId).toBeUndefined();
    expect(store.listOperationalFactsForRun(result.run.id)).toEqual([]);
    expect(store.getPreparedOperationalDatasetPublication(result.run.id)).toBeUndefined();
    const wouldBeVersion =
      `2026.8.9-run.${contentDigest(result.run.id).slice(7,39)}`;
    expect(store.getDataset(
      "doudian-experience-daily",wouldBeVersion
    )).toBeUndefined();
    store.close();
  });

  it("keeps a normal retired-product shop failure as an auditable partial result",async () => {
    const store = new SqlitePersistence({ path:":memory:" });
    const providers = new RuntimeProviderRegistry();
    const invocations:string[] = [];
    providers.register(new FixtureProvider(
      "browser",invocations,undefined,undefined,{
        shops:[
          { key:"id:10001",id:"10001",name:"测试店铺一",status:"active",statusText:"经营中" },
          { key:"id:10002",id:"10002",name:"测试店铺二",status:"active",statusText:"经营中" }
        ],
        failedShopId:"10002"
      }
    ));
    const service = new LocalCoreService(store,undefined,providers);
    for (const path of [
      "nodes/core/doudian.alliance.shops.discover.node.yaml",
      "nodes/core/doudian.alliance.shop.retired-products.scan.node.yaml",
      "nodes/core/doudian.alliance.shop.retired-products.fact.persist.node.yaml",
      "nodes/core/doudian.alliance.retired-products.aggregate.node.yaml",
      "nodes/core/doudian.alliance.retired-products.dataset.prepare.node.yaml"
    ]) publish(service,"node",path);
    publish(service,"adapter","adapters/doudian/doudian-alliance.adapter.yaml");
    publish(
      service,"workflow",
      "workflows/examples/doudian.alliance-retired-products-monitor.workflow.yaml"
    );
    seedBrowser(store,[
      {
        id:"doudian.alliance.shops.discover",version:"2.0.0",riskLevel:"R2",
        permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
        adapterId:"doudian-alliance",adapterVersion:"2.0.0"
      },
      {
        id:"doudian.alliance.shop.retired-products.scan",version:"2.0.0",riskLevel:"R2",
        permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
        adapterId:"doudian-alliance",adapterVersion:"2.0.0"
      }
    ]);

    const result = await runTrigger(service,store,{
      id:"doudian-retired-partial",appId:"retired-products-monitor",
      workflowId:"doudian.alliance-retired-products-monitor",
      workflowVersion:"3.0.0",workflowInput:{ maxShops:100 }
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
      "doudian.alliance.shop.retired-products.scan"
    ]);
    const intent = object(json(result.run.output)).operationalDatasetPublicationIntentId;
    expect(typeof intent).toBe("string");
    expect(store.listOperationalFactsForRun(result.run.id)).toHaveLength(1);
    const datasetIntent = object(object(json(result.run.output)).datasetIntent);
    expect(store.getOperationalDatasetPublicationLineage(
      String(datasetIntent.datasetId),String(datasetIntent.version)
    )).toMatchObject({
      runId:result.run.id,terminalStatus:"uncertain",quality:"partial",
      coverage:{ discovered:2,collectable:2,attempted:2,persisted:1,failed:1,skipped:0 }
    });
    expect(store.listBrowserControlLeases(new Date().toISOString())).toEqual([]);
    store.close();
  });

  it("fails retired-products discovery without Dataset when an active shop lacks an id",async () => {
    const store = new SqlitePersistence({ path:":memory:" });
    const providers = new RuntimeProviderRegistry();
    providers.register(new FixtureProvider(
      "browser",[],undefined,undefined,{
        shops:[{
          key:"name:测试店铺",name:"测试店铺",status:"active",statusText:"经营中"
        }]
      }
    ));
    const service = new LocalCoreService(store,undefined,providers);
    for (const path of [
      "nodes/core/doudian.alliance.shops.discover.node.yaml",
      "nodes/core/doudian.alliance.shop.retired-products.scan.node.yaml",
      "nodes/core/doudian.alliance.shop.retired-products.fact.persist.node.yaml",
      "nodes/core/doudian.alliance.retired-products.aggregate.node.yaml",
      "nodes/core/doudian.alliance.retired-products.dataset.prepare.node.yaml"
    ]) publish(service,"node",path);
    publish(service,"adapter","adapters/doudian/doudian-alliance.adapter.yaml");
    publish(
      service,"workflow",
      "workflows/examples/doudian.alliance-retired-products-monitor.workflow.yaml"
    );
    seedBrowser(store,[{
      id:"doudian.alliance.shops.discover",version:"2.0.0",riskLevel:"R2",
      permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
      adapterId:"doudian-alliance",adapterVersion:"2.0.0"
    },{
      id:"doudian.alliance.shop.retired-products.scan",version:"2.0.0",riskLevel:"R2",
      permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
      adapterId:"doudian-alliance",adapterVersion:"2.0.0"
    }]);

    const result = await runTrigger(service,store,{
      id:"doudian-retired-active-no-id",appId:"retired-products-monitor",
      workflowId:"doudian.alliance-retired-products-monitor",
      workflowVersion:"3.0.0",workflowInput:{ maxShops:100 }
    });
    expect(result.run).toMatchObject({ status:"uncertain" });
    expect(store.getEngineCheckpoint(result.run.id)?.state).toMatchObject({
      status:"uncertain",error:{ code:"DOUDIAN_ALLIANCE_DISCOVERY_INCOMPLETE" }
    });
    expect(store.listEvents(result.run.id).at(-1)).toMatchObject({
      payload:{
        errorCode:"SHOP_IDENTITY_UNCERTAIN",
        error:{ code:"DOUDIAN_ALLIANCE_DISCOVERY_INCOMPLETE" }
      }
    });
    expect(store.listOperationalFactsForRun(result.run.id)).toEqual([]);
    expect(store.getPreparedOperationalDatasetPublication(result.run.id)).toBeUndefined();
    store.close();
  });

  it("treats a genuinely blocked shop without id as normal skipped coverage",async () => {
    const store = new SqlitePersistence({ path:":memory:" });
    const providers = new RuntimeProviderRegistry();
    providers.register(new FixtureProvider(
      "browser",[],undefined,undefined,{
        shops:[
          { key:"id:10001",id:"10001",name:"测试店铺一",status:"active",statusText:"经营中" },
          { key:"name:测试店铺二",name:"测试店铺二",status:"blocked",statusText:"已停业" }
        ]
      }
    ));
    const service = new LocalCoreService(store,undefined,providers);
    for (const path of [
      "nodes/core/doudian.alliance.shops.discover.node.yaml",
      "nodes/core/doudian.alliance.shop.retired-products.scan.node.yaml",
      "nodes/core/doudian.alliance.shop.retired-products.fact.persist.node.yaml",
      "nodes/core/doudian.alliance.retired-products.aggregate.node.yaml",
      "nodes/core/doudian.alliance.retired-products.dataset.prepare.node.yaml"
    ]) publish(service,"node",path);
    publish(service,"adapter","adapters/doudian/doudian-alliance.adapter.yaml");
    publish(
      service,"workflow",
      "workflows/examples/doudian.alliance-retired-products-monitor.workflow.yaml"
    );
    seedBrowser(store,[{
      id:"doudian.alliance.shops.discover",version:"2.0.0",riskLevel:"R2",
      permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
      adapterId:"doudian-alliance",adapterVersion:"2.0.0"
    },{
      id:"doudian.alliance.shop.retired-products.scan",version:"2.0.0",riskLevel:"R2",
      permissions:["browser.dom.read","browser.dom.write","browser.tabs.read","browser.tabs.navigate"],
      adapterId:"doudian-alliance",adapterVersion:"2.0.0"
    }]);
    const result = await runTrigger(service,store,{
      id:"doudian-retired-blocked-skip",appId:"retired-products-monitor",
      workflowId:"doudian.alliance-retired-products-monitor",
      workflowVersion:"3.0.0",workflowInput:{ maxShops:100 }
    });
    expect(result.run).toMatchObject({
      status:"succeeded",
      output:{ scan:{
        status:"complete_with_items",discoveredCount:2,collectableCount:1,
        persistedCount:1,failedCount:0,skippedCount:1
      } }
    });
    const datasetIntent = object(object(json(result.run.output)).datasetIntent);
    expect(store.getOperationalDatasetPublicationLineage(
      String(datasetIntent.datasetId),String(datasetIntent.version)
    )).toMatchObject({
      quality:"complete",
      coverage:{ discovered:2,collectable:1,attempted:1,persisted:1,failed:0,skipped:1 }
    });
    store.close();
  });
});
