import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
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
});
