import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4410: a wizard step's save in flight must reach the shell, which holds
 * Continue and the stepper until it settles. A step that keeps its own
 * `useState` flag instead of `useStepSaving(helpers)` saves without telling the
 * shell, and a credential Replace that already verifies lets the operator move
 * on mid-write. Every file that renders a wizard step (it takes
 * `WizardStepHelpers`) therefore declares its saving/busy flag through
 * `useStepSaving`, never `useState`.
 *
 * WHAT THIS CANNOT SEE: a save flag under some other name, or a save with no
 * flag at all. Deliberately NOT locked, because the operator is meant to be
 * able to move on while they run (#4410 review): the verify and poll flags
 * (`verifying`, `checking`, `starting` - the Xero webhook verify even tells the
 * operator to skip while it polls) and the display wizard's restore-boards
 * `running`, a restore whose completion does not depend on staying on the step.
 */
const REPO = path.resolve(__dirname, "..", "..", "..", "..", "..");

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") sourceFiles(full, found);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(path.relative(REPO, full).split(path.sep).join("/"));
    }
  }
  return found;
}

const stepFiles = sourceFiles(path.join(REPO, "src/app")).filter((file) =>
  /\bWizardStepHelpers\b/.test(readFileSync(path.join(REPO, file), "utf8")),
);
const LOCAL_SAVE_FLAG = /const \[(?:saving|busy|submitting|pending), set\w+\] = useState\b/g;

describe("every wizard step reports its save to the shell (#4410)", () => {
  it("found the wizard step files, so an empty census is not a pass", () => {
    expect(stepFiles.length).toBeGreaterThanOrEqual(6);
  });

  it("declares no local saving/busy flag; useStepSaving(helpers) instead", () => {
    const offenders = stepFiles.flatMap((file) =>
      [...readFileSync(path.join(REPO, file), "utf8").matchAll(LOCAL_SAVE_FLAG)].map((match) => `${file}: ${match[0]}`),
    );
    expect(offenders, "#4410: a step's save flag must go through useStepSaving(helpers)").toEqual([]);
  });

  it("the steps that save do use the hook", () => {
    const users = stepFiles.filter((file) => /\buseStepSaving\(helpers\)/.test(readFileSync(path.join(REPO, file), "utf8")));
    expect(users.sort()).toEqual([
      "src/app/(admin)/admin/backups/setup/backup-wizard-steps.tsx",
      "src/app/(admin)/admin/display/setup/display-wizard-steps.tsx",
      "src/app/(admin)/admin/finance/xero/setup/xero-completion-steps.tsx",
      "src/app/(admin)/admin/finance/xero/setup/xero-wizard-steps.tsx",
      "src/app/(admin)/admin/google/setup/google-wizard-steps.tsx",
      "src/app/(admin)/admin/stripe/setup/stripe-wizard-steps.tsx",
    ]);
  });
});
