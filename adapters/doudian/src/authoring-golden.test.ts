import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { contentDigest } from "@bpa/compiler";
import {
  evaluateDeclarativeRead,
  validateElementContractEvidence,
  validatePageAssetCandidate,
  type ElementContract,
  type PageAssetCandidate,
  type PageSnapshotMetadata
} from "@bpa/page-model";

const origin = "https://fxg.jinritemai.com";
const adapterDigest = `sha256:${"a".repeat(64)}`;
const snapshotDigest105 = `sha256:${"b".repeat(64)}`;
const snapshotDigest106 = `sha256:${"c".repeat(64)}`;

function snapshot(
  snapshotId: string,
  contentDigest: string
): PageSnapshotMetadata {
  return {
    snapshotId,
    source: "fixture",
    capturedAt: "2026-07-30T10:00:00.000Z",
    origin,
    path: "/ffa/g/list",
    pageState: "product-list-ready",
    contentDigest,
    redaction: {
      applied: true,
      policyVersion: "1.0.0",
      coverage: {
        passwords: true,
        tokens: true,
        cookies: true,
        hiddenInputs: true,
        personalData: true,
        largeText: true
      }
    },
    rawEvidenceExpiresAt: "2026-07-31T09:59:59.000Z"
  };
}

describe("Doudian authoring standard-answer regression", () => {
  it("reconstructs the proven total-count read with no wider authority", () => {
    const contract: ElementContract = {
      apiVersion: "bpa.page/v1alpha1",
      kind: "ElementContract",
      metadata: {
        id: "doudian.product-list.total-count",
        version: "0.1.0",
        title: "商品列表完整范围总数"
      },
      intent: "读取当前店铺和筛选范围下的商品总数",
      scope: {
        origins: [origin],
        pathPattern: "/ffa/g/list",
        pageState: "product-list-ready",
        frame: "top"
      },
      expectedCount: { minimum: 1, maximum: 2 },
      candidates: [
        {
          strategy: "role-name",
          role: "status",
          name: "商品总数"
        },
        {
          strategy: "css-diagnostic",
          selector: "[data-testid='product-total']"
        }
      ],
      preconditions: [
        "page-identity-confirmed",
        "shop-identity-confirmed"
      ],
      postconditions: [],
      volatility: "medium",
      validatedSnapshots: [
        snapshotDigest105,
        snapshotDigest106
      ]
    };
    const contractDigest = contentDigest(contract);
    const candidate: PageAssetCandidate = {
      candidateId: "doudian.product-list.total-count.candidate",
      status: "candidate",
      pageModel: {
        apiVersion: "bpa.page/v1alpha1",
        kind: "PageModel",
        metadata: {
          id: "doudian.product-list.authoring-golden",
          version: "0.1.0",
          title: "抖店商品列表创作标准答案"
        },
        adapter: {
          id: "doudian",
          version: "1.2.0",
          digest: adapterDigest
        },
        origins: [origin],
        states: [
          {
            id: "product-list-ready",
            pathPattern: "/ffa/g/list",
            fingerprint: `sha256:${"d".repeat(64)}`
          }
        ],
        elements: [
          {
            id: "doudian.product-list.total-count",
            contract: {
              id: contract.metadata.id,
              version: contract.metadata.version,
              digest: contractDigest
            }
          }
        ],
        fixtureDigests: [snapshotDigest105, snapshotDigest106]
      },
      contracts: [{ definition: contract, digest: contractDigest }],
      implementations: [
        {
          kind: "declarative-read",
          elementId: "doudian.product-list.total-count",
          projection: { kind: "text" }
        }
      ],
      createdAt: "2026-07-30T10:10:00.000Z"
    };
    expect(validatePageAssetCandidate(candidate)).toEqual([]);
    expect(
      validateElementContractEvidence(
        contract,
        [
          {
            snapshot: snapshot(
              "doudian-product-list-105",
              snapshotDigest105
            ),
            matchCounts: [1, 1]
          },
          {
            snapshot: snapshot(
              "doudian-product-list-106",
              snapshotDigest106
            ),
            matchCounts: [1, 1]
          }
        ],
        {
          allowedOrigins: candidate.pageModel.origins,
          knownPageStates: ["product-list-ready"],
          knownElementIds: [
            "doudian.product-list.total-count"
          ]
        }
      )
    ).toMatchObject({
      valid: true,
      stableCandidateIndexes: [0]
    });

    const replay = JSON.parse(
      readFileSync(
        new URL(
          "../fixtures/scope-105-to-106.replay.json",
          import.meta.url
        ),
        "utf8"
      )
    ) as { rounds: Array<{ topTotal: number }> };
    const observed = [105, 106].map((total) =>
      evaluateDeclarativeRead({
        contract,
        snapshot: {
          origin,
          path: "/ffa/g/list",
          pageState: "product-list-ready",
          semanticNodes: [
            {
              id: `semantic-total-${total}`,
              order: 0,
              role: "status",
              accessibleName: "商品总数",
              text: `共 ${total} 件商品`,
              states: {
                visible: true,
                interactive: false
              },
              digest: `sha256:${String(total).padStart(64, "0")}`
            }
          ]
        },
        projection: { kind: "text" }
      })
    );
    expect(
      observed.map((result) =>
        result.status === "succeeded"
          ? Number(/\d+/u.exec(String(result.value))?.[0])
          : undefined
      )
    ).toEqual(replay.rounds.map((round) => round.topTotal));

    const manifest = parse(
      readFileSync(
        new URL("../doudian.adapter.yaml", import.meta.url),
        "utf8"
      )
    ) as {
      origins: string[];
      capabilities: Array<{
        nodeId: string;
        permissions: string[];
      }>;
    };
    expect(candidate.pageModel.origins).toEqual(manifest.origins);
    expect(
      manifest.capabilities.find(
        (entry) =>
          entry.nodeId === "doudian.product.scope.collect"
      )?.permissions
    ).toEqual(["browser.dom.read", "browser.tabs.read"]);
    expect(candidate.implementations).toEqual([
      expect.objectContaining({ kind: "declarative-read" })
    ]);
  });
});
