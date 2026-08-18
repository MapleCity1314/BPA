import type { BridgeCapability } from "@bpa/browser-bridge";

export const BROWSER_PROTOCOL = "bpa.browser/2";
export const DOUDIAN_ADAPTER_VERSION = "1.2.0";
export const DOUDIAN_INVENTORY_ADAPTER_VERSION = "2.0.4";
export const DOUDIAN_ALLIANCE_ADAPTER_VERSION = "2.0.10";
export const DOUDIAN_ORIGIN = "https://fxg.jinritemai.com";
export const DOUDIAN_BUYIN_ORIGIN = "https://buyin.jinritemai.com";
export const CHANMAMA_ORIGIN = "https://www.chanmama.com";
export const DOUYIN_SEARCH_ORIGIN = "https://www.douyin.com";
export const TAOBAO_SEARCH_ORIGIN = "https://s.taobao.com";
export const JD_SEARCH_ORIGIN = "https://search.jd.com";
export const MARKETPLACE_ADAPTER_VERSION = "1.0.0";
export const BROWSER_FEATURES = [
  "page_observation_v2",
  "exact_tab_binding_v2",
  "active_page_probe_v1"
] as const;

export type ExtensionNodeId =
  | "browser.design.snapshot.capture"
  | "doudian.shop.context.read"
  | "doudian.product.scope.collect"
  | "doudian.product.scope.restore"
  | "doudian.inventory.shop.activate"
  | "doudian.inventory.product.snapshot.read"
  | "doudian.product.editor.open"
  | "doudian.editor.priority-items.inspect"
  | "doudian.alliance.shops.discover"
  | "doudian.alliance.shop.retired-products.scan"
  | "doudian.experience.shops.discover"
  | "doudian.experience.shop.snapshot.read"
  | "ecommerce.marketplace.search-results.read";

export interface ExtensionCapability {
  readonly nodeId: ExtensionNodeId;
  readonly versions: readonly string[];
  readonly riskLevel: "R0" | "R1" | "R2";
  readonly permissions: readonly string[];
  readonly routes: readonly {
    readonly origin: string;
    readonly pathnamePrefixes: readonly string[];
    readonly observerCapabilityId: string;
  }[];
  readonly adapter?: {
    readonly id: "doudian" | "doudian-inventory" | "doudian-alliance" | "doudian-experience" | "marketplace-search";
    readonly version: string;
  };
  readonly executionTarget?: "background";
  readonly includePageContext?: boolean;
}

const READ_ONLY_PERMISSIONS = [
  "browser.dom.read",
  "browser.tabs.read"
] as const;

