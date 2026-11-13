import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WHERE the calculated identity age is allowed to exist (#2568).
 *
 * The owner specification is as much about where age must NOT appear as about
 * where it must: not on the ordinary Family Group overview, not on routine member
 * pills, not on unrelated administration screens, not on member-facing screens,
 * and not in public responses. Assertions on individual payloads (see
 * `family-group-identity-age.test.ts`) can only ever cover the surfaces someone
 * remembered to write a test for.
 *
 * This walks the whole tree instead and pins the complete list of modules that
 * touch the identity-age helper or its display components. Adding age to a new
 * screen therefore fails here first, and the fix is to decide — deliberately —
 * whether that screen is an identity-sensitive administrator action or a routine
 * view, and only then to add the file below.
 */

const SRC_ROOT = path.join(process.cwd(), "src");

/** Modules permitted to CALCULATE the identity age. All server-side. */
const AGE_PRODUCERS = [
  // The helper itself.
  "src/lib/member-age.ts",
  // Identity-sensitive family-group payloads.
  "src/lib/admin-family-group-member-search.ts",
  "src/lib/admin-family-group-requests-service.ts",
  "src/lib/family-suggestions.ts",
  "src/app/api/admin/family-groups/[id]/route.ts",
] as const;

/**
 * Every module that carries the `ageLabel` field — the wire types, the payload
 * builders, and the admin screens that render it. All admin, all
 * identity-sensitive.
 */
const AGE_LABEL_SURFACES = [
  "src/lib/member-age.ts",
  "src/lib/admin-family-group-ui-helpers.ts",
  "src/lib/admin-family-group-member-search.ts",
  "src/lib/admin-family-group-requests-service.ts",
  "src/lib/family-suggestions.ts",
  "src/app/api/admin/family-groups/[id]/route.ts",
  "src/components/admin/family-groups/member-age-display.tsx",
  "src/components/admin/family-groups/request-review-card.tsx",
  "src/components/admin/family-groups/login-holder-section.tsx",
  "src/components/admin/family-group-editor.tsx",
  "src/app/(admin)/admin/membership/family-groups/page.tsx",
  "src/components/admin/family-groups/family-suggestions-panel.tsx",
] as const;

/** Modules permitted to render it through the shared display components. */
const AGE_RENDERERS = [
  "src/components/admin/family-groups/member-age-display.tsx",
  "src/components/admin/family-groups/request-review-card.tsx",
  "src/components/admin/family-groups/login-holder-section.tsx",
  "src/components/admin/family-group-editor.tsx",
  "src/app/(admin)/admin/membership/family-groups/page.tsx",
] as const;

// A CALL to the helper, not a mention of its name in a doc comment.
const CALCULATES_AGE = /\bformatMemberIdentityAge\s*\(/;
// The identity-age FIELD: declared, assigned, or read. Deliberately not a bare
// substring — an unrelated local named `ageLabel` (the public fee tables have
// one, for an age-TIER label) must not be swept in.
const CARRIES_AGE_LABEL = /\bageLabel\s*[:?]|\.ageLabel\b/;
const RENDERS_AGE = /\bMemberAge(?:Chip|Line)\b/;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Test files are exempt: they assert on the behaviour by definition.
      if (entry.name === "__tests__") return [];
      return walk(entryPath);
    }
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

function repoPath(absolute: string) {
  return path.relative(process.cwd(), absolute).split(path.sep).join("/");
}

const sourceFiles = walk(SRC_ROOT).map((absolute) => ({
  file: repoPath(absolute),
  contents: fs.readFileSync(absolute, "utf8"),
}));

describe("identity age — which modules may produce it (#2568)", () => {
  it("is calculated only by the allowlisted server modules", () => {
    const producers = sourceFiles
      .filter(({ contents }) => CALCULATES_AGE.test(contents))
      .map(({ file }) => file)
      .sort();

    expect(producers).toEqual([...AGE_PRODUCERS].sort());
  });

  it("pins every module that carries the age label at all", () => {
    const surfaces = sourceFiles
      .filter(
        ({ contents }) =>
          CALCULATES_AGE.test(contents) || CARRIES_AGE_LABEL.test(contents)
      )
      .map(({ file }) => file)
      .sort();

    expect(surfaces).toEqual([...AGE_LABEL_SURFACES].sort());
  });

  it("never reaches a public or member-facing API route", () => {
    for (const { file, contents } of sourceFiles) {
      const isMemberOrPublicRoute =
        file.startsWith("src/app/api/") && !file.startsWith("src/app/api/admin/");
      if (!isMemberOrPublicRoute) continue;
      expect(CALCULATES_AGE.test(contents), file).toBe(false);
      expect(CARRIES_AGE_LABEL.test(contents), file).toBe(false);
    }
  });

  it("never reaches a member-facing, lodge, or public page", () => {
    for (const { file, contents } of sourceFiles) {
      const isMemberOrPublicPage =
        file.startsWith("src/app/(authenticated)/") ||
        file.startsWith("src/app/(public)/") ||
        file.startsWith("src/app/(lodge)/");
      if (!isMemberOrPublicPage) continue;
      expect(CALCULATES_AGE.test(contents), file).toBe(false);
      expect(CARRIES_AGE_LABEL.test(contents), file).toBe(false);
      expect(RENDERS_AGE.test(contents), file).toBe(false);
    }
  });

  it("stores no calculated age: the schema has no age column", () => {
    const schema = fs.readFileSync(
      path.join(process.cwd(), "prisma/schema.prisma"),
      "utf8"
    );
    // Age changes on its own every day, so it is derived on every read and never
    // persisted. `ageTier` is a separate, deliberately stored classification.
    expect(schema).not.toMatch(/^\s*ageLabel\s/m);
    expect(schema).not.toMatch(/^\s*ageYears\s/m);
    expect(schema).not.toMatch(/^\s*calculatedAge\s/m);
  });
});

describe("identity age — which modules may render it (#2568)", () => {
  it("is displayed only by the allowlisted admin surfaces", () => {
    const renderers = sourceFiles
      .filter(({ contents }) => RENDERS_AGE.test(contents))
      .map(({ file }) => file)
      .sort();

    expect(renderers).toEqual([...AGE_RENDERERS].sort());
  });

  it("keeps the routine family-group overview table free of the age display", () => {
    const page = sourceFiles.find(
      ({ file }) => file === "src/app/(admin)/admin/membership/family-groups/page.tsx"
    );
    expect(page).toBeTruthy();

    // The page hosts BOTH an identity-sensitive new-group form (where the age
    // belongs) and the routine groups table (where it does not). Slice the table
    // body out and assert the age display is absent from it.
    const contents = page!.contents;
    const tableStart = contents.indexOf("{filteredGroups.map((g) => (");
    expect(tableStart).toBeGreaterThan(-1);
    const table = contents.slice(tableStart);
    expect(table).not.toContain("MemberAgeChip");
    expect(table).not.toContain("MemberAgeLine");
    expect(table).not.toContain("ageLabel");
  });
});
