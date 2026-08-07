import {
  detectDoudianRiskSignals,
  readDoudianShopContext,
  readDoudianVisibleShopIdentity
} from "@bpa/adapter-doudian";
import {
  detectMarketplaceRiskSignals,
  isMarketplaceSearchPageReady
} from "@bpa/adapter-marketplace";
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

function marketplaceObserver(
  capabilityId: string,
  origin: string
): PageObserver {
  return {
    capabilityId,
    supports: (url) => url.origin === origin,
    async probe(document, url) {
      if (isAuthenticationPath(url.pathname)) {
        return {
          observerCapabilityId: capabilityId,
          authentication: { state: "anonymous" },
          observationState: "auth_required",
          reasonCode: "SESSION_EXPIRED"
        };
      }
      const blocking = firstBlockingRiskSignal(
        detectMarketplaceRiskSignals(document, url.href)
      );
      if (blocking) {
        return {
          observerCapabilityId: capabilityId,
          authentication: {
            state: blocking.code === "SESSION_EXPIRED" ? "anonymous" : "unknown"
          },
          observationState:
            blocking.code === "SESSION_EXPIRED" ? "auth_required" : "challenge",
          reasonCode: blocking.code
        };
      }
      if (!isMarketplaceSearchPageReady(document, url.href)) {
        return {
          observerCapabilityId: capabilityId,
          authentication: { state: "unknown" },
          observationState: document.body ? "probing" : "loading",
          reasonCode: "MARKETPLACE_STRUCTURE_UNCONFIRMED"
        };
      }
      return {
        observerCapabilityId: capabilityId,
        authentication: { state: "unknown" },
        observationState: "ready"
      };
    }
  };
}

function hasInteractivePageShell(document: Document): boolean {
  return [...document.querySelectorAll("main, nav, [role='main'], #root, #app")]
    .some((element) => {
      const text = element.textContent?.replace(/\s+/gu, " ").trim() ?? "";
      return element.childElementCount > 0 && text.length > 1;
    });
}

const observers: readonly PageObserver[] = [
  marketplaceObserver("douyin.marketplace-search.page", "https://www.douyin.com"),
  marketplaceObserver("taobao.marketplace-search.page", "https://s.taobao.com"),
  marketplaceObserver("jd.marketplace-search.page", "https://search.jd.com"),
  {
    capabilityId: "doudian.page",
    supports: (url) =>
      url.origin === "https://fxg.jinritemai.com" &&
      [
        "/ffa/g/list",
        "/ffa/g/create",
        "/ffa/morder/order",
        "/ffa/eco/experience-score"
      ].some(
        (prefix) => url.pathname.startsWith(prefix)
      ),
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
        const identity = url.pathname === "/ffa/g/list"
          ? readDoudianShopContext(document, url.href).shop
          : (() => {
              const observed = readDoudianVisibleShopIdentity(document);
              return {
                id: observed.id,
                name: observed.name,
                identity_confirmed: observed.identityConfirmed
              };
            })();
        if (!identity.identity_confirmed) {
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
              `${identity.id}\u0000${identity.name}`
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
    supports: (url) =>
      url.origin === "https://buyin.jinritemai.com" &&
      url.pathname.startsWith("/dashboard"),
    async probe(document, url) {
      const requiresAuthentication = isAuthenticationPath(url.pathname);
      if (!requiresAuthentication && !hasInteractivePageShell(document)) {
        return {
          observerCapabilityId: this.capabilityId,
          authentication: { state: "unknown" },
          observationState: document.body ? "probing" : "loading",
          reasonCode: "BUYIN_STRUCTURE_UNCONFIRMED"
        };
      }
      return {
        observerCapabilityId: this.capabilityId,
        authentication: {
          state: requiresAuthentication ? "anonymous" : "unknown"
        },
        observationState: requiresAuthentication
          ? "auth_required"
          : "ready",
        ...(requiresAuthentication
          ? { reasonCode: "SESSION_EXPIRED" }
          : {})
      };
    }
  },
  {
    capabilityId: "chanmama.page",
    supports: (url) => url.origin === "https://www.chanmama.com",
    async probe(document, url) {
      if (isAuthenticationPath(url.pathname)) {
        return {
          observerCapabilityId: this.capabilityId,
          authentication: { state: "anonymous" },
          observationState: "auth_required",
          reasonCode: "SESSION_EXPIRED"
        };
      }
      if (!hasInteractivePageShell(document)) {
        return {
          observerCapabilityId: this.capabilityId,
          authentication: { state: "unknown" },
          observationState: document.body ? "probing" : "loading",
          reasonCode: "CHANMAMA_STRUCTURE_UNCONFIRMED"
        };
      }
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
