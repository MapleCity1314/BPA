import type { PageSnapshotDefinition } from "@bpa/schemas";

export const MAX_SEMANTIC_NODES = 5_000;
export const MAX_SEMANTIC_TEXT_LENGTH = 160;
export const MAX_SEMANTIC_SNAPSHOT_BYTES = 5 * 1024 * 1024;

type SemanticNode = PageSnapshotDefinition["semanticNodes"][number];

export interface SemanticSnapshotCapture {
  readonly pageState: string;
  readonly capturedAt: string;
  readonly origin: string;
  readonly path: string;
  readonly untrusted: true;
  readonly redaction: PageSnapshotDefinition["redaction"];
  readonly semanticNodes: SemanticNode[];
  readonly contentDigest: string;
  readonly sizeBytes: number;
}

const SEMANTIC_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "label",
  "[role]",
  "[aria-label]",
  "[aria-labelledby]",
  "[data-testid]",
  "[data-test]",
  "[data-e2e]",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "main",
  "nav",
  "section",
  "article",
  "form",
  "table",
  "th",
  "td",
  "li",
  "p",
  "span",
  "div"
].join(",");

const INTERACTIVE_TAGS = new Set([
  "A",
  "BUTTON",
  "INPUT",
  "SELECT",
  "TEXTAREA"
]);

const ROLE_BY_TAG: Readonly<Record<string, string>> = {
  A: "link",
  BUTTON: "button",
  FORM: "form",
  H1: "heading",
  H2: "heading",
  H3: "heading",
  H4: "heading",
  H5: "heading",
  H6: "heading",
  INPUT: "textbox",
  LI: "listitem",
  MAIN: "main",
  NAV: "navigation",
  SELECT: "combobox",
  TABLE: "table",
  TD: "cell",
  TEXTAREA: "textbox",
  TH: "columnheader"
};

const STABLE_ATTRIBUTE_NAMES = [
  "name",
  "href",
  "type",
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "aria-controls",
  "aria-expanded",
  "aria-selected",
  "aria-checked",
  "data-testid",
  "data-test",
  "data-e2e",
  "data-id",
  "data-key",
  "data-row-key"
] as const;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )
    .join(",")}}`;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(hashed)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function redact(value: string): string {
  return value
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
      "[REDACTED_EMAIL]"
    )
    .replace(
      /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu,
      "[REDACTED_PHONE]"
    )
    .replace(
      /\b(?:bearer\s+)?eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]{12,})?\b/giu,
      "[REDACTED_TOKEN]"
    )
    .replace(
      /\b(?:token|cookie|authorization|secret)\s*[:=]\s*\S+/giu,
      "[REDACTED_SECRET]"
    )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_SEMANTIC_TEXT_LENGTH);
}

function bounded(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const safe = redact(value);
  return safe || undefined;
}

function visible(element: Element, document: Document): boolean {
  if (
    element.hasAttribute("hidden") ||
    element.getAttribute("aria-hidden") === "true" ||
    (element instanceof HTMLInputElement &&
      (element.type === "hidden" ||
        element.type === "password" ||
        element.autocomplete === "current-password" ||
        element.autocomplete === "new-password"))
  ) {
    return false;
  }
  const style = document.defaultView?.getComputedStyle(element);
  return !(
    style?.display === "none" ||
    style?.visibility === "hidden" ||
    style?.visibility === "collapse" ||
    style?.opacity === "0"
  );
}

function interactive(element: Element): boolean {
  return (
    INTERACTIVE_TAGS.has(element.tagName) ||
    element.hasAttribute("role") ||
    element.hasAttribute("tabindex") ||
    element.hasAttribute("contenteditable")
  );
}

function labelText(element: Element, document: Document): string | undefined {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    const labels = [...(element.labels ?? [])]
      .map((label) => label.textContent ?? "")
      .join(" ");
    const fromLabels = bounded(labels);
    if (fromLabels) return fromLabels;
  }
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labels = labelledBy
      .split(/\s+/u)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    const fromAria = bounded(labels);
    if (fromAria) return fromAria;
  }
  return bounded(element.closest("label")?.textContent);
}

function accessibleName(
  element: Element,
  document: Document
): string | undefined {
  return (
    bounded(element.getAttribute("aria-label")) ??
    labelText(element, document) ??
    bounded(element.getAttribute("alt")) ??
    bounded(element.getAttribute("title")) ??
    bounded(element.textContent)
  );
}

function role(element: Element): string | undefined {
  const explicit = bounded(element.getAttribute("role"));
  if (explicit) return explicit;
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox") return "checkbox";
    if (element.type === "radio") return "radio";
    if (element.type === "search") return "searchbox";
  }
  return ROLE_BY_TAG[element.tagName];
}

function region(element: Element, document: Document): string | undefined {
  const owner = element.closest(
    "[role='region'],main,nav,section,article,form"
  );
  if (!owner || owner === element) return role(owner ?? element);
  return accessibleName(owner, document) ?? role(owner);
}

function stableHref(value: string, document: Document): string | undefined {
  try {
    const url = new URL(value, document.location.href);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return undefined;
    }
    return bounded(`${url.origin}${url.pathname}`);
  } catch {
    return undefined;
  }
}

function stableAttributes(
  element: Element,
  document: Document
): Record<string, string> | undefined {
  const attributes: Record<string, string> = {};
  for (const name of STABLE_ATTRIBUTE_NAMES) {
    const raw = element.getAttribute(name);
    const value =
      name === "href" && raw
        ? stableHref(raw, document)
        : bounded(raw);
    if (value) attributes[name] = value;
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

function cssDiagnostic(element: Element): string {
  const testId =
    element.getAttribute("data-testid") ??
    element.getAttribute("data-test") ??
    element.getAttribute("data-e2e");
  if (testId && /^[A-Za-z0-9._:-]{1,120}$/u.test(testId)) {
    return `${element.tagName.toLowerCase()}[data-testid="${testId}"]`;
  }
  const id = element.id;
  if (id && /^[A-Za-z][A-Za-z0-9._:-]{0,119}$/u.test(id)) {
    return `${element.tagName.toLowerCase()}#${id}`;
  }
  return element.tagName.toLowerCase();
}

