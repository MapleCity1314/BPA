// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusPill } from "./views.js";

afterEach(cleanup);

describe("StatusPill", () => {
  it("renders rejected with the non-success status treatment", () => {
    render(<StatusPill tone="rejected">rejected</StatusPill>);
    expect(screen.getByText("rejected")).toHaveClass(
      "status-pill",
      "status-rejected"
    );

    const styles = readFileSync(
      join(process.cwd(), "apps/operator-console/src/styles.css"),
      "utf8"
    );
    expect(styles).toMatch(
      /\.status-action,\s*\.status-rejected,\s*\.status-failed,\s*\.status-uncertain/
    );
  });
});
