export type ContentScriptFailureReason =
  | "BROWSER_CONTENT_SCRIPT_MISSING"
  | "BROWSER_TAB_INACCESSIBLE"
  | "BROWSER_CONTENT_PROBE_FAILED";

export class ContentScriptProbeError extends Error {
  constructor(
    readonly reasonCode: ContentScriptFailureReason,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ContentScriptProbeError";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingReceiver(error: unknown): boolean {
  return /receiving end does not exist|could not establish connection|message port closed|extension context invalidated/iu.test(
    errorText(error)
  );
}

export function contentScriptFailureReason(
  error: unknown
): ContentScriptFailureReason {
  if (error instanceof ContentScriptProbeError) return error.reasonCode;
  if (
    /no tab with id|tab was closed|discarded|cannot access contents of url|missing host permission/iu.test(
      errorText(error)
    )
  ) {
    return "BROWSER_TAB_INACCESSIBLE";
  }
  return isMissingReceiver(error)
    ? "BROWSER_CONTENT_SCRIPT_MISSING"
    : "BROWSER_CONTENT_PROBE_FAILED";
}

export class ContentScriptRecovery {
  readonly #inFlight = new Map<number, Promise<void>>();

  async probe<T>(input: {
    tabId: number;
    probe: () => Promise<T>;
    inject: () => Promise<void>;
  }): Promise<T> {
    try {
      return await input.probe();
    } catch (initialError) {
      if (!isMissingReceiver(initialError)) throw initialError;
      try {
        await this.#injectOnce(input.tabId, input.inject);
      } catch (injectionError) {
        const reasonCode = contentScriptFailureReason(injectionError);
        throw new ContentScriptProbeError(
          reasonCode === "BROWSER_CONTENT_PROBE_FAILED"
            ? "BROWSER_CONTENT_SCRIPT_MISSING"
            : reasonCode,
          `Content Script recovery failed: ${errorText(injectionError)}`,
          { cause: injectionError }
        );
      }
      return input.probe();
    }
  }

  forget(tabId: number): void {
    this.#inFlight.delete(tabId);
  }

  async #injectOnce(tabId: number, inject: () => Promise<void>): Promise<void> {
    const existing = this.#inFlight.get(tabId);
    if (existing) return existing;

    const pending = inject().finally(() => {
      if (this.#inFlight.get(tabId) === pending) {
        this.#inFlight.delete(tabId);
      }
    });
    this.#inFlight.set(tabId, pending);
    return pending;
  }
}
