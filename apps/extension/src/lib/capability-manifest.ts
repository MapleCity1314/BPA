import type { BridgeCapability } from "@bpa/browser-bridge";

export const BROWSER_PROTOCOL = "bpa.browser/1";
export const DOUDIAN_ADAPTER_VERSION = "1.2.0";
export const DOUDIAN_ORIGIN = "https://fxg.jinritemai.com";
export const CHANMAMA_ORIGIN = "https://www.chanmama.com";

export type ExtensionNodeId =
  | "browser.design.snapshot.capture"
  | "doudian.shop.context.read"
  | "doudian.product.scope.collect"
  | "doudian.product.scope.restore"
  | "doudian.product.editor.open"
  | "doudian.editor.priority-items.inspect";

export interface ExtensionCapability {
  readonly nodeId: ExtensionNodeId;
  readonly versions: readonly string[];
  readonly riskLevel: "R0";
  readonly permissions: readonly string[];
  readonly origins: readonly string[];
  readonly pathnames?: readonly string[];
  readonly adapter?: {
    readonly id: "doudian";
    readonly version: typeof DOUDIAN_ADAPTER_VERSION;
  };
}

const READ_ONLY_PERMISSIONS = [
  "browser.dom.read",
  "browser.tabs.read"
] as const;

export const EXTENSION_CAPABILITIES: readonly ExtensionCapability[] = [
  {
    nodeId: "browser.design.snapshot.capture",
    versions: ["1.0.0"],
    riskLevel: "R0",
    permissions: [
      "browser.dom.read",
      "browser.tabs.read",
      "page-model.design.read"
    ],
    origins: [DOUDIAN_ORIGIN, CHANMAMA_ORIGIN]
  },
  {
    nodeId: "doudian.shop.context.read",
    versions: ["1.0.0", "1.1.0", "1.2.0", "1.3.0"],
    riskLevel: "R0",
    permissions: READ_ONLY_PERMISSIONS,
    origins: [DOUDIAN_ORIGIN],
    pathnames: ["/ffa/g/list"],
    adapter: { id: "doudian", version: DOUDIAN_ADAPTER_VERSION }
  },
  {
    nodeId: "doudian.product.scope.collect",
    versions: ["1.0.0", "1.1.0"],
    riskLevel: "R0",
    permissions: READ_ONLY_PERMISSIONS,
    origins: [DOUDIAN_ORIGIN],
    pathnames: ["/ffa/g/list"],
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
    origins: [DOUDIAN_ORIGIN],
    pathnames: ["/ffa/g/list"],
    adapter: { id: "doudian", version: DOUDIAN_ADAPTER_VERSION }
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
    origins: [DOUDIAN_ORIGIN],
    pathnames: ["/ffa/g/create"],
    adapter: { id: "doudian", version: DOUDIAN_ADAPTER_VERSION }
  },
  {
    nodeId: "doudian.editor.priority-items.inspect",
    versions: ["1.0.0", "1.1.0"],
    riskLevel: "R0",
    permissions: READ_ONLY_PERMISSIONS,
    origins: [DOUDIAN_ORIGIN],
    pathnames: ["/ffa/g/create"],
    adapter: { id: "doudian", version: DOUDIAN_ADAPTER_VERSION }
  }
];

/**
 * Digest of the canonical public projection in `capabilityReport`.
 * Updating a capability requires updating this value and its fixture test.
 */
export const CAPABILITY_MANIFEST_DIGEST =
  "sha256:def82ff7eb616e77fc73d5fab278461a487752fc2addd88500e9e974c4d86aac";

export function capabilityReport(): {
  capabilities: Array<{
    node_id: ExtensionNodeId;
    versions: string[];
    risk_level: "R0";
    permissions: string[];
    adapter_id?: "doudian";
    adapter_version?: typeof DOUDIAN_ADAPTER_VERSION;
  }>;
  manifest_digest: typeof CAPABILITY_MANIFEST_DIGEST;
} {
  return {
    capabilities: EXTENSION_CAPABILITIES.map((capability) => ({
      node_id: capability.nodeId,
      versions: [...capability.versions],
      risk_level: capability.riskLevel,
      permissions: [...capability.permissions],
      ...(capability.adapter
        ? {
            adapter_id: capability.adapter.id,
            adapter_version: capability.adapter.version
          }
        : {})
    })),
    manifest_digest: CAPABILITY_MANIFEST_DIGEST
  };
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
  if (!knownNode.origins.includes(url.origin)) {
    return { valid: false, reason: "PAGE_ORIGIN_MISMATCH" };
  }
  if (
    knownNode.pathnames &&
    !knownNode.pathnames.includes(url.pathname)
  ) {
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