export const EXTENSION_CAPABILITIES: readonly ExtensionCapability[] = [
  {
    nodeId: "ecommerce.marketplace.search-results.read",
    versions: ["1.0.0"],
    riskLevel: "R1",
    permissions: READ_ONLY_PERMISSIONS,
    routes: [
      {
        origin: DOUYIN_SEARCH_ORIGIN,
        pathnamePrefixes: ["/search"],
        observerCapabilityId: "douyin.marketplace-search.page"
      },
      {
        origin: TAOBAO_SEARCH_ORIGIN,
        pathnamePrefixes: ["/search"],
        observerCapabilityId: "taobao.marketplace-search.page"
      },
      {
        origin: JD_SEARCH_ORIGIN,
        pathnamePrefixes: ["/Search"],
        observerCapabilityId: "jd.marketplace-search.page"
      }
    ],
    adapter: { id: "marketplace-search", version: MARKETPLACE_ADAPTER_VERSION }
  },
  {
    nodeId: "browser.design.snapshot.capture",
    versions: ["1.0.0"],
    riskLevel: "R0",
    permissions: [
      "browser.dom.read",
      "browser.tabs.read",
      "page-model.design.read"
    ],
    routes: [
      {
        origin: DOUDIAN_ORIGIN,
        pathnamePrefixes: ["/ffa/"],
        observerCapabilityId: "doudian.page"
      },
      {
        origin: CHANMAMA_ORIGIN,
        pathnamePrefixes: ["/"],
        observerCapabilityId: "chanmama.page"
      }
    ],
    includePageContext: true
  },
  {
    nodeId: "doudian.shop.context.read",
    versions: ["1.0.0", "1.1.0", "1.2.0", "1.3.0"],
    riskLevel: "R0",
    permissions: READ_ONLY_PERMISSIONS,
    routes: [
      {
        origin: DOUDIAN_ORIGIN,
        pathnamePrefixes: ["/ffa/g/list"],
        observerCapabilityId: "doudian.page"
      }
    ],
    adapter: { id: "doudian", version: DOUDIAN_ADAPTER_VERSION },
    includePageContext: true
  },
  {
    nodeId: "doudian.product.scope.collect",
    versions: ["1.0.0", "1.1.0"],
    riskLevel: "R0",
    permissions: READ_ONLY_PERMISSIONS,
    routes: [
      {
        origin: DOUDIAN_ORIGIN,
        pathnamePrefixes: ["/ffa/g/list"],
        observerCapabilityId: "doudian.page"
      }
    ],
    adapter: { id: "doudian", version: DOUDIAN_ADAPTER_VERSION }
  },
  {
    nodeId: "doudian.product.scope.restore",
    versions: ["1.0.0"],
    riskLevel: "R0",
    permissions: [
      "browser.dom.read",
      "browser.tabs.read",
      "browser.tabs.navigate"
    ],
    routes: [
      {
        origin: DOUDIAN_ORIGIN,
        pathnamePrefixes: ["/ffa/g/list"],
        observerCapabilityId: "doudian.page"
      }
    ],
    adapter: { id: "doudian", version: DOUDIAN_ADAPTER_VERSION }
  },
  {
    nodeId: "doudian.inventory.shop.activate",
    versions: ["1.0.4"],
    riskLevel: "R1",
    permissions: [
      "browser.dom.read",
      "browser.dom.write",
      "browser.tabs.read",
      "browser.tabs.navigate"
    ],
    routes: [
      {
        origin: DOUDIAN_ORIGIN,
        pathnamePrefixes: ["/ffa/g/list"],
        observerCapabilityId: "doudian.page"
      }
    ],
    adapter: {
      id: "doudian-inventory",
      version: DOUDIAN_INVENTORY_ADAPTER_VERSION
    },
    executionTarget: "background"
  },
  {
    nodeId: "doudian.inventory.product.snapshot.read",
    versions: ["2.0.4"],
    riskLevel: "R1",
    permissions: [
      "browser.dom.read",
      "browser.dom.write",
      "browser.tabs.read"
    ],
    routes: [
      {
        origin: DOUDIAN_ORIGIN,
        pathnamePrefixes: ["/ffa/g/list"],
        observerCapabilityId: "doudian.page"
      }
    ],
    adapter: {
      id: "doudian-inventory",
      version: DOUDIAN_INVENTORY_ADAPTER_VERSION
    }
  },
  {
    nodeId: "doudian.product.editor.open",
    versions: ["1.0.0", "1.1.0"],
    riskLevel: "R0",
    permissions: [
      "browser.dom.read",
      "browser.tabs.read",
      "browser.tabs.navigate"
    ],
    routes: [
      {
        origin: DOUDIAN_ORIGIN,
        pathnamePrefixes: ["/ffa/g/create"],
        observerCapabilityId: "doudian.page"
      }
    ],
    adapter: { id: "doudian", version: DOUDIAN_ADAPTER_VERSION },
    includePageContext: true
  },
  {
    nodeId: "doudian.editor.priority-items.inspect",
    versions: ["1.0.0", "1.1.0"],
    riskLevel: "R0",
    permissions: READ_ONLY_PERMISSIONS,
    routes: [
      {
        origin: DOUDIAN_ORIGIN,
        pathnamePrefixes: ["/ffa/g/create"],
        observerCapabilityId: "doudian.page"
      }
    ],
    adapter: { id: "doudian", version: DOUDIAN_ADAPTER_VERSION }
  },
  {
    nodeId: "doudian.alliance.shops.discover",
    versions: ["2.0.10"],
    riskLevel: "R2",
    permissions: [
      "browser.dom.read",
      "browser.dom.write",
      "browser.tabs.read",
      "browser.tabs.navigate"
    ],
    routes: [
      {
        origin: DOUDIAN_ORIGIN,
        pathnamePrefixes: ["/ffa/g/list"],
        observerCapabilityId: "doudian.page"
      }
    ],
    adapter: {
      id: "doudian-alliance",
      version: DOUDIAN_ALLIANCE_ADAPTER_VERSION
    },
    executionTarget: "background"
  },
  {
    nodeId: "doudian.alliance.shop.retired-products.scan",
    versions: ["2.0.10"],
    riskLevel: "R2",
    permissions: [
      "browser.dom.read",
      "browser.dom.write",
      "browser.tabs.read",
      "browser.tabs.navigate"
    ],
    routes: [
      {
        origin: DOUDIAN_ORIGIN,
        pathnamePrefixes: ["/ffa/g/list"],
        observerCapabilityId: "doudian.page"
      },
      {
        origin: DOUDIAN_BUYIN_ORIGIN,
        pathnamePrefixes: ["/dashboard"],
        observerCapabilityId: "buyin.page"
      }
    ],
    adapter: {
      id: "doudian-alliance",
      version: DOUDIAN_ALLIANCE_ADAPTER_VERSION
    },
    executionTarget: "background"
  },
  {
    nodeId: "doudian.experience.shops.discover",
    versions: ["2.0.1"],
    riskLevel: "R1",
    permissions: [
      "browser.dom.read",
      "browser.dom.write",
      "browser.tabs.read",
      "browser.tabs.navigate"
    ],
    routes: [
      {
        origin: DOUDIAN_ORIGIN,
        pathnamePrefixes: ["/ffa/g/list"],
        observerCapabilityId: "doudian.page"
      }
    ],
    adapter: { id: "doudian-experience", version: "2.0.1" },
    executionTarget: "background"
  },
  {
    nodeId: "doudian.experience.shop.snapshot.read",
    versions: ["2.0.1"],
    riskLevel: "R1",
    permissions: [
      "browser.dom.read",
      "browser.dom.write",
      "browser.tabs.read",
      "browser.tabs.navigate"
    ],
    routes: [
      {
        origin: DOUDIAN_ORIGIN,
        pathnamePrefixes: ["/ffa/g/list", "/ffa/eco/experience-score"],
        observerCapabilityId: "doudian.page"
      }
    ],
    adapter: { id: "doudian-experience", version: "2.0.1" },
    executionTarget: "background"
  }
];

