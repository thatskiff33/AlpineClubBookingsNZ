/**
 * THE SUBJECT ACCESS EXPORT COVERS EVERY PERSONAL MODEL, OR SAYS WHY NOT
 * (#4915, `INV-PRIV-023`).
 *
 * The export used to be a hand-picked list of reads, and every personal model
 * added after it widened the gap silently while the button promised "all
 * data". `SUBJECT_ACCESS_EXPORT_COVERAGE` is now held to the list that defines
 * "personal" — `PRIVACY_RETENTION_CLASSIFICATION`, itself held to the Prisma
 * schema by `privacy-retention-census.test.ts` — so a new personal model fails
 * here until it is exported or excluded with a reason.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { stripComments } from "./support/strip-comments";
import { describe, expect, it } from "vitest";

import { PRIVACY_RETENTION_CLASSIFICATION } from "@/lib/privacy-retention-classification";
import {
  SUBJECT_ACCESS_EXPORT_COVERAGE,
  SUBJECT_ACCESS_EXPORT_EXCLUSIONS,
  SUBJECT_ACCESS_SECTIONS,
} from "@/lib/subject-access-export-coverage";

const personalModels = Object.entries(PRIVACY_RETENTION_CLASSIFICATION)
  .filter(([, classification]) => classification === "personal")
  .map(([model]) => model)
  .sort();

/** What the census compares: personal models missing from the map, and keys that are not personal models. */
function coverageGaps(coverage: Record<string, unknown>) {
  const keys = new Set(Object.keys(coverage));
  return {
    unplaced: personalModels.filter((model) => !keys.has(model)),
    notPersonal: [...keys].filter((key) => !personalModels.includes(key)).sort(),
  };
}

const builderSource = ["src/lib/subject-access-export.ts", "src/lib/subject-access-export-sections.ts"]
  .map((file) => stripComments(readFileSync(path.join(process.cwd(), file), "utf8")))
  .join("\n");
const additionalSource = stripComments(readFileSync(
  path.join(process.cwd(), "src/lib/subject-access-export-additional.ts"),
  "utf8",
));

describe("subject access export coverage census", () => {
  it("places exactly the models the privacy-retention classification marks personal", () => {
    expect(personalModels.length).toBeGreaterThan(0);
    expect(coverageGaps(SUBJECT_ACCESS_EXPORT_COVERAGE)).toEqual({ unplaced: [], notPersonal: [] });
  });

  it("fails when a personal model is dropped from the map (mutation probe)", () => {
    const [dropped] = personalModels;
    const mutated: Record<string, unknown> = { ...SUBJECT_ACCESS_EXPORT_COVERAGE };
    delete mutated[dropped!];
    expect(coverageGaps(mutated).unplaced).toEqual([dropped]);
  });

  it("sends each placement to a real section, an additional list, or a stated reason", () => {
    for (const [model, placement] of Object.entries(SUBJECT_ACCESS_EXPORT_COVERAGE)) {
      if (typeof placement === "string") {
        if (placement.startsWith("additionalRecords.")) {
          expect(placement, model).toBe(`additionalRecords.${model}`);
          // The additional reader returns this model's list under its own name.
          expect(additionalSource, model).toMatch(new RegExp(`\\b${model}\\b`));
        } else {
          expect(SUBJECT_ACCESS_SECTIONS as readonly string[], model).toContain(placement);
        }
      } else {
        expect(placement.excluded.trim().length, model).toBeGreaterThan(20);
      }
    }
  });

  it("fills every declared section in the shared builder", () => {
    for (const section of SUBJECT_ACCESS_SECTIONS) {
      expect(builderSource, section).toMatch(new RegExp(`\\b${section}\\b\\s*[:,]`));
    }
  });

  it("lists every excluded model, with its reason, in the file the subject receives", () => {
    const excluded = Object.entries(SUBJECT_ACCESS_EXPORT_COVERAGE)
      .flatMap(([model, placement]) => (typeof placement === "string" ? [] : [[model, placement.excluded]]));
    expect(SUBJECT_ACCESS_EXPORT_EXCLUSIONS.models).toEqual(Object.fromEntries(excluded));
  });

  it("keeps every security secret out of the export", () => {
    for (const model of personalModels.filter((name) => /Token$|TwoFactor|WebAuthn|Challenge/.test(name))) {
      const placement = SUBJECT_ACCESS_EXPORT_COVERAGE[model as keyof typeof SUBJECT_ACCESS_EXPORT_COVERAGE];
      expect(typeof placement, model).toBe("object");
    }
  });
});
