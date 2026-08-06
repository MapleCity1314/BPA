import {
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqlitePersistence } from "@bpa/persistence-sqlite";
import { LocalCandidateArchiveService } from "./candidate-archive-service.js";

describe("Local Candidate file staging", () => {
  it("stores generated text in CAS without applying it to the repository", () => {
    const dataDirectory = mkdtempSync(
      join(tmpdir(), "bpa-candidate-file-")
    );
    const persistence = new SqlitePersistence({ path: ":memory:" });
    const service = new LocalCandidateArchiveService(
      persistence,
      dataDirectory
    );
    const input = {
      authoringSessionId: "authoring-session-test",
      path: "adapters/chanmama/candidates/metrics.page-model.json",
      mediaType: "application/json",
      body: '{"kind":"PageModel"}\n',
      createdAt: "2026-07-30T12:00:00.000Z"
    };
    const first = service.storeCandidateFile(input);
    const second = service.storeCandidateFile(input);
    expect(second).toEqual(first);
    const asset = persistence.getAssetRecord(
      first.sourceAssetRef.id
    );
    expect(asset).toMatchObject({
      digest: first.digest,
      size: first.sizeBytes,
      mediaType: "application/json",
      retention: { policy: "manual" }
    });
    expect(
      new TextDecoder().decode(service.readAsset(asset!.storageRef))
    ).toBe(input.body);
    expect(() =>
      service.storeCandidateFile({
        ...input,
        path: "adapters/chanmama/../secret.ts"
      })
    ).toThrow(/unsafe/);
    persistence.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });
});