export interface ExtensionCapabilityReport {
  capabilities: Array<{
    node_id: ExtensionNodeId;
    versions: string[];
    risk_level: "R0" | "R1" | "R2";
    permissions: string[];
    routes: Array<{
      origin: string;
      pathname_prefixes: string[];
      observer_capability_id: string;
    }>;
    adapter_id?: "doudian" | "doudian-inventory" | "doudian-alliance" | "doudian-experience" | "marketplace-search";
    adapter_version?: string;
  }>;
  manifest_digest: `sha256:${string}`;
  features: [...typeof BROWSER_FEATURES];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function publicCapabilities(): ExtensionCapabilityReport["capabilities"] {
  return EXTENSION_CAPABILITIES.map((capability) => ({
      node_id: capability.nodeId,
      versions: [...capability.versions],
      risk_level: capability.riskLevel,
      permissions: [...capability.permissions],
      routes: capability.routes.map((route) => ({
        origin: route.origin,
        pathname_prefixes: [...route.pathnamePrefixes],
        observer_capability_id: route.observerCapabilityId
      })),
      ...(capability.adapter
        ? {
            adapter_id: capability.adapter.id,
            adapter_version: capability.adapter.version
          }
        : {})
    }));
}

export async function capabilityReport(): Promise<ExtensionCapabilityReport> {
  const capabilities = publicCapabilities();
  const features = [...BROWSER_FEATURES] as [...typeof BROWSER_FEATURES];
  const bytes = new TextEncoder().encode(
    canonicalJson({ capabilities, features })
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return {
    capabilities,
    features,
    manifest_digest: `sha256:${hex}`
  };
}

export function capabilityForUrl(value: string): ExtensionCapability | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return EXTENSION_CAPABILITIES.find(
    (capability) =>
      capability.routes.some(
        (route) =>
          route.origin === url.origin &&
          route.pathnamePrefixes.some((prefix) =>
            url.pathname.startsWith(prefix)
          )
      )
  );
}

export function observerCapabilityForUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  for (const capability of EXTENSION_CAPABILITIES) {
    const route = capability.routes.find(
      (candidate) =>
        candidate.origin === url.origin &&
        candidate.pathnamePrefixes.some((prefix) =>
          url.pathname.startsWith(prefix)
        )
    );
    if (route) return route.observerCapabilityId;
  }
  return undefined;
}

