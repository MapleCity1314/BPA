import { describe, expect, it } from "vitest";
import {
  ASSISTANCE_PANEL_STORAGE_KEY,
  AssistancePanelRepository,
  deriveSupervisionState,
  sanitizeAssistanceTask,
  type AssistancePanelStorage,
  type SafeAssistanceTask
} from "./assistance-panel.js";

class MemoryStorage implements AssistancePanelStorage {
  readonly values: Record<string, unknown> = {};

  async get(key: string): Promise<Record<string, unknown>> {
    return { [key]: this.values[key] };
  }

  async set(value: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, value);
  }
}

const timestamp = "2026-07-28T00:00:00.000Z";

function task(
  overrides: Partial<SafeAssistanceTask> = {}
): SafeAssistanceTask {
  return {
    taskId: "task-1",
    mode: "ai_review",
    status: "queued",
    profileId: "adapter_anomaly_review",
    summaryCode: "adapter_attention",
    updatedAt: timestamp,
    ...overrides
  };
}

describe("safe Assistance panel persistence", () => {
  it("distinguishes unattended, attention and action-required states", () => {
    expect(deriveSupervisionState([])).toBe("unattended");
    expect(deriveSupervisionState([task()])).toBe("attention");
    expect(
      deriveSupervisionState([
        task({
          mode: "human_action",
          ownerType: "human",
          summaryCode: "authorization_required"
        })
      ])
    ).toBe("action_required");
    expect(deriveSupervisionState([task({ status: "completed" })])).toBe(
      "unattended"
    );
  });

  it("persists across repository restarts and stores metadata only", async () => {
    const storage = new MemoryStorage();
    const first = new AssistancePanelRepository(
      storage,
      () => new Date(timestamp)
    );
    await first.upsert(
      task({
        mode: "human_action",
        ownerType: "human",
        profileId: "auth_takeover",
        summaryCode: "authorization_required"
      })
    );

    const restarted = new AssistancePanelRepository(
      storage,
      () => new Date("2026-07-28T00:01:00.000Z")
    );
    await expect(restarted.read()).resolves.toMatchObject({
      supervision: "action_required",
      tasks: [
        {
          taskId: "task-1",
          profileId: "auth_takeover",
          summaryCode: "authorization_required"
        }
      ]
    });
    expect(
      JSON.stringify(storage.values[ASSISTANCE_PANEL_STORAGE_KEY])
    ).not.toMatch(/evidence|raw|output|contextRefs|商品标题/u);
  });

  it("drops unknown fields and corrupt records when reading storage", async () => {
    const safe = sanitizeAssistanceTask({
      ...task(),
      rawEvidence: "sensitive",
      output: { secret: true },
      contextRefs: ["forbidden"]
    });
    expect(safe).toEqual(task());
    expect(safe).not.toHaveProperty("rawEvidence");
    expect(sanitizeAssistanceTask({ ...task(), taskId: "../unsafe" })).toBe(
      undefined
    );

    const storage = new MemoryStorage();
    storage.values[ASSISTANCE_PANEL_STORAGE_KEY] = {
      tasks: [{ secret: "raw evidence" }],
      updatedAt: timestamp
    };
    await expect(
      new AssistancePanelRepository(storage).read()
    ).resolves.toMatchObject({
      supervision: "unattended",
      tasks: []
    });
  });

  it("removes resolved tasks durably", async () => {
    const storage = new MemoryStorage();
    const repository = new AssistancePanelRepository(
      storage,
      () => new Date(timestamp)
    );
    await repository.upsert(task());
    await expect(repository.remove("task-1")).resolves.toMatchObject({
      supervision: "unattended",
      tasks: []
    });
    await expect(
      new AssistancePanelRepository(storage).read()
    ).resolves.toMatchObject({ tasks: [] });
  });
});
