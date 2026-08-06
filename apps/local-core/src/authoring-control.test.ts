import {
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { verifyCandidateArchive } from "@bpa/candidate-archive";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { LocalCoreService } from "./control.js";

function fixture(path: string): unknown {
  return parse(
    readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8")
  );
}

describe("Local Core incremental authoring", () => {
  it("persists CAS Draft revisions, semantic diff and immutable Candidate", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const service = new LocalCoreService(persistence);
    expect(
      service.handle({
        id: "publish-node",
        method: "asset.publish",
        params: {
          assetType: "node",
          content: fixture("nodes/core/data.constant.node.yaml"),
          actor: "test"
        }
      }).ok
    ).toBe(true);
    expect(
      service.handle({
        id: "draft-create",
        method: "authoring.workflow-draft.create",
        params: {
          id: "priority-check-draft",
          title: "重点项检查",
          description: "逐步创作的只读检查流程"
        }
      })
    ).toMatchObject({
      ok: true,
      result: { draftId: "priority-check-draft", revision: 0 }
    });
    expect(
      service.handle({
        id: "draft-step",
        method: "authoring.workflow-draft.apply",
        params: {
          draftId: "priority-check-draft",
          expectedRevision: 0,
          operation: {
            operationId: "add-constant",
            type: "step.add-or-replace",
            step: {
              key: "constant",
              nodeRef: "data.constant@1.0.0",
              config: { value: { ok: true } },
              inputBindings: {}
            }
          }
        }
      })
    ).toMatchObject({
      ok: true,
      result: { revision: 1, steps: { constant: {} } }
    });
    expect(
      service.handle({
        id: "draft-test",
        method: "authoring.workflow-draft.apply",
        params: {
          draftId: "priority-check-draft",
          expectedRevision: 1,
          operation: {
            operationId: "add-success-test",
            type: "test.add",
            test: {
              testId: "success",
              title: "固定值成功",
              scenario: "success",
              input: {},
              expected: { ok: true }
            }
          }
        }
      })
    ).toMatchObject({
      ok: true,
      result: { revision: 2, tests: { success: {} } }
    });
    expect(
      service.handle({
        id: "draft-stale",
        method: "authoring.workflow-draft.apply",
        params: {
          draftId: "priority-check-draft",
          expectedRevision: 0,
          operation: {
            operationId: "stale-update",
            type: "metadata.update",
            patch: { title: "过期修改" }
          }
        }
      })
    ).toMatchObject({ ok: false });
    expect(
      service.handle({
        id: "draft-diff",
        method: "authoring.workflow-draft.diff",
        params: {
          draftId: "priority-check-draft",
          fromRevision: 0,
          toRevision: 2,
          limit: 20
        }
      })
    ).toMatchObject({
      ok: true,
      result: {
        fromRevision: 0,
        toRevision: 2,
        truncated: false
      }
    });
    expect(
      service.handle({
        id: "draft-validate",
        method: "authoring.workflow-draft.validate-candidate",
        params: {
          draftId: "priority-check-draft",
          expectedRevision: 2
        }
      })
    ).toMatchObject({
      ok: true,
      result: { valid: true, issues: [] }
    });
    expect(
      service.handle({
        id: "candidate-save",
        method: "authoring.workflow-candidate.save",
        params: {
          draftId: "priority-check-draft",
          expectedRevision: 2,
          candidateId: "priority-check-candidate"
        }
      })
    ).toMatchObject({
      ok: true,
      result: {
        candidateId: "priority-check-candidate",
        status: "candidate",
        sourceRevision: 2
      }
    });
    const restarted = new LocalCoreService(persistence);
    expect(
      restarted.handle({
        id: "draft-get",
        method: "authoring.workflow-draft.get",
        params: { draftId: "priority-check-draft" }
      })
    ).toMatchObject({
      ok: true,
      result: { revision: 2, steps: { constant: {} } }
    });
    expect(
      restarted.handle({
        id: "catalog-search",
        method: "catalog.search.v2",
        params: {
          capabilityIds: ["data.constant"],
          runtime: "builtin",
          maximumRisk: "R0",
          allowedPermissions: [],
          limit: 10
        }
      })
    ).toMatchObject({
      ok: true,
      result: [
        {
          entry: {
            id: "data.constant",
            version: "1.0.0",
            runtime: "builtin"
          },
          eligible: true
        }
      ]
    });
    persistence.close();
  });

  it("creates a governed Authoring Session and saves an inert Candidate Bundle", () => {
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const dataDirectory = mkdtempSync(
      join(tmpdir(), "bpa-candidate-export-")
    );
    const service = new LocalCoreService(
      persistence,
      undefined,
      undefined,
      undefined,
      dataDirectory
    );
    const scenario = fixture(
      "docs/protocols/examples/authoring-scenario-spec-v1alpha1.example.json"
    );
    const created = service.handle({
      id: "authoring-create",
      method: "authoring.session.create",
      params: {
        sessionId: "authoring-session-control",
        scenario,
        actor: { type: "ai", id: "codex:local" },
        occurredAt: "2026-07-30T03:00:00.000Z"
      }
    });
    expect(created).toMatchObject({
      ok: true,
      result: {
        sessionId: "authoring-session-control",
        revision: 0,
        state: "intake",
        actor: { type: "ai", id: "codex:local" }
      }
    });
    expect(
      service.handle({
        id: "authoring-create-replay",
        method: "authoring.session.create",
        params: {
          sessionId: "authoring-session-control",
          scenario,
          actor: { type: "ai", id: "codex:local" },
          occurredAt: "2026-07-30T03:00:01.000Z"
        }
      })
    ).toMatchObject({
      ok: true,
      result: { revision: 0 }
    });

    const apply = (
      expectedRevision: number,
      operation: Record<string, unknown>,
      occurredAt: string
    ) =>
      service.handle({
        id: String(operation.operationId),
        method: "authoring.session.apply",
        params: {
          sessionId: "authoring-session-control",
          expectedRevision,
          operation,
          actor: "codex:local",
          occurredAt
        }
      });

    const enterCatalog = apply(
      0,
      {
        operationId: "operation-enter-catalog",
        type: "state.transition",
        state: "catalog"
      },
      "2026-07-30T03:00:01.000Z"
    );
    expect(enterCatalog).toMatchObject({
      ok: true,
      result: {
        status: "accepted",
        current: { revision: 1, state: "catalog" }
      }
    });
    expect(
      apply(
        0,
        {
          operationId: "operation-enter-catalog",
          type: "state.transition",
          state: "catalog"
        },
        "2026-07-30T03:00:01.000Z"
      )
    ).toMatchObject({
      ok: true,
      result: { status: "duplicate" }
    });
    expect(
      apply(
        0,
        {
          operationId: "operation-stale",
          type: "state.transition",
          state: "catalog"
        },
        "2026-07-30T03:00:02.000Z"
      )
    ).toMatchObject({
      ok: true,
      result: { status: "stale", actualRevision: 1 }
    });

    expect(
      apply(
        1,
        {
          operationId: "operation-gap",
          type: "capability-gap.upsert",
          gap: {
            gapId: "gap-chanmama-metrics",
            capabilityId: "chanmama.product.metrics.read",
            summary: "缺少只读指标节点",
            platform: "chanmama",
            requiredInputs: ["product_url"],
            requiredOutputs: ["product_metrics"],
            maximumRisk: "R1",
            status: "open"
          }
        },
        "2026-07-30T03:00:02.000Z"
      )
    ).toMatchObject({
      ok: true,
      result: {
        status: "accepted",
        current: {
          revision: 2,
          capabilityGaps: [{ gapId: "gap-chanmama-metrics" }]
        }
      }
    });
    expect(
      apply(
        2,
        {
          operationId: "operation-enter-discovery",
          type: "state.transition",
          state: "discovery"
        },
        "2026-07-30T03:00:03.000Z"
      )
    ).toMatchObject({ ok: true, result: { status: "accepted" } });
    expect(
      apply(
        3,
        {
          operationId: "operation-enter-modeling",
          type: "state.transition",
          state: "modeling"
        },
        "2026-07-30T03:00:04.000Z"
      )
    ).toMatchObject({ ok: true, result: { status: "accepted" } });
    expect(
      apply(
        4,
        {
          operationId: "operation-enter-assembly",
          type: "state.transition",
          state: "assembly"
        },
        "2026-07-30T03:00:05.000Z"
      )
    ).toMatchObject({ ok: true, result: { status: "accepted" } });
    expect(
      apply(
        5,
        {
          operationId: "operation-enter-validation",
          type: "state.transition",
          state: "validation"
        },
        "2026-07-30T03:00:06.000Z"
      )
    ).toMatchObject({ ok: true, result: { status: "accepted" } });

    const current = service.handle({
      id: "authoring-get",
      method: "authoring.session.get",
      params: { sessionId: "authoring-session-control" }
    });
    expect(current).toMatchObject({
      ok: true,
      result: { revision: 6, state: "validation" }
    });
    const session = current.result as Record<string, any>;
    const bundle = fixture(
      "docs/protocols/examples/authoring-candidate-bundle-v1alpha1.example.json"
    ) as Record<string, any>;
    bundle.scenarioRef = session.scenarioRef;
    bundle.authoringSession = {
      id: session.sessionId,
      revision: session.revision
    };
    bundle.createdAt = "2026-07-30T03:00:07.000Z";
    const candidateNode = persistence.saveCandidate({
      assetType: "node",
      assetId: "chanmama.product.metrics.read",
      version: "0.1.0",
      digest: `sha256:${"3".repeat(64)}`,
      content: { kind: "Node", status: "candidate" },
      actor: "codex:local"
    });
    bundle.artifacts = [
      {
        kind: "node",
        id: candidateNode.assetId,
        version: candidateNode.version,
        digest: candidateNode.digest,
        status: "candidate"
      }
    ];
    bundle.files = [];
    bundle.dependencyClosure = [];

    const tooRisky = structuredClone(bundle);
    tooRisky.riskReport.ceiling = "R2";
    expect(
      service.handle({
        id: "bundle-risk-rejected",
        method: "authoring.candidate-bundle.save",
        params: {
          sessionId: session.sessionId,
          expectedRevision: session.revision,
          operationId: "operation-save-risky",
          actor: "codex:local",
          occurredAt: "2026-07-30T03:00:07.000Z",
          bundle: tooRisky
        }
      })
    ).toMatchObject({ ok: false });

    expect(
      service.handle({
        id: "bundle-save",
        method: "authoring.candidate-bundle.save",
        params: {
          sessionId: session.sessionId,
          expectedRevision: session.revision,
          operationId: "operation-save-bundle",
          actor: "codex:local",
          occurredAt: "2026-07-30T03:00:07.000Z",
          bundle
        }
      })
    ).toMatchObject({
      ok: true,
      result: {
        status: "accepted",
        record: {
          bundle: {
            status: "candidate",
            executionPolicy: {
              autoExecute: false,
              autoPublish: false,
              autoApplySource: false
            }
          }
        }
      }
    });
    expect(
      service.handle({
        id: "bundle-get",
        method: "authoring.candidate-bundle.get",
        params: { bundleId: bundle.metadata.id }
      })
    ).toMatchObject({
      ok: true,
      result: {
        validationResults: [
          {},
          {},
          {},
          {},
          {}
        ]
      }
    });
    const exported = service.handle({
      id: "bundle-export",
      method: "authoring.candidate-bundle.export",
      params: {
        bundleId: bundle.metadata.id,
        actor: "codex:local",
        occurredAt: "2026-07-30T03:00:08.000Z"
      }
    });
    expect(exported).toMatchObject({
      ok: true,
      result: {
        export: {
          bundleId: bundle.metadata.id,
          actor: "codex:local"
        },
        verification: { valid: true }
      }
    });
    const archivePath = (
      exported.result as { archivePath: string }
    ).archivePath;
    expect(
      verifyCandidateArchive(readFileSync(archivePath))
    ).toMatchObject({
      valid: true,
      manifest: { bundleId: bundle.metadata.id }
    });
    persistence.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });
});
