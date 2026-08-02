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
      try {
        await this.#injectOnce(input.tabId, input.inject);
      } catch {
        throw initialError;
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