function state(element: Element, isVisible: boolean) {
  const input = element as HTMLInputElement;
  const disabled =
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true";
  return {
    visible: isVisible,
    interactive: interactive(element),
    enabled: !disabled,
    required:
      element.hasAttribute("required") ||
      element.getAttribute("aria-required") === "true",
    ...(typeof input.checked === "boolean"
      ? { checked: input.checked }
      : {}),
    ...(element.getAttribute("aria-selected") == null
      ? {}
      : {
          selected:
            element.getAttribute("aria-selected") === "true"
        })
  };
}

export async function captureSemanticSnapshot(
  document: Document,
  input: {
    pageState: string;
    capturedAt?: string;
    maxNodes?: number;
  }
): Promise<SemanticSnapshotCapture> {
  const url = new URL(document.location.href);
  const maxNodes = Math.min(
    MAX_SEMANTIC_NODES,
    Math.max(1, input.maxNodes ?? MAX_SEMANTIC_NODES)
  );
  const elements = [...document.querySelectorAll(SEMANTIC_SELECTOR)]
    .filter((element) => visible(element, document))
    .slice(0, maxNodes);
  const idByElement = new Map<Element, string>();
  elements.forEach((element, index) => {
    idByElement.set(
      element,
      `semantic-node-${String(index + 1).padStart(5, "0")}`
    );
  });
  const semanticNodes = await Promise.all(elements.map(async (element, index) => {
    let parent = element.parentElement;
    while (parent && !idByElement.has(parent)) {
      parent = parent.parentElement;
    }
    const semanticRole = role(element);
    const semanticName = accessibleName(element, document);
    const semanticLabel = labelText(element, document);
    const semanticText = bounded(element.textContent);
    const semanticRegion = region(element, document);
    const attributes = stableAttributes(element, document);
    const nodeWithoutDigest = {
      id: idByElement.get(element)!,
      ...(parent ? { parentId: idByElement.get(parent)! } : {}),
      order: index,
      ...(semanticRole ? { role: semanticRole } : {}),
      ...(semanticName ? { accessibleName: semanticName } : {}),
      ...(semanticLabel ? { label: semanticLabel } : {}),
      ...(semanticText ? { text: semanticText } : {}),
      ...(semanticRegion ? { region: semanticRegion } : {}),
      ...(attributes ? { stableAttributes: attributes } : {}),
      states: state(element, true),
      cssDiagnostic: cssDiagnostic(element)
    };
    return {
      ...nodeWithoutDigest,
      digest: await sha256(canonicalJson(nodeWithoutDigest))
    } satisfies SemanticNode;
  }));
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const body = {
    pageState: input.pageState,
    capturedAt,
    origin: url.origin,
    path: url.pathname,
    untrusted: true as const,
    redaction: {
      applied: true as const,
      policyVersion: "1.0.0",
      coverage: {
        passwords: true as const,
        tokens: true as const,
        cookies: true as const,
        hiddenInputs: true as const,
        personalData: true as const,
        largeText: true as const
      }
    },
    semanticNodes
  };
  const serialized = canonicalJson(body);
  const sizeBytes = new TextEncoder().encode(serialized).byteLength;
  if (sizeBytes > MAX_SEMANTIC_SNAPSHOT_BYTES) {
    throw new Error("SEMANTIC_SNAPSHOT_TOO_LARGE");
  }
  return {
    ...body,
    contentDigest: await sha256(serialized),
    sizeBytes
  };
}
