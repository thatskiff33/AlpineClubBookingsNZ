import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { blankLiterals } from "./support/strip-comments";
import { balancedBrackets } from "./support/balanced-brackets";

// #2130 guard (same shape as club-module-settings-select-guard.test.ts): every
// read AND write of XeroItemCodeMapping and AgeTierSetting must name its
// columns with an explicit `select`. A bare
// findUnique/findFirst/findMany/create/update/upsert makes Prisma name EVERY
// scalar column in the SELECT or in a write's implicit RETURNING, so a
// draining old colour issuing that SQL after a column drop gets Postgres 42703
// ("column ... does not exist").
//
// ORIGINAL RATIONALE, NOW SPENT: this guard was added by the #2130 STEP 1.5
// runtime-prep release to protect three specific doomed columns —
// XeroItemCodeMapping.isMember and
// AgeTierSetting.xeroContactGroupId/xeroContactGroupName — through the window
// before the contract migration. That migration
// (20260721130000_contract_drop_ismember_and_agetier_xero_columns, Release B)
// has now dropped all three, so the original blast radius is gone.
//
// KEPT DELIBERATELY, not left behind by accident. Three reasons: (1) narrow
// selects are the house rule for both models and this is the only thing that
// enforces it repo-wide; (2) these two tables are the standing legacy-column
// surface — E4/E8 alone left three doomed columns on them, and the next
// contraction will want exactly this guard already in place rather than
// reintroduced under time pressure; (3) it is a cheap read-only static scan
// with no runtime or fixture cost. Deleting it would silently re-permit a bare
// findMany, which is the precise regression the #2130 two-step existed to
// prevent.
//
// This is a static source scan rather than only per-call-site mock pins so a
// NEW call site fails CI immediately, instead of relying on someone
// remembering to add a matching mock assertion. Unlike the ClubModuleSettings
// guard this surface also spans prisma/seed.ts and scripts/, so all three
// roots are walked.
//
// deleteMany/updateMany/count/aggregate/groupBy are deliberately NOT scanned:
// they emit no RETURNING and project no columns, so they are safe unnarrowed.

const SCAN_ROOTS = ["src", "prisma", "scripts"].map((dir) =>
  path.join(process.cwd(), dir),
);

// Named for what the guard enforces NOW (narrow selects on these models), not
// for the three columns it originally protected — those are dropped.
//
// `familyGroupMember` was registered here by #2520's RUNTIME half (PR #2565) and
// REMOVED again by its CONTRACT half: `FamilyGroupMember.role` no longer exists.
// `20260803030000_contract_drop_family_group_member_role` dropped the column and
// the same release removed the field from prisma/schema.prisma, so an unnarrowed
// read of that model can no longer name a doomed column — there is none, and the
// generated client could not name it if there were. Keeping the registration
// would enforce narrowing on a model with nothing left to protect, which is not
// what this guard is for and would misdescribe why it is here. What still needs
// policing after the drop is raw SQL, which this scan never covered; that lives
// in src/lib/__tests__/family-group-role-retirement.test.ts.
//
// The two models below stay for the reasons in "KEPT DELIBERATELY" above: they
// are the standing legacy-column surface, and #2520 is the second contraction to
// have wanted this guard already in place rather than reintroduced under time
// pressure.
const NARROW_SELECT_MODELS = ["xeroItemCodeMapping", "ageTierSetting"];

const PROJECTING_METHODS = [
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "create",
  "update",
  "upsert",
  "delete",
];

function walk(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests are not runtime: their mocks and assertions mention the
      // delegates without issuing SQL, so scanning them only produces noise.
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      walk(full, files);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      files.push(full);
    }
  }
  return files;
}

/** Extract the balanced-paren call-argument text starting at an opening "(". */
function extractCallArgs(source: string, openParenIndex: number, structure: string): string {
  return balancedBrackets(source, openParenIndex, structure).text;
}

describe("doomed-column models are read and written with an explicit select", () => {
  it("has no bare XeroItemCodeMapping/AgeTierSetting projecting call in src/, prisma/ or scripts/", () => {
    const callPattern = new RegExp(
      `(?:${NARROW_SELECT_MODELS.join("|")})\\??\\.(?:${PROJECTING_METHODS.join(
        "|",
      )})\\(`,
      "g",
    );
    const offenders: string[] = [];
    const scanned: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walk(root)) {
        const source = fs.readFileSync(file, "utf8");
        if (!NARROW_SELECT_MODELS.some((model) => source.includes(model))) continue;
        // Calls are found over masked text: one named in a comment or string
        // is not a call and has no opening bracket to read.
        const structure = blankLiterals(source);
        let match: RegExpExecArray | null;
        callPattern.lastIndex = 0;
        while ((match = callPattern.exec(structure))) {
          const openParenIndex = match.index + match[0].length - 1;
          const args = extractCallArgs(source, openParenIndex, structure);
          const line = source.slice(0, match.index).split("\n").length;
          const location = `${path
            .relative(process.cwd(), file)
            .replace(/\\/g, "/")}:${line}`;
          scanned.push(location);
          if (!/\bselect\s*:/.test(args)) offenders.push(location);
        }
      }
    }

    // Sanity: if the scan finds nothing at all the guard has silently stopped
    // covering the surface (moved files, renamed delegates) and would pass
    // vacuously forever.
    expect(scanned.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
