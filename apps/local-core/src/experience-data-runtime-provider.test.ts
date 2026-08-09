import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { contentDigest } from "@bpa/compiler";
import type {
  AuditRecord,
  DatasetVersionDefinition,
  OperationalDatasetCoverage,
  OperationalDatasetPublicationLineage,
  OperationalExecutionContext,
  OperationalFactRecord,
  OperationalFactStore,
  PreparedOperationalDatasetPublication
} from "@bpa/persistence";
import type { RuntimeInvocation } from "@bpa/node-runtime";
import type { ArtifactRef, JsonValue } from "@bpa/workflow-ir";
import { ExperienceDataRuntimeProvider } from "./experience-data-runtime-provider.js";

const observedAt = "2026-08-09T08:00:00.000Z";
const root = new URL("../../../",import.meta.url);

class MemoryFacts implements OperationalFactStore {
  readonly facts = new Map<string, OperationalFactRecord>();
  readonly preparations: Array<{
    publicationIntentId:string;
    runId:string;
    stagingId:string;
    dataset:DatasetVersionDefinition;
    factKeys:readonly string[];
    audit:AuditRecord;
    quality:"complete" | "partial";
    coverage:OperationalDatasetCoverage;
    executionContext:OperationalExecutionContext;
    preparedAt:string;
  }> = [];
  readonly prepared = new Map<string,PreparedOperationalDatasetPublication>();

  putOperationalFact(input:Parameters<OperationalFactStore["putOperationalFact"]>[0]) {
    const factKey = `fact:${contentDigest({
      namespace:input.namespace,runId:input.executionContext.identity.runId,
      businessDate:"2026-08-09",subjectId:input.subjectId,
      schemaVersion:input.schemaVersion
    }).slice(7)}`;
    const record = {
      ...(input.record as Record<string,JsonValue>),businessDate:"2026-08-09"
    } as JsonValue;
    const existing = this.facts.get(factKey);
    if (existing) return { status:"duplicate" as const,fact:existing };
    const fact:OperationalFactRecord = {
      factKey,namespace:input.namespace,
      runId:input.executionContext.identity.runId,
      businessDate:"2026-08-09",businessTimeZone:input.businessTimeZone,
      businessAnchorAt:observedAt,subjectId:input.subjectId,
      schemaVersion:input.schemaVersion,record,recordDigest:contentDigest(record),
      invocationId:input.executionContext.invocationId,
      node:input.executionContext.node,identity:input.executionContext.identity,
      idempotencyKey:input.executionContext.idempotencyKey,
      fencingToken:input.executionContext.fencingToken,
      observedAt:input.observedAt,persistedAt:input.persistedAt
    };
    this.facts.set(factKey,fact);
    return { status:"accepted" as const,fact };
  }

  getOperationalFact(factKey:string) { return this.facts.get(factKey); }

  listOperationalFactsForRun(runId:string) {
    return [...this.facts.values()]
      .filter((fact) => fact.runId === runId)
      .sort((left,right) => left.subjectId.localeCompare(right.subjectId));
  }

  getOperationalBusinessContext() {
    return { businessDate:"2026-08-09",anchorAt:observedAt };
  }

  prepareOperationalDatasetPublication(
    input:Parameters<OperationalFactStore["prepareOperationalDatasetPublication"]>[0]
  ) {
    this.preparations.push(input);
    const existing = this.prepared.get(input.runId);
    if (existing) return existing;
    const result:PreparedOperationalDatasetPublication = {
      publicationIntentId:input.publicationIntentId,runId:input.runId,
      stagingId:input.stagingId,dataset:input.dataset,factKeys:input.factKeys,
      audit:input.audit,quality:input.quality,businessDate:"2026-08-09",
      coverage:input.coverage,preparedBy:input.executionContext,
      preparedAt:input.preparedAt
    };
    this.prepared.set(input.runId,result);
    return result;
  }

  getPreparedOperationalDatasetPublication(runId:string) {
    return this.prepared.get(runId);
  }

  getOperationalDatasetPublicationLineage(
    _datasetId:string,
    _datasetVersion:string
  ):OperationalDatasetPublicationLineage | undefined {
    return undefined;
  }
}

