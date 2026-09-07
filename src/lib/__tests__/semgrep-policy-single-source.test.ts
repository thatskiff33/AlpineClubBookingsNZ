import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `ci.yml` is the Semgrep policy; every other statement of it must agree (#2842).
 *
 * ENFORCES `INV-SSOT-001`. The blocking invocation lives in one place — the
 * `static-analysis` job — and `docs/MAINTENANCE.md` then restates the pack set
 * four more times: in the prose describing the gate, in the Semgrep Cloud
 * checklist, and in two runnable bash blocks. Nothing compared them.
 *
 * WHY THAT PARTICULAR DUPLICATION IS DANGEROUS, rather than merely untidy.
 * The Cloud checklist tells the owner to turn ON exactly the packs the
 * blocking gate runs and to turn OFF everything else. If somebody adds a fifth
 * pack to `ci.yml` and updates the prose but not the checklist, the owner
 * walks the checklist and configures Cloud to a set that no longer matches the
 * gate — and step 1 makes them turn the new pack off. That is precisely the
 * split-brain #2842 exists to close, re-created by the document that
 * implements the closing.
 *
 * WHY A TEST RATHER THAN A SHARED SCRIPT. Extracting the invocation into
 * `scripts/ci/semgrep-scan.sh` is the better shape and is recorded as the
 * preferred option in the issue. It is not done here because the invocation
 * sits inside a job producing a REQUIRED check, whose edits are owner-gated
 * and are being kept minimal for this change, and because
 * `deployment-image-contracts.test.ts` pins fifteen specifics of that job's
 * body and would have to be rewritten with it. This buys the property that
 * matters — a drifting copy cannot land — without touching the gate.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");

const WORKFLOW = readFileSync(
  path.join(REPO_ROOT, ".github/workflows/ci.yml"),
  "utf8",
);
const MAINTENANCE = readFileSync(
  path.join(REPO_ROOT, "docs/MAINTENANCE.md"),
  "utf8",
);

/** The `static-analysis` job's scan step, which is the definition. */
function blockingScanStep(): string {
  const start = WORKFLOW.indexOf("      - name: Run Semgrep static analysis");
  const end = WORKFLOW.indexOf("      - name:", start + 1);
  expect(start, "the `Run Semgrep static analysis` step must exist").toBeGreaterThan(-1);
  return WORKFLOW.slice(start, end);
}

function registryPacksIn(text: string): string[] {
  return [...text.matchAll(/--config (p\/[a-z]+)/g)].map((m) => m[1]).sort();
}

function excludesIn(text: string): string[] {
  return [...text.matchAll(/--exclude ([^\s\\]+)/g)].map((m) => m[1]).sort();
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** The two runnable blocks in MAINTENANCE.md that re-spell the whole command. */
function maintenanceScanBlocks(): string[] {
  return [...MAINTENANCE.matchAll(/```bash\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((block) => block.includes("semgrep scan"));
}

describe("the Semgrep policy is stated once and every copy agrees (#2842)", () => {
  const step = blockingScanStep();
  const packs = registryPacksIn(step);
  const excludes = excludesIn(step);

  it("reads a pack set and an exclude set out of the workflow at all", () => {
    // Guards the guard: if the step is reshaped so these regexes match nothing,
    // every assertion below would compare [] to [] and pass vacuously.
    expect(packs.length).toBeGreaterThan(0);
    expect(excludes.length).toBeGreaterThan(0);
  });

  it("pins the image in one place, and MAINTENANCE.md quotes that image", () => {
    const image = WORKFLOW.match(/SEMGREP_IMAGE: (semgrep\/semgrep:[\d.]+)/)?.[1];
    expect(image, "ci.yml must pin the image in `SEMGREP_IMAGE`").toBeTruthy();

    for (const block of maintenanceScanBlocks()) {
      expect(
        block,
        `A runnable block in MAINTENANCE.md uses a different Semgrep image from ci.yml (${image}). Reproducing the gate means running what the gate runs.`,
      ).toContain(image);
    }
  });

  it("runs the repository's own rules alongside the registry packs", () => {
    expect(step).toContain("--config .semgrep/rules");
    for (const block of maintenanceScanBlocks()) {
      expect(block).toContain("--config .semgrep/rules");
    }
  });

  it("states the same pack set in both runnable MAINTENANCE.md blocks", () => {
    const blocks = maintenanceScanBlocks();
    expect(
      blocks.length,
      "MAINTENANCE.md should carry the `--disable-nosem` block and the coverage-gate block",
    ).toBe(2);

    for (const block of blocks) {
      expect(
        registryPacksIn(block),
        `A runnable block in MAINTENANCE.md runs a different pack set from the blocking gate (${packs.join(", ")}). One of them is wrong, and the one in ci.yml is the policy.`,
      ).toEqual(packs);
      expect(
        excludesIn(block),
        `A runnable block in MAINTENANCE.md uses a different --exclude set from the blocking gate (${excludes.join(", ")}). A block that scans a different file set cannot reproduce the gate.`,
      ).toEqual(excludes);
    }
  });

  it("names exactly the gate's packs in the Semgrep Cloud checklist", () => {
    // The checklist tells the owner to enable exactly these and disable the
    // rest, so a pack added to ci.yml and missed here makes the owner
    // configure Cloud to a set that no longer matches the gate.
    // Only the "turn ON" step. Step 1 names `p/default` and `p/security-audit`
    // as the packs to turn OFF, and those must NOT be read as the gate's set.
    const turnOn = MAINTENANCE.slice(
      MAINTENANCE.indexOf("**Turn ON exactly the four packs"),
    );
    const checklist = turnOn.slice(0, turnOn.indexOf("\n3."));
    expect(
      checklist.length,
      "the Cloud checklist's `Turn ON exactly...` step must exist",
    ).toBeGreaterThan(0);

    expect(
      uniqueSorted([...checklist.matchAll(/`(p\/[a-z]+)`/g)].map((m) => m[1])),
      `The Semgrep Cloud checklist names a different pack set from the blocking gate (${packs.join(", ")}). That is the split-brain this issue closed: the owner would turn the gate's pack OFF.`,
    ).toEqual(packs);
  });

  it("keeps the prose description of the gate in step with it too", () => {
    const prose = MAINTENANCE.slice(
      MAINTENANCE.indexOf("- **`Static analysis gate`**"),
      MAINTENANCE.indexOf("- **`semgrep-cloud-platform/scan`**"),
    );
    expect(prose.length, "the two-scans section must exist").toBeGreaterThan(0);

    expect(
      uniqueSorted([...prose.matchAll(/`(p\/[a-z]+)`/g)].map((m) => m[1])),
      "The prose describing the blocking gate lists a different pack set from the gate itself.",
    ).toEqual(packs);
  });
});
