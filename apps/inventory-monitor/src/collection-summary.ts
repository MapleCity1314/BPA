export interface FailedInventoryProduct {
  readonly productId: string;
  readonly stage: string;
  readonly errorCode: string;
  readonly evidenceId: string;
}

export interface InventoryCollectionSummary {
  readonly discovered: number;
  readonly attempted: number;
  readonly persisted: number;
  readonly failed: number;
  readonly skipped: number;
  readonly coverage: number;
  readonly outcome: "complete" | "partial" | "blocked";
  readonly failedProducts: readonly FailedInventoryProduct[];
}

export function buildInventoryCollectionSummary(input: {
  discovered:number;
  alreadyFresh:number;
  attempted:number;
  persisted:number;
  failedProducts:readonly FailedInventoryProduct[];
  blocked?:boolean;
}): InventoryCollectionSummary {
  const covered = Math.min(input.discovered,input.alreadyFresh + input.persisted);
  const failed = input.failedProducts.length;
  const skipped = Math.max(0,input.discovered - input.alreadyFresh - input.attempted);
  return {
    discovered:input.discovered,attempted:input.attempted,persisted:input.persisted,
    failed,skipped,
    coverage:input.discovered === 0 ? 0 : covered / input.discovered,
    outcome:input.blocked || covered === 0
      ? "blocked"
      : failed > 0 || covered < input.discovered
        ? "partial"
        : "complete",
    failedProducts:[...input.failedProducts]
  };
}
