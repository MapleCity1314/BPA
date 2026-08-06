export interface FrozenPageBinding {
  readonly browserInstanceId: string;
  readonly tabId: number;
  readonly windowId?: number;
  readonly origin: string;
  readonly pageEpoch: string;
  readonly observationRevision: number;
  readonly authenticationContextRef?: string;
}

export interface LivePageObservation {
  readonly browserInstanceId: unknown;
  readonly tabId?: number | undefined;
  readonly windowId?: number | undefined;
  readonly url?: string | undefined;
  readonly pageEpoch?: string | undefined;
  readonly revision?: number | undefined;
  readonly contentScriptReady?: boolean | undefined;
  readonly observationState?: string | undefined;
  readonly authenticationContextRef?: string | undefined;
}

export function matchesFrozenPageBinding(
  frozen: FrozenPageBinding,
  live: LivePageObservation
): boolean {
  let origin: string;
  try {
    origin = new URL(live.url ?? "").origin;
  } catch {
    return false;
  }
  return (
    live.browserInstanceId === frozen.browserInstanceId &&
    live.tabId === frozen.tabId &&
    (frozen.windowId === undefined || live.windowId === frozen.windowId) &&
    origin === frozen.origin &&
    live.pageEpoch === frozen.pageEpoch &&
    Number.isSafeInteger(live.revision) &&
    live.revision! >= frozen.observationRevision &&
    live.authenticationContextRef === frozen.authenticationContextRef &&
    live.contentScriptReady === true &&
    live.observationState === "ready"
  );
}
