import type {
  ElementContractDefinition,
  PageSnapshotDefinition,
  PageModelDefinition
} from "@bpa/schemas";

export const LOCATOR_STRATEGIES = [
  "business-id",
  "role-name",
  "label",
  "attribute",
  "relative-anchor",
  "css-diagnostic"
] as const;

export type LocatorStrategy = (typeof LOCATOR_STRATEGIES)[number];

/**
 * These serialized definitions intentionally mirror the canonical
 * bpa.page/v1alpha1 JSON Schemas. Domain-only evidence and Candidate state are
 * separate types below, so persisted assets never acquire an alternate shape.
 */
export type ElementContract = ElementContractDefinition;
export type PageModel = PageModelDefinition;
export type LocatorCandidate = ElementContract["candidates"][number];

export interface RedactionCoverage {
  passwords: true;
  tokens: true;
  cookies: true;
  hiddenInputs: true;
  personalData: true;
  largeText: true;
}

export interface PageSnapshotMetadata {
  snapshotId: string;
  source: "design-mode" | "fixture" | "replay";
  capturedAt: string;
  origin: string;
  path: string;
  pageState: string;
  contentDigest: string;
  redaction: {
    applied: true;
    policyVersion: string;
    coverage: RedactionCoverage;
  };
  rawEvidenceExpiresAt: string;
}

export interface ElementContractObservation {
  snapshot: PageSnapshotMetadata;
  /** Match count by candidates array index. */
  matchCounts: number[];
}

export type PageCapabilityImplementation =
  | {
      kind: "declarative-read";
      elementId: string;
      projection:
        | { kind: "text" }
        | { kind: "presence" }
        | { kind: "attribute"; name: string };
    }
  | {
      kind: "adapter-handler";
      elementId: string;
      handler: {
        id: string;
        version: string;
        digest: string;
      };
    };

export interface PinnedElementContract {
  definition: ElementContract;
  digest: string;
}

export interface PageAssetCandidate {
  candidateId: string;
  status: "candidate";
  pageModel: PageModel;
  contracts: PinnedElementContract[];
  implementations: PageCapabilityImplementation[];
  createdAt: string;
}

export interface PageAssetPublication {
  candidateId: string;
  status: "published";
  pageModel: PageModel;
  contracts: PinnedElementContract[];
  implementations: PageCapabilityImplementation[];
  publicationDigest: string;
  approvedBy: string;
  approvedAt: string;
}

export type DeclarativeReadResult =
  | {
      status: "succeeded";
      candidateIndex: number;
      strategy: Exclude<
        LocatorCandidate["strategy"],
        "css-diagnostic" | "relative-anchor"
      >;
      nodeIds: string[];
      value:
        | string
        | boolean
        | null
        | Array<string | boolean | null>;
    }
  | {
      status: "failed";
      code:
        | "DECLARATIVE_LOCATOR_UNSTABLE"
        | "DECLARATIVE_PROJECTION_EMPTY"
        | "DECLARATIVE_COMPLEX_LOCATOR_REQUIRED";
      message: string;
    };

export interface ModelValidationIssue {
  code:
    | "INVALID_IDENTITY"
    | "INVALID_ORIGIN"
    | "INVALID_PATH_PATTERN"
    | "INVALID_PAGE_STATE"
    | "INVALID_EXPECTED_COUNT"
    | "INVALID_LOCATOR"
    | "FORBIDDEN_LOCATOR"
    | "CSS_DIAGNOSTIC_ONLY"
    | "DUPLICATE_ID"
    | "INVALID_SNAPSHOT"
    | "INVALID_DESIGN_SESSION"
    | "INSUFFICIENT_EVIDENCE"
    | "COUNT_MISMATCH"
    | "INVALID_CANDIDATE"
    | "PUBLICATION_REJECTED";
  path: string;
  message: string;
}

