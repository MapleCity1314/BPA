import {
  detectDoudianRiskSignals,
  readDoudianShopContext
} from "@bpa/adapter-doudian";
import { firstBlockingRiskSignal } from "@bpa/node-runtime";

export type PageAuthenticationState =
  | "unknown"
  | "anonymous"
  | "authenticated"
  | "membership";

export type PageObservationState =
  | "content_script_missing"
  | "loading"
  | "probing"
  | "auth_required"
  | "challenge"
  | "ready"
  | "departed"
  | "stale";

export interface PageProbeResult {
  readonly observerCapabilityId: string;
  readonly authentication: {
    readonly state: PageAuthenticationState;
    readonly contextRef?: string;
  };
  readonly observationState: PageObservationState;
  readonly reasonCode?: string;
}

interface PageObserver {
  readonly capabilityId: string;
  supports(url: URL): boolean;
  probe(document: Document, url: URL): Promise<PageProbeResult>;
}

function isAuthenticationPath(pathname: string): boolean {
  return /(?:^|\/)(?:login|passport|signin|authorize)(?:\/|$)/iu.test(
    pathname
  );
}

async function authenticationContextRef(
  observerCapabilityId: string,
  identity: string
): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${observerCapabilityId}\u0000${identity.normalize("NFKC")}`
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `auth-context-${hex}`;
}

const observers: readonly PageObserver[] = [
  {
    capabilityId: "doudian.page",
    supports: (url) => url.origin === "https://fxg.jinritemai.com",
    async probe(document, url) {
      if (isAuthenticationPath(url.pathname)) {
        return {
          observerCapabilityId: this.capabilityId,
          authentication: { state: "anonymous" },
          observationState: "auth_required",
          reasonCode: "SESSION_EXPIRED"
        };
      }
      const blocking = firstBlockingRiskSignal(
        detectDoudianRiskSignals(document, url.href)
      );
      if (blocking) {
        return {
          observerCapabilityId: this.capabilityId,
          authentication: {
            state:
              blocking.code === "SESSION_EXPIRED"
                ? "anonymous"
                : "unknown"
          },
          observationState:
            blocking.code === "SESSION_EXPIRED"
              ? "auth_required"
              : "challenge",
          reasonCode: blocking.code
        };
      }
      try {
        const context = readDoudianShopContext(document, url.href);
        if (!context.shop.identity_confirmed) {
          return {
            observerCapabilityId: this.capabilityId,
            authentication: { state: "unknown" },
            observationState: "probing",
            reasonCode: "SHOP_IDENTITY_UNCONFIRMED"
          };
        }
        return {
          observerCapabilityId: this.capabilityId,
          authentication: {
            state: "authenticated",
            contextRef: await authenticationContextRef(
              this.capabilityId,
              `${context.shop.id}\u0000${context.shop.name}`
            )
          },
          observationState: "ready"
        };
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        return {
          observerCapabilityId: this.capabilityId,
          authentication: { state: "unknown" },
          observationState: code === "PAGE_LOADING" ? "loading" : "stale",
          reasonCode: code
        };
      }
    }
  },
  {
    capabilityId: "buyin.page",
    supports: (url) => url.origin === "https://buyin.jinritemai.com",
    async probe(_document, url) {
      return {
        observerCapabilityId: this.capabilityId,
        authentication: {
          state: isAuthenticationPath(url.pathname) ? "anonymous" : "unknown"
        },
        observationState: isAuthenticationPath(url.pathname)
          ? "auth_required"
          : "ready",
        ...(isAuthenticationPath(url.pathname)
          ? { reasonCode: "SESSION_EXPIRED" }
          : {})
      };
    }
  },
  {
    capabilityId: "chanmama.page",
    supports: (url) => url.origin === "https://www.chanmama.com",
    async probe() {
      return {
        observerCapabilityId: this.capabilityId,
        authentication: { state: "unknown" },
        observationState: "ready"
      };
    }
  }
];

export function observerCapabilityForUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return observers.find((observer) => observer.supports(url))?.capabilityId;
  } catch {
    return undefined;
  }
}

export async function probeObservedPage(
  document: Document,
  value: string
): Promise<PageProbeResult> {
  const url = new URL(value);
  const observer = observers.find((candidate) => candidate.supports(url));
  if (!observer) throw new Error("PAGE_OBSERVER_NOT_FOUND");
  return observer.probe(document, url);
}