function node(
  id:string,
  version:string
):ArtifactRef & { readonly kind:"node" } {
  return { kind:"node",id,version,digest:contentDigest({ id,version }) };
}

function invocation(input:{
  id:string;
  version:string;
  permission:string;
  riskLevel:"R0" | "R1";
  input:JsonValue;
  runId?:string;
  stepKey?:string;
  iterationKey?:string;
  scopePath?:RuntimeInvocation["identity"]["scopePath"];
}):RuntimeInvocation {
  const runId = input.runId ?? "run-experience";
  const stepKey = input.stepKey ?? input.id;
  const iterationKey = input.iterationKey ?? "root";
  return {
    invocationId:`invocation:${runId}:${stepKey}:${iterationKey}`,
    identity:{
      runId,scopePath:input.scopePath ?? [],iterationKey,stepKey,attempt:1
    },
    node:node(input.id,input.version),providerId:"experience-data",
    input:input.input,
    permissionSnapshot:{
      riskLevel:input.riskLevel,permissions:[input.permission],domains:[]
    },
    deadlineAt:Date.parse("2026-08-09T09:00:00.000Z"),
    idempotencyKey:`idempotency:${runId}:${stepKey}:${iterationKey}`,
    fencingToken:7,traceId:`trace:${runId}`
  };
}

function snapshot(
  shopId:string,
  status:"complete" | "no_score" = "complete"
):JsonValue {
  const metric = (key:string,label:string) => ({
    key,label,rawValue:"96.5分",value:96.5,unit:"分",score:96.5,
    scoreRaw:"得分96.5分",weight:100,weightRaw:"权重100%",
    numerator:null,denominator:null,change:null,note:null
  });
  return {
    status,shop:{ id:shopId,name:`测试店铺${shopId}` },observedAt,
    sourceUpdatedAt:null,
    summary:{
      totalScore:status === "complete" ? 96.5 : null,
      totalScoreRaw:status === "complete" ? "96.5分" : null,
      level:null,industry:"食品",orders30d:10,orders30dRaw:"10"
    },
    dimensions:status === "complete" ? [
      { key:"goods",label:"商品体验",score:97,scoreRaw:"得分97分",metrics:[metric("goods.composite_rating","商品综合评分")] },
      { key:"logistics",label:"物流体验",score:96,scoreRaw:"得分96分",metrics:[metric("logistics.delivery_sla_rate","运单配送时效达成率")] },
      { key:"service",label:"服务体验",score:96.5,scoreRaw:"得分96.5分",metrics:[metric("service.im_dissatisfaction_rate","飞鸽会话不满意率")] }
    ] : [],
    evidence:{
      pageUrl:`https://fxg.jinritemai.com/ffa/eco/experience-score?shop=${shopId}&session=private#fragment`,
      capturedAt:observedAt,structuredSnapshotRef:"inline:abcdef12"
    },
    diagnostics:["PRIVATE_DIAGNOSTIC"],formMutations:0
  };
}

async function persist(
  provider:ExperienceDataRuntimeProvider,
  shopId:string,
  status:"complete" | "no_score" = "complete",
  runId = "run-experience"
) {
  return provider.invoke(invocation({
    id:"doudian.experience.shop.fact.persist",version:"1.0.0",
    permission:"experience.fact.write",riskLevel:"R1",
    input:{ snapshot:snapshot(shopId,status) },runId,
    iterationKey:`id:${shopId}`,
    scopePath:[{ foreachStepKey:"collect_shops",itemKey:`id:${shopId}` }]
  }),new AbortController().signal);
}

function discoveredShop(
  id:string,
  status:"active" | "blocked" = "active"
):JsonValue {
  return {
    key:`id:${id}`,id,name:`测试店铺${id}`,status,
    statusText:status === "active" ? "经营中" : "已停业"
  };
}

function aggregateInvocation(
  foreachOutcome:JsonValue,
  discoveredCount:number,
  collectableCount:number,
  runId = "run-experience",
  discoveries:JsonValue[] = Array.from(
    { length:discoveredCount },
    (_,index) => discoveredShop(
      String(10001 + index),index < collectableCount ? "active" : "blocked"
    )
  )
) {
  return invocation({
    id:"doudian.experience.daily.aggregate",version:"2.0.0",
    permission:"experience.fact.read",riskLevel:"R0",runId,
    input:{
      foreachOutcome,discoveredShops:discoveries,
      discoveredCount,collectableCount
    }
  });
}

