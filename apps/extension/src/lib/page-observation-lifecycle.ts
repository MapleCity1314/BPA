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

export interface TabUpdateObservationChange {
  readonly status?: string;
  readonly url?: string;
}

export function shouldForceNewPageEpoch(
  current: TrackedPageEpoch | undefined,
  change: TabUpdateObservationChange
): boolean {
  return (
    change.status === "loading" &&
    typeof change.url === "string" &&
    current?.url !== change.url
  );
}

export function shouldPreserveTrackedAuthentication(
  observationState: string,
  authenticationState: string
): boolean {
  return (
    authenticationState === "unknown" &&
    (observationState === "loading" || observationState === "probing")
  );
}