export interface ElementContractValidation {
  valid: boolean;
  issues: ModelValidationIssue[];
  stableCandidateIndexes: number[];
  observedSnapshotDigests: string[];
}

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SEMVER_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_ATTRIBUTE_PATTERN =
  /^(?:data-[a-z0-9_-]+|name|href|type|aria-[a-z0-9_-]+)$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const FORBIDDEN_STRATEGIES = new Set([
  "xpath",
  "coordinate",
  "coordinates",
  "javascript",
  "js",
  "evaluate"
]);

function issue(
  code: ModelValidationIssue["code"],
  path: string,
  message: string
): ModelValidationIssue {
  return { code, path, message };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDigest(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

function parseTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function isExactOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === value &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function isSafePathPattern(value: string): boolean {
  return (
    value.startsWith("/") &&
    value.length <= 500 &&
    !value.includes("://") &&
    !value.includes("?") &&
    !value.includes("#") &&
    !/[()[\]{}\\]/.test(value)
  );
}

function pathMatches(pattern: string, path: string): boolean {
  if (!isSafePathPattern(pattern) || !path.startsWith("/")) return false;
  const fragments = pattern.split("*");
  if (fragments.length === 1) return path === pattern;
  let cursor = 0;
  for (const [index, fragment] of fragments.entries()) {
    const position = path.indexOf(fragment, cursor);
    if (position < 0 || (index === 0 && position !== 0)) return false;
    cursor = position + fragment.length;
  }
  return pattern.endsWith("*") || cursor === path.length;
}

function forbiddenText(value: string): boolean {
  return (
    /\bjavascript\s*:/i.test(value) ||
    /\bdocument\s*\./i.test(value) ||
    /\bwindow\s*\./i.test(value) ||
    /(?:^|[/\s])xpath(?:$|[/\s])/i.test(value)
  );
}

function metadataIssues(
  metadata: ElementContract["metadata"],
  path: string
): ModelValidationIssue[] {
  return !IDENTIFIER_PATTERN.test(metadata.id) ||
    !SEMVER_PATTERN.test(metadata.version) ||
    !isNonEmpty(metadata.title) ||
    metadata.title.length > 200 ||
    (metadata.description !== undefined && metadata.description.length > 4000)
    ? [
        issue(
          "INVALID_IDENTITY",
          path,
          "Metadata requires a stable ID, exact SemVer, and title"
        )
      ]
    : [];
}

function validateLocator(
  candidate: LocatorCandidate,
  path: string
): ModelValidationIssue[] {
  const rawStrategy = (candidate as { strategy?: unknown }).strategy;
  if (
    typeof rawStrategy !== "string" ||
    !LOCATOR_STRATEGIES.includes(rawStrategy as LocatorStrategy)
  ) {
    return [
      issue(
        FORBIDDEN_STRATEGIES.has(String(rawStrategy).toLowerCase())
          ? "FORBIDDEN_LOCATOR"
          : "INVALID_LOCATOR",
        `${path}/strategy`,
        "Only reviewed semantic locator strategies are allowed"
      )
    ];
  }
  let valid = false;
  switch (candidate.strategy) {
    case "business-id":
      valid = isNonEmpty(candidate.value) && !forbiddenText(candidate.value);
      break;
    case "role-name":
      valid =
        isNonEmpty(candidate.role) &&
        isNonEmpty(candidate.name) &&
        !forbiddenText(candidate.name);
      break;
    case "label":
      valid = isNonEmpty(candidate.label) && !forbiddenText(candidate.label);
      break;
    case "attribute":
      valid =
        SAFE_ATTRIBUTE_PATTERN.test(candidate.name) &&
        isNonEmpty(candidate.value) &&
        !forbiddenText(candidate.value);
      break;
    case "relative-anchor":
      valid =
        IDENTIFIER_PATTERN.test(candidate.anchor) &&
        isNonEmpty(candidate.role) &&
        isNonEmpty(candidate.name) &&
        !forbiddenText(candidate.name);
      break;
    case "css-diagnostic":
      valid =
        isNonEmpty(candidate.selector) &&
        !forbiddenText(candidate.selector) &&
        !/:nth-child\s*\(/i.test(candidate.selector);
      break;
  }
  return valid
    ? []
    : [
        issue(
          "INVALID_LOCATOR",
          path,
          "Locator must use safe declarative semantic fields"
        )
      ];
}

export function validateElementContractDefinition(
  contract: ElementContract,
  context?: {
    allowedOrigins?: readonly string[];
    knownPageStates?: readonly string[];
    knownElementIds?: readonly string[];
  }
): ModelValidationIssue[] {
  const issues = metadataIssues(contract.metadata, "/metadata");
  if (
    contract.apiVersion !== "bpa.page/v1alpha1" ||
    contract.kind !== "ElementContract" ||
    !isNonEmpty(contract.intent)
  ) {
    issues.push(
      issue(
        "INVALID_IDENTITY",
        "/",
        "ElementContract requires the canonical kind, API version, and intent"
      )
    );
  }
  if (
    contract.scope.origins.length === 0 ||
    contract.scope.origins.length > 20 ||
    new Set(contract.scope.origins).size !== contract.scope.origins.length
  ) {
    issues.push(
      issue(
        "INVALID_ORIGIN",
        "/scope/origins",
        "Element scope must declare unique exact origins"
      )
    );
  }
  for (const [index, origin] of contract.scope.origins.entries()) {
    if (
      !isExactOrigin(origin) ||
      (context?.allowedOrigins && !context.allowedOrigins.includes(origin))
    ) {
      issues.push(
        issue(
          "INVALID_ORIGIN",
          `/scope/origins/${index}`,
          "Element scope must bind exact PageModel origins"
        )
      );
    }
  }
  if (!isSafePathPattern(contract.scope.pathPattern)) {
    issues.push(
      issue(
        "INVALID_PATH_PATTERN",
        "/scope/pathPattern",
        "pathPattern must be a declarative absolute path with optional wildcards"
      )
    );
  }
  if (
    !IDENTIFIER_PATTERN.test(contract.scope.pageState) ||
    (context?.knownPageStates &&
      !context.knownPageStates.includes(contract.scope.pageState))
  ) {
    issues.push(
      issue(
        "INVALID_PAGE_STATE",
        "/scope/pageState",
        "pageState must be declared by the PageModel"
      )
    );
  }
  if (
    !Number.isSafeInteger(contract.expectedCount.minimum) ||
    !Number.isSafeInteger(contract.expectedCount.maximum) ||
    contract.expectedCount.minimum < 0 ||
    contract.expectedCount.maximum < 1 ||
    contract.expectedCount.minimum > contract.expectedCount.maximum ||
    contract.expectedCount.maximum > 10_000
  ) {
    issues.push(
      issue(
        "INVALID_EXPECTED_COUNT",
        "/expectedCount",
        "expectedCount must be an ordered bounded integer range"
      )
    );
  }
  if (contract.candidates.length === 0 || contract.candidates.length > 20) {
    issues.push(
      issue(
        "INVALID_LOCATOR",
        "/candidates",
        "ElementContract requires between 1 and 20 locator candidates"
      )
    );
  }
  contract.candidates.forEach((candidate, index) => {
    issues.push(...validateLocator(candidate, `/candidates/${index}`));
    if (
      candidate.strategy === "relative-anchor" &&
      context?.knownElementIds &&
      !context.knownElementIds.includes(candidate.anchor)
    ) {
      issues.push(
        issue(
          "INVALID_LOCATOR",
          `/candidates/${index}/anchor`,
          `Relative anchor is not declared by the PageModel: ${candidate.anchor}`
        )
      );
    }
  });
  if (
    contract.candidates.length > 0 &&
    contract.candidates.every(
      (candidate) => candidate.strategy === "css-diagnostic"
    )
  ) {
    issues.push(
      issue(
        "CSS_DIAGNOSTIC_ONLY",
        "/candidates",
        "CSS may support diagnostics but cannot be the only locator"
      )
    );
  }
  for (const [field, values] of [
    ["preconditions", contract.preconditions],
    ["postconditions", contract.postconditions]
  ] as const) {
    if (
      values.length > 50 ||
      new Set(values).size !== values.length ||
      values.some((value) => !IDENTIFIER_PATTERN.test(value))
    ) {
      issues.push(
        issue(
          "INVALID_IDENTITY",
          `/${field}`,
          `${field} must contain at most 50 unique semantic IDs`
        )
      );
    }
  }
  if (
    contract.validatedSnapshots.length < 2 ||
    contract.validatedSnapshots.length > 100 ||
    new Set(contract.validatedSnapshots).size !==
      contract.validatedSnapshots.length ||
    contract.validatedSnapshots.some((digest) => !isDigest(digest))
  ) {
    issues.push(
      issue(
        "INSUFFICIENT_EVIDENCE",
        "/validatedSnapshots",
        "ElementContract requires at least two unique validated snapshot digests"
      )
    );
  }
  return issues;
}

export function validatePageModel(model: PageModel): ModelValidationIssue[] {
  const issues = metadataIssues(model.metadata, "/metadata");
  if (
    model.apiVersion !== "bpa.page/v1alpha1" ||
    model.kind !== "PageModel" ||
    !IDENTIFIER_PATTERN.test(model.adapter.id) ||
    !SEMVER_PATTERN.test(model.adapter.version) ||
    !isDigest(model.adapter.digest)
  ) {
    issues.push(
      issue(
        "INVALID_IDENTITY",
        "/",
        "PageModel requires canonical identity and an exact Adapter closure"
      )
    );
  }
  if (
    model.origins.length === 0 ||
    model.origins.length > 20 ||
    new Set(model.origins).size !== model.origins.length
  ) {
    issues.push(
      issue(
        "INVALID_ORIGIN",
        "/origins",
        "PageModel origins must be a bounded unique list"
      )
    );
  }
  model.origins.forEach((origin, index) => {
    if (!isExactOrigin(origin)) {
      issues.push(
        issue(
          "INVALID_ORIGIN",
          `/origins/${index}`,
          "Origins must not contain paths, wildcards, credentials, query, or fragments"
        )
      );
    }
  });
  const stateIds = new Set<string>();
  if (model.states.length === 0 || model.states.length > 100) {
    issues.push(
      issue(
        "INVALID_PAGE_STATE",
        "/states",
        "PageModel requires between 1 and 100 states"
      )
    );
  }
  model.states.forEach((state, index) => {
    if (
      !IDENTIFIER_PATTERN.test(state.id) ||
      !isSafePathPattern(state.pathPattern) ||
      !isDigest(state.fingerprint)
    ) {
      issues.push(
        issue(
          "INVALID_PAGE_STATE",
          `/states/${index}`,
          "Page state requires an ID, safe path pattern, and fingerprint"
        )
      );
    }
    if (stateIds.has(state.id)) {
      issues.push(
        issue(
          "DUPLICATE_ID",
          `/states/${index}/id`,
          `Duplicate page state ${state.id}`
        )
      );
    }
    stateIds.add(state.id);
  });
  const elementIds = new Set<string>();
  if (model.elements.length === 0 || model.elements.length > 1000) {
    issues.push(
      issue(
        "INVALID_IDENTITY",
        "/elements",
        "PageModel requires between 1 and 1000 element references"
      )
    );
  }
  model.elements.forEach((element, index) => {
    if (
      !IDENTIFIER_PATTERN.test(element.id) ||
      !IDENTIFIER_PATTERN.test(element.contract.id) ||
      !SEMVER_PATTERN.test(element.contract.version) ||
      !isDigest(element.contract.digest)
    ) {
      issues.push(
        issue(
          "INVALID_IDENTITY",
          `/elements/${index}`,
          "PageModel elements must pin exact ElementContract assets"
        )
      );
    }
    if (elementIds.has(element.id)) {
      issues.push(
        issue(
          "DUPLICATE_ID",
          `/elements/${index}/id`,
          `Duplicate element ${element.id}`
        )
      );
    }
    elementIds.add(element.id);
  });
  if (
    model.fixtureDigests.length < 2 ||
    model.fixtureDigests.length > 100 ||
    new Set(model.fixtureDigests).size !== model.fixtureDigests.length ||
    model.fixtureDigests.some((digest) => !isDigest(digest))
  ) {
    issues.push(
      issue(
        "INSUFFICIENT_EVIDENCE",
        "/fixtureDigests",
        "PageModel requires at least two unique redacted fixture digests"
      )
    );
  }
  return issues;
}

export function validateSnapshotMetadata(
  snapshot: PageSnapshotMetadata
): ModelValidationIssue[] {
  const issues: ModelValidationIssue[] = [];
  const capturedAt = parseTimestamp(snapshot.capturedAt);
  const expiresAt = parseTimestamp(snapshot.rawEvidenceExpiresAt);
  if (
    !IDENTIFIER_PATTERN.test(snapshot.snapshotId) ||
    !isExactOrigin(snapshot.origin) ||
    !snapshot.path.startsWith("/") ||
    !IDENTIFIER_PATTERN.test(snapshot.pageState) ||
    !isDigest(snapshot.contentDigest) ||
    !isNonEmpty(snapshot.redaction.policyVersion)
  ) {
    issues.push(
      issue(
        "INVALID_SNAPSHOT",
        "/snapshot",
        "Snapshot metadata must identify redacted content and its exact page context"
      )
    );
  }
  if (
    snapshot.redaction.applied !== true ||
    Object.values(snapshot.redaction.coverage).some((covered) => covered !== true)
  ) {
    issues.push(
      issue(
        "INVALID_SNAPSHOT",
        "/snapshot/redaction",
        "All required sensitive-data classes must be removed before capture"
      )
    );
  }
  if (
    capturedAt === undefined ||
    expiresAt === undefined ||
    expiresAt <= capturedAt ||
    expiresAt - capturedAt > 24 * 60 * 60 * 1_000
  ) {
    issues.push(
      issue(
        "INVALID_SNAPSHOT",
        "/snapshot/rawEvidenceExpiresAt",
        "Raw evidence retention must expire within 24 hours of capture"
      )
    );
  }
  return issues;
}

export function validateElementContractEvidence(
  contract: ElementContract,
  observations: readonly ElementContractObservation[],
  context?: {
    allowedOrigins?: readonly string[];
    knownPageStates?: readonly string[];
    knownElementIds?: readonly string[];
  }
): ElementContractValidation {
  const issues = validateElementContractDefinition(contract, context);
  const snapshotDigests = new Set<string>();
  for (const [index, observation] of observations.entries()) {
    issues.push(
      ...validateSnapshotMetadata(observation.snapshot).map((entry) => ({
        ...entry,
        path: `/observations/${index}${entry.path}`
      }))
    );
    const { snapshot } = observation;
    snapshotDigests.add(snapshot.contentDigest);
    if (
      !contract.scope.origins.includes(snapshot.origin) ||
      !pathMatches(contract.scope.pathPattern, snapshot.path) ||
      snapshot.pageState !== contract.scope.pageState ||
      !contract.validatedSnapshots.includes(snapshot.contentDigest)
    ) {
      issues.push(
        issue(
          "INVALID_SNAPSHOT",
          `/observations/${index}/snapshot`,
          "Snapshot is outside the contract scope or validated digest closure"
        )
      );
    }
    if (
      observation.matchCounts.length !== contract.candidates.length ||
      observation.matchCounts.some(
        (count) => !Number.isSafeInteger(count) || count < 0
      )
    ) {
      issues.push(
        issue(
          "COUNT_MISMATCH",
          `/observations/${index}/matchCounts`,
          "Observation must provide one non-negative count per candidate"
        )
      );
    }
  }
  if (
    snapshotDigests.size < 2 ||
    observations.length < 2 ||
    contract.validatedSnapshots.some(
      (digest) => !snapshotDigests.has(digest)
    )
  ) {
    issues.push(
      issue(
        "INSUFFICIENT_EVIDENCE",
        "/observations",
        "Evidence must cover every validated snapshot digest with at least two distinct snapshots"
      )
    );
  }
  const stableCandidateIndexes = contract.candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(
      ({ candidate, index }) =>
        candidate.strategy !== "css-diagnostic" &&
        observations.every((observation) => {
          const count = observation.matchCounts[index];
          return (
            count !== undefined &&
            count >= contract.expectedCount.minimum &&
            count <= contract.expectedCount.maximum
          );
        })
    )
    .map(({ index }) => index);
  if (observations.length > 0 && stableCandidateIndexes.length === 0) {
    issues.push(
      issue(
        "COUNT_MISMATCH",
        "/observations",
        "No semantic locator stayed inside expectedCount across every snapshot"
      )
    );
  }
  return {
    valid: issues.length === 0,
    issues,
    stableCandidateIndexes,
    observedSnapshotDigests: [...snapshotDigests].sort()
  };
}

export function validatePageAssetCandidate(
  candidate: PageAssetCandidate
): ModelValidationIssue[] {
  const issues = validatePageModel(candidate.pageModel);
  if (
    candidate.status !== "candidate" ||
    !IDENTIFIER_PATTERN.test(candidate.candidateId) ||
    parseTimestamp(candidate.createdAt) === undefined
  ) {
    issues.push(
      issue(
        "INVALID_CANDIDATE",
        "/",
        "Page assets may enter review only as a timestamped Candidate"
      )
    );
  }
  const elementIds = candidate.pageModel.elements.map((element) => element.id);
  const stateIds = candidate.pageModel.states.map((state) => state.id);
  for (const [index, pinned] of candidate.contracts.entries()) {
    if (!isDigest(pinned.digest)) {
      issues.push(
        issue(
          "INVALID_CANDIDATE",
          `/contracts/${index}/digest`,
          "Candidate ElementContract closure requires a content digest"
        )
      );
    }
    issues.push(
      ...validateElementContractDefinition(pinned.definition, {
        allowedOrigins: candidate.pageModel.origins,
        knownPageStates: stateIds,
        knownElementIds: elementIds
      }).map((entry) => ({
        ...entry,
        path: `/contracts/${index}${entry.path}`
      }))
    );
  }
  for (const [index, element] of candidate.pageModel.elements.entries()) {
    const contract = candidate.contracts.find(
      (entry) =>
        entry.definition.metadata.id === element.contract.id &&
        entry.definition.metadata.version === element.contract.version &&
        entry.digest === element.contract.digest
    );
    if (!contract) {
      issues.push(
        issue(
          "INVALID_CANDIDATE",
          `/pageModel/elements/${index}/contract`,
          "Candidate closure is missing the pinned ElementContract"
        )
      );
    }
    const implementations = candidate.implementations.filter(
      (implementation) => implementation.elementId === element.id
    );
    if (implementations.length !== 1) {
      issues.push(
        issue(
          "INVALID_CANDIDATE",
          `/implementations`,
          `Element ${element.id} requires exactly one implementation boundary`
        )
      );
    }
  }
  for (const [index, implementation] of candidate.implementations.entries()) {
    if (!elementIds.includes(implementation.elementId)) {
      issues.push(
        issue(
          "INVALID_CANDIDATE",
          `/implementations/${index}/elementId`,
          "Implementation references an unknown semantic element"
        )
      );
    }
    if (implementation.kind === "declarative-read") {
      if (
        implementation.projection.kind === "attribute" &&
        !SAFE_ATTRIBUTE_PATTERN.test(implementation.projection.name)
      ) {
        issues.push(
          issue(
            "INVALID_CANDIDATE",
            `/implementations/${index}/projection`,
            "Declarative reads may expose only reviewed semantic attributes"
          )
        );
      }
    } else if (
      !IDENTIFIER_PATTERN.test(implementation.handler.id) ||
      !SEMVER_PATTERN.test(implementation.handler.version) ||
      !isDigest(implementation.handler.digest)
    ) {
      issues.push(
        issue(
          "INVALID_CANDIDATE",
          `/implementations/${index}/handler`,
          "Complex behavior must pin a reviewed Adapter Handler closure"
        )
      );
    }
  }
  return issues;
}

/**
 * Deterministic replay/runtime primitive for generated simple reads. It never
 * evaluates CSS, XPath or page code. Relative anchors remain reviewed Adapter
 * work because they require a multi-contract resolution graph.
 */
export function evaluateDeclarativeRead(input: {
  contract: ElementContract;
  snapshot: Pick<
    PageSnapshotDefinition,
    "origin" | "path" | "pageState" | "semanticNodes"
  >;
  projection: Extract<
    PageCapabilityImplementation,
    { kind: "declarative-read" }
  >["projection"];
}): DeclarativeReadResult {
  if (
    !input.contract.scope.origins.includes(input.snapshot.origin) ||
    !pathMatches(input.contract.scope.pathPattern, input.snapshot.path) ||
    input.contract.scope.pageState !== input.snapshot.pageState
  ) {
    return {
      status: "failed",
      code: "DECLARATIVE_LOCATOR_UNSTABLE",
      message: "Snapshot is outside the exact ElementContract scope."
    };
  }
  let complexOnly = true;
  for (const [candidateIndex, candidate] of input.contract.candidates.entries()) {
    if (
      candidate.strategy === "css-diagnostic" ||
      candidate.strategy === "relative-anchor"
    ) {
      continue;
    }
    complexOnly = false;
    const nodes = input.snapshot.semanticNodes.filter((node) => {
      switch (candidate.strategy) {
        case "business-id":
          return Object.entries(node.stableAttributes ?? {}).some(
            ([name, value]) =>
              ["data-id", "data-key", "data-row-key"].includes(name) &&
              value === candidate.value
          );
        case "role-name":
          return (
            node.role === candidate.role &&
            node.accessibleName === candidate.name
          );
        case "label":
          return node.label === candidate.label;
        case "attribute":
          return (
            node.stableAttributes?.[candidate.name] === candidate.value
          );
      }
    });
    if (
      nodes.length < input.contract.expectedCount.minimum ||
      nodes.length > input.contract.expectedCount.maximum
    ) {
      continue;
    }
    const values = nodes.map((node): string | boolean | null => {
      if (input.projection.kind === "presence") return true;
      if (input.projection.kind === "attribute") {
        return node.stableAttributes?.[input.projection.name] ?? null;
      }
      return (
        node.text ??
        node.accessibleName ??
        node.label ??
        null
      );
    });
    if (
      input.projection.kind !== "presence" &&
      values.some((value) => value === null)
    ) {
      return {
        status: "failed",
        code: "DECLARATIVE_PROJECTION_EMPTY",
        message:
          "The stable semantic locator matched, but the requested projection is absent."
      };
    }
    return {
      status: "succeeded",
      candidateIndex,
      strategy: candidate.strategy,
      nodeIds: nodes.map((node) => node.id),
      value:
        input.projection.kind === "presence" && nodes.length === 0
          ? false
          : values.length === 1
            ? values[0]!
            : values
    };
  }
  return complexOnly
    ? {
        status: "failed",
        code: "DECLARATIVE_COMPLEX_LOCATOR_REQUIRED",
        message:
          "The contract requires a reviewed relative-anchor Adapter Handler."
      }
    : {
        status: "failed",
        code: "DECLARATIVE_LOCATOR_UNSTABLE",
        message:
          "No stable semantic locator stayed inside the expected count."
      };
}

export function publishPageAssetCandidate(input: {
  asset: PageAssetCandidate;
  approval: {
    actorType: "human";
    actorId: string;
    approvedAt: string;
  };
  publicationDigest: string;
}): PageAssetPublication {
  const issues = validatePageAssetCandidate(input.asset);
  if (
    issues.length > 0 ||
    input.asset.status !== "candidate" ||
    input.approval.actorType !== "human" ||
    !isNonEmpty(input.approval.actorId) ||
    parseTimestamp(input.approval.approvedAt) === undefined ||
    !isDigest(input.publicationDigest)
  ) {
    throw new Error(
      `Page asset publication rejected${issues.length > 0 ? `: ${issues[0]!.message}` : ""}`
    );
  }
  return {
    candidateId: input.asset.candidateId,
    status: "published",
    pageModel: structuredClone(input.asset.pageModel),
    contracts: structuredClone(input.asset.contracts),
    implementations: structuredClone(input.asset.implementations),
    publicationDigest: input.publicationDigest,
    approvedBy: input.approval.actorId,
    approvedAt: new Date(input.approval.approvedAt).toISOString()
  };
}

export const DEFAULT_DESIGN_MODE_TTL_MS = 15 * 60 * 1_000;
export const MAX_DESIGN_MODE_TTL_MS = 15 * 60 * 1_000;

export interface DesignModeSession {
  sessionId: string;
  extensionId: string;
  profileId: string;
  tabId: number;
  origin: string;
  permission: "page-model.design.read";
  state: "active" | "expired" | "stopped";
  grantedAt: string;
  expiresAt: string;
  stoppedAt?: string;
}

export function createDesignModeSession(input: {
  sessionId: string;
  extensionId: string;
  profileId: string;
  tabId: number;
  origin: string;
  now: string;
  ttlMs?: number;
}): DesignModeSession {
  const grantedAt = parseTimestamp(input.now);
  const ttlMs = input.ttlMs ?? DEFAULT_DESIGN_MODE_TTL_MS;
  if (
    grantedAt === undefined ||
    !IDENTIFIER_PATTERN.test(input.sessionId) ||
    !isNonEmpty(input.extensionId) ||
    !isNonEmpty(input.profileId) ||
    !Number.isSafeInteger(input.tabId) ||
    input.tabId < 0 ||
    !isExactOrigin(input.origin) ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > MAX_DESIGN_MODE_TTL_MS
  ) {
    throw new Error(
      "Design Mode requires an exact binding and a positive TTL no longer than 15 minutes"
    );
  }
  return {
    sessionId: input.sessionId,
    extensionId: input.extensionId,
    profileId: input.profileId,
    tabId: input.tabId,
    origin: input.origin,
    permission: "page-model.design.read",
    state: "active",
    grantedAt: new Date(grantedAt).toISOString(),
    expiresAt: new Date(grantedAt + ttlMs).toISOString()
  };
}

export function evaluateDesignModeSession(
  session: DesignModeSession,
  now: string
): DesignModeSession {
  if (session.state !== "active") return structuredClone(session);
  const currentTime = parseTimestamp(now);
  const expiresAt = parseTimestamp(session.expiresAt);
  if (currentTime === undefined || expiresAt === undefined) {
    throw new Error("Design Mode timestamps must be valid ISO timestamps");
  }
  return currentTime >= expiresAt
    ? { ...session, state: "expired" }
    : structuredClone(session);
}

export function stopDesignModeSession(
  session: DesignModeSession,
  now: string
): DesignModeSession {
  const evaluated = evaluateDesignModeSession(session, now);
  if (evaluated.state !== "active") return evaluated;
  const stoppedAt = parseTimestamp(now);
  if (stoppedAt === undefined) {
    throw new Error("Design Mode stop timestamp must be valid");
  }
  return {
    ...evaluated,
    state: "stopped",
    stoppedAt: new Date(stoppedAt).toISOString()
  };
}

export function designModeSessionIssues(
  session: DesignModeSession,
  now: string
): ModelValidationIssue[] {
  const issues: ModelValidationIssue[] = [];
  const grantedAt = parseTimestamp(session.grantedAt);
  const expiresAt = parseTimestamp(session.expiresAt);
  const currentTime = parseTimestamp(now);
  if (
    !isExactOrigin(session.origin) ||
    session.permission !== "page-model.design.read" ||
    grantedAt === undefined ||
    expiresAt === undefined ||
    currentTime === undefined ||
    expiresAt <= grantedAt ||
    expiresAt - grantedAt > MAX_DESIGN_MODE_TTL_MS
  ) {
    issues.push(
      issue(
        "INVALID_DESIGN_SESSION",
        "/designMode",
        "Design Mode session binding, permission, or TTL is invalid"
      )
    );
  }
  if (
    session.state === "active" &&
    currentTime !== undefined &&
    expiresAt !== undefined &&
    currentTime >= expiresAt
  ) {
    issues.push(
      issue(
        "INVALID_DESIGN_SESSION",
        "/designMode/state",
        "Active Design Mode session has already expired"
      )
    );
  }
  return issues;
}
