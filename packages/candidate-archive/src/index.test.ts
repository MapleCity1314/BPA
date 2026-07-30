import {
  createCandidateArchive,
  createCandidatePatch,
  verifyCandidateArchive
} from "./index.js";
import { describe, expect, it } from "vitest";

describe("Candidate archive", () => {
  it("creates a deterministic, checksummed regular-file archive", () => {
    const source = {
      path: "nodes/example.node.yaml",
      bytes: Buffer.from("kind: Node\n", "utf8")
    };
    const common = [
      {
        path: "candidate-manifest.json",
        bytes: Buffer.from('{"bundleId":"bundle.example"}\n')
      },
      {
        path: "candidate.patch",
        bytes: Buffer.from(createCandidatePatch([source]))
      },
      {
        path: "validation-report.json",
        bytes: Buffer.from('{"valid":true}\n')
      },
      {
        path: "risk-report.json",
        bytes: Buffer.from('{"effective":"R0"}\n')
      },
      { path: `files/${source.path}`, bytes: source.bytes }
    ];
    const first = createCandidateArchive(common);
    const second = createCandidateArchive([...common].reverse());
    expect(first).toEqual(second);
    const verification = verifyCandidateArchive(first);
    expect(verification.valid).toBe(true);
    expect(verification.manifest).toEqual({
      bundleId: "bundle.example"
    });
  });

  it("rejects traversal and detects tampering", () => {
    expect(() =>
      createCandidateArchive([
        {
          path: "files/nodes/../secret",
          bytes: Buffer.from("secret")
        }
      ])
    ).toThrow(/Unsafe/);
    const archive = createCandidateArchive([
      {
        path: "candidate-manifest.json",
        bytes: Buffer.from("{}\n")
      },
      {
        path: "candidate.patch",
        bytes: Buffer.from("\n")
      },
      {
        path: "validation-report.json",
        bytes: Buffer.from("{}\n")
      },
      {
        path: "risk-report.json",
        bytes: Buffer.from("{}\n")
      }
    ]);
    const tampered = Buffer.from(archive);
    tampered[512] = tampered[512]! ^ 1;
    expect(verifyCandidateArchive(tampered).valid).toBe(false);
  });
});
