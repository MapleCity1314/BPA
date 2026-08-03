export interface TrackedPageEpoch {
  readonly url: string;
  readonly pageEpoch: string;
  readonly observationState?: string;
}

export function shouldReusePageEpoch(
  current: TrackedPageEpoch | undefined,
  nextUrl: string,
  forceNew: boolean
): boolean {
  return (
    !forceNew &&
    current?.url === nextUrl &&
    current.observationState !== "departed"
  );
}

export function shouldForgetTrackedObservation(reasonCode: string): boolean {
  return reasonCode === "TAB_CLOSED";
}
