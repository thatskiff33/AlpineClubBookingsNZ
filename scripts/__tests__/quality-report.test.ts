import path from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../quality-report";
import { scanRepository, summariseSizeDebt } from "../lib/file-size-budget";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function captureReport(): string {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  try {
    main();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("quality report", () => {
  it("reports the same over-budget population the blocking gate enforces", () => {
    const report = captureReport();
    const scan = scanRepository(REPO_ROOT);
    const expected = summariseSizeDebt(scan.productionStats);

    // The report and `npm run quality:budget` share one classifier and one debt
    // summary on purpose (#2687): an advisory report that disagreed with the
    // gate is how the old nine-entry allow-list came to understate the real
    // population by a factor of thirty.
    expect(report).toMatch(
      new RegExp(`\\| Files over budget \\(all categories\\)\\s*\\| ${expected.oversizedFiles}\\s*\\|`),
    );
    expect(report).toMatch(
      new RegExp(`\\| Accepted size debt \\(LOC over budget\\)\\s*\\| ${expected.debt}\\s*\\|`),
    );
    expect(report).toContain("## File-size budget ratchet");
    expect(report).toContain(
      `${expected.oversizedFiles} of ${expected.scannedFiles} production files are over budget`,
    );
  });

  it("measures the debt from the tree rather than reading a stored ledger", () => {
    // #2979 acceptance criterion 1 for this consumer specifically: the report
    // was the second reader of `scripts/quality/file-size-baseline.txt`, which
    // the issue body did not anticipate. A source-text assertion is the right
    // shape here because the failure being guarded against is somebody
    // reintroducing the read, not a wrong number.
    const source = readFileSync(
      path.join(REPO_ROOT, "scripts", "quality-report.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/file-size-baseline|BASELINE_PATH/);
    expect(captureReport()).not.toMatch(/file-size-baseline\.txt/);
  });

  it("shows scope holes, because a file no budget covers reads like a clean pass", () => {
    const report = captureReport();
    const scan = scanRepository(REPO_ROOT);
    expect(report).toMatch(
      new RegExp(`\\| Unclassified src/ files \\(scope holes\\)\\s*\\| ${scan.unclassified.length}\\s*\\|`),
    );
    expect(report).toContain("### Scope holes");
  });

  it("no longer offers an accepted-hotspot allow-list as the thing that decides", () => {
    const source = readFileSync(path.join(REPO_ROOT, "scripts", "quality-report.ts"), "utf8");
    expect(source).not.toMatch(/KNOWN_OVERSIZED_PRODUCTION_FILES|allow-?list/i);
  });
});
