import {
  readDoudianExperienceSnapshot,
  type ExperienceShop,
  type ExperienceSnapshot
} from "@bpa/adapter-doudian";

export interface ExperienceScoreStageRequest {
  readonly stage: "collect-snapshot";
  readonly expectedShop: ExperienceShop;
}

export interface ExperienceScoreStageResult {
  readonly stage: "collect-snapshot";
  readonly snapshot: ExperienceSnapshot;
}

export function executeExperienceScoreStage(
  request: ExperienceScoreStageRequest,
  doc: Document = document,
  pageUrl: string = location.href
): ExperienceScoreStageResult {
  return {
    stage: request.stage,
    snapshot: readDoudianExperienceSnapshot(
      doc,
      pageUrl,
      request.expectedShop
    )
  };
}