function declaredErrors(path:string):string[] {
  const value = parse(readFileSync(new URL(path,root),"utf8")) as {
    errors?:unknown;
  };
  if (!Array.isArray(value.errors)) throw new Error(`${path} has no errors`);
  return value.errors.map(String);
}

function outputOf(result:Awaited<ReturnType<ExperienceDataRuntimeProvider["invoke"]>>) {
  if (result.status !== "succeeded") throw new Error(result.error.message);
  return result.output as Record<string,JsonValue>;
}

describe("ExperienceDataRuntimeProvider",() => {
  it("supports only exact service Node refs and rejects expanded permission snapshots",async () => {
    const provider = new ExperienceDataRuntimeProvider(new MemoryFacts());
    expect(provider.supports(node("doudian.experience.shop.fact.persist","1.0.0"))).toBe(true);
    expect(provider.supports(node("doudian.experience.shop.fact.persist","1.0.1"))).toBe(false);
    expect(provider.supports(node("doudian.experience.daily.aggregate","1.0.0"))).toBe(false);
    const expanded = invocation({
      id:"doudian.experience.daily.aggregate",version:"2.0.0",
      permission:"experience.fact.read",riskLevel:"R0",
      input:{
        foreachOutcome:{},discoveredShops:[discoveredShop("10001")],
        discoveredCount:1,collectableCount:1
      }
    });
    const result = await provider.invoke({
      ...expanded,
      permissionSnapshot:{
        ...expanded.permissionSnapshot,
        permissions:["experience.fact.read","browser.dom.read"]
      }
    },new AbortController().signal);
    expect(result).toMatchObject({
      status:"rejected",error:{ code:"EXPERIENCE_FACT_PERMISSION_MISMATCH" }
    });
    for (const permissionSnapshot of [
      { ...expanded.permissionSnapshot,riskLevel:"R1" as const },
      { ...expanded.permissionSnapshot,domains:["https://fxg.jinritemai.com"] }
    ]) {
      await expect(provider.invoke({
        ...expanded,permissionSnapshot
      },new AbortController().signal)).resolves.toMatchObject({
        status:"rejected",error:{ code:"EXPERIENCE_FACT_PERMISSION_MISMATCH" }
      });
    }
  });

  it("returns only rejection and validation errors declared by each exact Node",async () => {
    const provider = new ExperienceDataRuntimeProvider(new MemoryFacts());
    const cases = [
      {
        path:"nodes/core/doudian.experience.shop.fact.persist.node.yaml",
        invocation:invocation({
          id:"doudian.experience.shop.fact.persist",version:"1.0.0",
          permission:"wrong",riskLevel:"R1",input:{ snapshot:null }
        }),
        code:"EXPERIENCE_FACT_PERMISSION_MISMATCH"
      },
      {
        path:"nodes/core/doudian.experience.daily.aggregate.node.yaml",
        invocation:invocation({
          id:"doudian.experience.daily.aggregate",version:"2.0.0",
          permission:"wrong",riskLevel:"R0",input:{}
        }),
        code:"EXPERIENCE_FACT_PERMISSION_MISMATCH"
      },
      {
        path:"nodes/core/doudian.experience.daily.dataset.prepare.node.yaml",
        invocation:invocation({
          id:"doudian.experience.daily.dataset.prepare",version:"1.0.0",
          permission:"wrong",riskLevel:"R1",input:{}
        }),
        code:"EXPERIENCE_DATASET_PERMISSION_MISMATCH"
      }
    ];
    for (const testCase of cases) {
      const result = await provider.invoke(
        testCase.invocation,new AbortController().signal
      );
      expect(result).toMatchObject({
        status:"rejected",error:{ code:testCase.code }
      });
      expect(declaredErrors(testCase.path)).toContain(testCase.code);
    }
  });

  it("persists only the controlled fact projection with runtime-owned execution context",async () => {
    const store = new MemoryFacts();
    const clock = () => new Date("2026-08-09T08:01:00.000Z");
    const provider = new ExperienceDataRuntimeProvider(store,clock);
    const result = outputOf(await persist(provider,"10001"));
    expect(result).toMatchObject({ status:"complete",inserted:true });
    const fact = [...store.facts.values()][0]!;
    expect(fact.persistedAt).toBe("2026-08-09T08:01:00.000Z");
    expect(fact.identity.runId).toBe("run-experience");
    expect(fact.node).toMatchObject({
      id:"doudian.experience.shop.fact.persist",version:"1.0.0"
    });
    expect(fact.record).toMatchObject({
      id:"10001",businessDate:"2026-08-09",
      evidence:{
        pageUrl:"https://fxg.jinritemai.com/ffa/eco/experience-score",
        capturedAt:observedAt
      }
    });
    const serialized = JSON.stringify(fact.record);
    expect(serialized).not.toContain("diagnostic");
    expect(serialized).not.toContain("session=");
    expect(serialized).not.toContain("structuredSnapshotRef");
    expect(serialized).not.toContain("inline:abcdef12");
  });

  it("rejects a snapshot whose subject is swapped across foreach identities",async () => {
    const store = new MemoryFacts();
    const provider = new ExperienceDataRuntimeProvider(store);
    const result = await provider.invoke(invocation({
      id:"doudian.experience.shop.fact.persist",version:"1.0.0",
      permission:"experience.fact.write",riskLevel:"R1",
      input:{ snapshot:snapshot("10002") },iterationKey:"id:10001",
      scopePath:[{ foreachStepKey:"collect_shops",itemKey:"id:10001" }]
    }),new AbortController().signal);
    expect(result).toMatchObject({
      status:"rejected",error:{ code:"EXPERIENCE_FACT_SCOPE_MISMATCH" }
    });
    expect(declaredErrors(
      "nodes/core/doudian.experience.shop.fact.persist.node.yaml"
    )).toContain("EXPERIENCE_FACT_SCOPE_MISMATCH");
    expect(store.facts.size).toBe(0);
  });

  it("treats no-score as a fact and inactive skipped shops as complete coverage",async () => {
    const store = new MemoryFacts();
    const provider = new ExperienceDataRuntimeProvider(store);
    const persisted = outputOf(await persist(provider,"10001","no_score"));
    const result = outputOf(await provider.invoke(aggregateInvocation({
      total:2,
      succeeded:{ count:2,items:[
        { itemKey:"id:10001",output:persisted },
        { itemKey:"id:10002",output:{ status:"skipped",shop:{ id:"10002" },diagnostics:["SHOP_NOT_ACTIVE"] } }
      ] },
      failed:{ count:0,items:[] },unresolved:{ count:0,items:[] }
    },2,1),new AbortController().signal));
    expect(result).toMatchObject({
      status:"complete",discoveredCount:2,collectableCount:1,
      attemptedCount:1,persistedCount:1,failedCount:0,skippedCount:1
    });
    expect(JSON.stringify(result.foreachOutcome)).not.toContain("SHOP_NOT_ACTIVE");
  });

  it("rejects a forged foreach marker that assigns one shop fact to another shop",async () => {
    const store = new MemoryFacts();
    const provider = new ExperienceDataRuntimeProvider(store);
    const persisted = outputOf(await persist(provider,"10001"));
    const factCount = store.facts.size;
    const result = await provider.invoke(aggregateInvocation({
      total:2,
      succeeded:{ count:2,items:[
        { itemKey:"id:10002",output:persisted },
        { itemKey:"id:10001",output:{ status:"skipped" } }
      ] },
      failed:{ count:0,items:[] },unresolved:{ count:0,items:[] }
    },2,1),new AbortController().signal);
    expect(result).toMatchObject({
      status:"rejected",error:{ code:"EXPERIENCE_FACT_SCOPE_MISMATCH" }
    });
    expect(store.facts.size).toBe(factCount);
    expect(store.preparations).toEqual([]);
  });

  it("rejects an active discovery without a stable shop id",async () => {
    const store = new MemoryFacts();
    const provider = new ExperienceDataRuntimeProvider(store);
    const result = await provider.invoke(aggregateInvocation({
      total:1,succeeded:{ count:0,items:[] },
      failed:{ count:1,items:[{ itemKey:"name:测试店铺" }] },
      unresolved:{ count:0,items:[] }
    },1,1,"run-active-no-id",[{
      key:"name:测试店铺",name:"测试店铺",status:"active",statusText:"经营中"
    }]),new AbortController().signal);
    expect(result).toMatchObject({
      status:"rejected",error:{ code:"EXPERIENCE_FACT_SCOPE_MISMATCH" }
    });
    expect(store.facts.size).toBe(0);
  });

  it("derives partial and zero-fact failure from current Run facts plus foreach coverage",async () => {
    const store = new MemoryFacts();
    const provider = new ExperienceDataRuntimeProvider(store);
    const persisted = outputOf(await persist(provider,"10001"));
    const partial = outputOf(await provider.invoke(aggregateInvocation({
      total:2,succeeded:{ count:1,items:[{ itemKey:"id:10001",output:persisted }] },
      failed:{ count:1,items:[{ itemKey:"id:10002",error:{ code:"READ_FAILED",message:"private" } }] },
      unresolved:{ count:0,items:[] }
    },2,2),new AbortController().signal));
    expect(partial).toMatchObject({
      status:"partial",attemptedCount:2,persistedCount:1,failedCount:1,skippedCount:0
    });
    expect(JSON.stringify(partial.foreachOutcome)).not.toContain("private");

    const emptyStore = new MemoryFacts();
    const emptyProvider = new ExperienceDataRuntimeProvider(emptyStore);
    const empty = outputOf(await emptyProvider.invoke(aggregateInvocation({
      total:1,succeeded:{ count:0,items:[] },
      failed:{ count:1,items:[{ itemKey:"id:10001",error:{ code:"READ_FAILED",message:"private" } }] },
      unresolved:{ count:0,items:[] }
    },1,1,"run-empty"),new AbortController().signal));
    expect(empty).toMatchObject({
      status:"failed",businessDate:"2026-08-09",observedAt,
      persistedCount:0,failedCount:1
    });
  });

  it("prepares one deterministic intent without publishing before terminal commit",async () => {
    const store = new MemoryFacts();
    const provider = new ExperienceDataRuntimeProvider(store);
    const persisted = outputOf(await persist(provider,"10001"));
    const daily = outputOf(await provider.invoke(aggregateInvocation({
      total:1,succeeded:{ count:1,items:[{ itemKey:"id:10001",output:persisted }] },
      failed:{ count:0,items:[] },unresolved:{ count:0,items:[] }
    },1,1),new AbortController().signal));
    const prepareInvocation = invocation({
      id:"doudian.experience.daily.dataset.prepare",version:"1.0.0",
      permission:"experience.dataset.prepare",riskLevel:"R1",
      input:{ daily }
    });
    const first = outputOf(await provider.invoke(
      prepareInvocation,new AbortController().signal
    ));
    const second = outputOf(await provider.invoke(
      prepareInvocation,new AbortController().signal
    ));
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      status:"prepared",datasetStatus:"complete",
      datasetId:"doudian-experience-daily",recordCount:1,
      version:expect.stringMatching(/^2026\.8\.9-run\.[0-9a-f]{32}$/u),
      recordsDigest:expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    });
    const prepared = store.getPreparedOperationalDatasetPublication("run-experience")!;
    expect(prepared.dataset.profile).toEqual({
      id:"doudian-experience-v1",version:"1.0.0"
    });
    const canonicalRecords = JSON.stringify(
      store.listOperationalFactsForRun("run-experience").map((fact) => fact.record)
    );
    expect(prepared.dataset.source.size).toBeGreaterThan(0);
    expect(prepared.dataset.source.digest).toBe(prepared.dataset.recordsDigest);
    expect(prepared.preparedAt).toBe(observedAt);
    expect(store.getOperationalDatasetPublicationLineage(
      prepared.dataset.metadata.id,prepared.dataset.metadata.version
    )).toBeUndefined();
    expect(canonicalRecords).not.toContain("structuredSnapshotRef");
  });
});
