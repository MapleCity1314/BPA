import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  WorkflowCandidateConflictError,
  WorkflowDraftConflictError,
  WorkflowOperationConflictError,
  type ApplyWorkflowDraftRevisionInput,
  type WorkflowCandidateRecord,
  type WorkflowDraftRecord
} from "@bpa/persistence";
import { SqlitePersistence } from "./index.js";

const createdAt = "2026-07-28T00:00:00.000Z";
const updatedAt = "2026-07-28T00:01:00.000Z";

function draft(
  draftId = "draft-1",
  content: unknown = {
    draftId,
    revision: 0,
    title: "重点项检查"
  }
): WorkflowDraftRecord {
  return {
    draftId,
    revision: 0,
    content,
    createdAt,
    updatedAt: createdAt
  };
}

function applyInput(
  overrides: Partial<ApplyWorkflowDraftRevisionInput> = {}
): ApplyWorkflowDraftRevisionInput {
  return {
    draftId: "draft-1",
    expectedRevision: 0,
    operationId: "operation-1",
    content: {
      draftId: "draft-1",
      revision: 1,
      title: "重点项检查",
      steps: { collect: { nodeRef: "doudian.product.scope.collect@1.0.0" } }
    },
    updatedAt,
    ...overrides
  };
}

function candidate(
  overrides: Partial<WorkflowCandidateRecord> = {}
): WorkflowCandidateRecord {
  return {
    candidateId: "candidate-1",
    draftId: "draft-1",
    sourceRevision: 1,
    content: {
      title: "重点项检查",
      steps: ["collect"]
    },
    createdAt: "2026-07-28T00:02:00.000Z",
    ...overrides
  };
}