export type CapabilityRouteResult =
  | {
      readonly valid: true;
      readonly capability: ExtensionCapability;
      readonly url: URL;
    }
  | {
      readonly valid: false;
      readonly reason:
        | "UNKNOWN_ACTION"
        | "UNSUPPORTED_NODE_VERSION"
        | "PAGE_URL_INVALID"
        | "PAGE_ORIGIN_MISMATCH"
        | "PAGE_PATH_MISMATCH"
        | "PERMISSION_MISMATCH";
    };

export function resolveCapability(
  nodeId: string,
  nodeVersion: string
): ExtensionCapability | undefined {
  const capability = EXTENSION_CAPABILITIES.find(
    (candidate) => candidate.nodeId === nodeId
  );
  return capability?.versions.includes(nodeVersion)
    ? capability
    : undefined;
}

export function validateCapabilityRoute(input: {
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly currentUrl: string;
  readonly grantedPermissions: readonly string[];
}): CapabilityRouteResult {
  const knownNode = EXTENSION_CAPABILITIES.find(
    (candidate) => candidate.nodeId === input.nodeId
  );
  if (!knownNode) return { valid: false, reason: "UNKNOWN_ACTION" };
  if (!knownNode.versions.includes(input.nodeVersion)) {
    return { valid: false, reason: "UNSUPPORTED_NODE_VERSION" };
  }
  let url: URL;
  try {
    url = new URL(input.currentUrl);
  } catch {
    return { valid: false, reason: "PAGE_URL_INVALID" };
  }
  const route = knownNode.routes.find(
    (candidate) => candidate.origin === url.origin
  );
  if (!route) {
    return { valid: false, reason: "PAGE_ORIGIN_MISMATCH" };
  }
  if (!route.pathnamePrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
    return { valid: false, reason: "PAGE_PATH_MISMATCH" };
  }
  if (
    knownNode.permissions.some(
      (permission) => !input.grantedPermissions.includes(permission)
    )
  ) {
    return { valid: false, reason: "PERMISSION_MISMATCH" };
  }
  return { valid: true, capability: knownNode, url };
}

const PAGE_EPOCH_PATTERN =
  /^tab-(?<tabId>\d+):(?<timestamp>\d{10,16}):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export function validPageEpoch(
  pageEpoch: unknown,
  expectedTabId?: number
): pageEpoch is string {
  if (typeof pageEpoch !== "string") return false;
  const matched = pageEpoch.match(PAGE_EPOCH_PATTERN);
  if (!matched?.groups) return false;
  const tabId = Number(matched.groups.tabId);
  const timestamp = Number(matched.groups.timestamp);
  return (
    Number.isSafeInteger(tabId) &&
    tabId >= 0 &&
    Number.isSafeInteger(timestamp) &&
    timestamp > 0 &&
    (expectedTabId === undefined || tabId === expectedTabId)
  );
}

export function bridgeCapabilityFor(
  nodeId: string,
  nodeVersion: string
): BridgeCapability {
  const capability = resolveCapability(nodeId, nodeVersion);
  return {
    nodeId,
    nodeVersion: capability ? nodeVersion : "unsupported",
    riskLevel: capability?.riskLevel ?? "unsupported",
    permissions: capability ? [...capability.permissions] : []
  };
}