describe("SQLite Workflow Draft persistence", () => {
  it("atomically creates the current Draft and immutable revision zero", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const record = draft();
    expect(store.createWorkflowDraft(record)).toEqual(record);
    expect(store.getWorkflowDraft("draft-1")).toEqual(record);
    expect(store.getWorkflowDraftRevision("draft-1", 0)).toEqual({
      draftId: "draft-1",
      revision: 0,
      content: record.content,
      createdAt
    });
    expect(store.getWorkflowDraftRevision("draft-1", 1)).toBeUndefined();
    expect(() => store.createWorkflowDraft(record)).toThrow(
      WorkflowDraftConflictError
    );
    store.close();
  });

  it("CAS-applies current and append-only history in one transaction", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    const initial = draft();
    store.createWorkflowDraft(initial);
    const input = applyInput();
    const result = store.applyWorkflowDraftRevision(input);
    expect(result).toEqual({
      status: "accepted",
      current: {
        draftId: "draft-1",
        revision: 1,
        content: input.content,
        createdAt,
        updatedAt
      },
      revision: {
        draftId: "draft-1",
        revision: 1,
        operationId: "operation-1",
        content: input.content,
        createdAt: updatedAt
      }
    });
    expect(store.getWorkflowDraftRevision("draft-1", 0)?.content).toEqual(
      initial.content
    );
    expect(store.getWorkflowDraftRevision("draft-1", 1)).toEqual(
      result.status === "accepted" ? result.revision : undefined
    );
    store.close();
  });

  it("deduplicates only an exact operation replay", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    store.createWorkflowDraft(draft());
    const input = applyInput();
    expect(store.applyWorkflowDraftRevision(input).status).toBe("accepted");
    expect(
      store.applyWorkflowDraftRevision(
        applyInput({
          expectedRevision: 1,
          operationId: "operation-2",
          content: { revision: 2 },
          updatedAt: "2026-07-28T00:02:00.000Z"
        })
      ).status
    ).toBe("accepted");
    expect(store.applyWorkflowDraftRevision(input)).toMatchObject({
      status: "duplicate",
      current: { revision: 1, content: input.content },
      revision: { revision: 1, operationId: input.operationId }
    });
    expect(store.getWorkflowDraft("draft-1")?.revision).toBe(2);
    expect(() =>
      store.applyWorkflowDraftRevision({
        ...input,
        content: { changed: true }
      })
    ).toThrow(WorkflowOperationConflictError);
    store.close();
  });

  it("lets only one concurrent CAS writer advance the Draft", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-draft-cas-"));
    const path = join(directory, "bpa.sqlite3");
    try {
      const first = new SqlitePersistence({ path });
      first.createWorkflowDraft(draft());
      const second = new SqlitePersistence({ path });
      expect(first.applyWorkflowDraftRevision(applyInput()).status).toBe(
        "accepted"
      );
      expect(
        second.applyWorkflowDraftRevision(
          applyInput({
            operationId: "operation-loser",
            content: { losing: true }
          })
        )
      ).toEqual({ status: "stale", actualRevision: 1 });
      expect(second.getWorkflowDraft("draft-1")?.revision).toBe(1);
      expect(
        second.getWorkflowDraftRevision("draft-1", 1)?.operationId
      ).toBe("operation-1");
      first.close();
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("saves Candidates immutably and permits only exact replay", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    store.createWorkflowDraft(draft());
    store.applyWorkflowDraftRevision(applyInput());
    const record = candidate();
    expect(store.saveWorkflowCandidate(record)).toEqual(record);
    expect(store.saveWorkflowCandidate(record)).toEqual(record);
    expect(store.getWorkflowCandidate(record.candidateId)).toEqual(record);
    expect(() =>
      store.saveWorkflowCandidate({
        ...record,
        content: { changed: true }
      })
    ).toThrow(WorkflowCandidateConflictError);
    expect(() =>
      store.saveWorkflowCandidate(
        candidate({
          candidateId: "candidate-missing-source",
          sourceRevision: 99
        })
      )
    ).toThrow(WorkflowDraftConflictError);
    store.close();
  });

  it("enforces append-only history and Candidate immutability in SQLite", () => {
    const directory = mkdtempSync(join(tmpdir(), "bpa-draft-immutable-"));
    const path = join(directory, "bpa.sqlite3");
    try {
      const store = new SqlitePersistence({ path });
      store.createWorkflowDraft(draft());
      store.applyWorkflowDraftRevision(applyInput());
      store.saveWorkflowCandidate(candidate());
      store.close();
      const raw = new Database(path);
      expect(() =>
        raw
          .prepare(
            "UPDATE workflow_draft_revisions SET content_json = '{}' WHERE draft_id = ? AND revision = 1"
          )
          .run("draft-1")
      ).toThrow(/append-only/u);
      expect(() =>
        raw
          .prepare(
            "UPDATE workflow_candidates SET content_json = '{}' WHERE candidate_id = ?"
          )
          .run("candidate-1")
      ).toThrow(/immutable/u);
      raw.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    "authoring.create.after_current",
    "authoring.create.after_history"
  ])("rolls back Draft creation after a crash at %s", (failurePoint) => {
    const store = new SqlitePersistence({
      path: ":memory:",
      failureInjector(point) {
        if (point === failurePoint) throw new Error("crash");
      }
    });
    expect(() => store.createWorkflowDraft(draft())).toThrow("crash");
    expect(store.getWorkflowDraft("draft-1")).toBeUndefined();
    expect(store.getWorkflowDraftRevision("draft-1", 0)).toBeUndefined();
    store.close();
  });

  it.each([
    "authoring.apply.after_current",
    "authoring.apply.after_history"
  ])("rolls back current and history after a crash at %s", (failurePoint) => {
    let crash = false;
    const store = new SqlitePersistence({
      path: ":memory:",
      failureInjector(point) {
        if (crash && point === failurePoint) throw new Error("crash");
      }
    });
    store.createWorkflowDraft(draft());
    crash = true;
    expect(() => store.applyWorkflowDraftRevision(applyInput())).toThrow(
      "crash"
    );
    expect(store.getWorkflowDraft("draft-1")?.revision).toBe(0);
    expect(store.getWorkflowDraftRevision("draft-1", 1)).toBeUndefined();
    crash = false;
    expect(store.applyWorkflowDraftRevision(applyInput()).status).toBe(
      "accepted"
    );
    store.close();
  });

  it("rolls back a Candidate insert after a crash", () => {
    let crash = false;
    const store = new SqlitePersistence({
      path: ":memory:",
      failureInjector(point) {
        if (crash && point === "authoring.candidate.after_insert") {
          throw new Error("crash");
        }
      }
    });
    store.createWorkflowDraft(draft());
    store.applyWorkflowDraftRevision(applyInput());
    crash = true;
    expect(() => store.saveWorkflowCandidate(candidate())).toThrow("crash");
    expect(store.getWorkflowCandidate("candidate-1")).toBeUndefined();
    store.close();
  });

  it("rejects non-JSON authoring content before writing", () => {
    const store = new SqlitePersistence({ path: ":memory:" });
    expect(() =>
      store.createWorkflowDraft(draft("draft-1", { invalid: undefined }))
    ).toThrow(/JSON serializable/u);
    expect(store.getWorkflowDraft("draft-1")).toBeUndefined();
    store.close();
  });
});
