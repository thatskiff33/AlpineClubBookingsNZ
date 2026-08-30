/**
 * EVERY ADMIN-SIDE LAYOUT GOES THROUGH THE ONE GUARD (AID-7, #2378).
 *
 * `admin-layout-guard.ts` was extracted because #2378 was originally going to add a
 * second admin-side layout: owner decision Q4 gave Diagnostics its own workspace
 * without the admin sidebar. **The owner superseded Q4 on 12 Aug 2026** — Diagnostics
 * is asked from the Help bubble and its page lives under `/admin/*` like every other
 * admin screen — so that second layout was built and then removed, and `(admin)` is
 * once again the only group here.
 *
 * THE EXTRACTION AND THIS CENSUS BOTH SURVIVED THAT REVERSAL, and it is worth saying
 * why rather than leaving a test whose stated reason no longer exists. The page now
 * INHERITS the one guard instead of carrying a second copy of it, which is the same
 * property this file protects from the other side: without the census, the next person
 * to add an admin layout writes the sequence again from memory, and the copy that
 * omits the two-factor gate looks exactly like the copy that does not.
 *
 * IT IS A SOURCE CENSUS BECAUSE THE UNIT TESTS CANNOT BE ONE. A layout that re-reads
 * the session itself and forgets `member.active` renders perfectly well; nothing
 * throws, no assertion in any behavioural test is watching that file, and the page
 * looks right to whoever wrote it. What is wrong is who can see it. Only reading the
 * source can tell.
 *
 * The list is DISCOVERED from the app directory rather than written down, because a
 * written list is a thing a new layout can be missing from — which is the precise
 * failure this file exists to prevent, and the same failure #2786's own census hit
 * when a hand-maintained list silently omitted a module.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

const APP_DIR = join(import.meta.dirname, "..", "..", "app");

/**
 * Groups that perform NO admin admission, each with the reason it is exempt from
 * the must-call-the-guard rule. Exemption is from that rule ONLY: the
 * no-preamble-steps sweep below still covers these, because a public layout that
 * starts resolving admin route requirements is exactly as wrong as an admin one.
 */
const NON_ADMIN_GROUPS = [
  "(authenticated)", // member-facing product; its own session gate, no admin areas
  "(lodge)", // lodge-facing product; same
  "(public)", // anonymous pages; admission would be a bug
  "(website)", // the public website shell
  "(website-dynamic)", // the public website's dynamic half
] as const;

/**
 * The groups that MUST call the shared guard: everything discovered on disk minus
 * the explicit exemptions above. The first version of this file hand-wrote
 * `["(admin)"]` here and used discovery only for a containment check — so a
 * brand-new `(diagnostics)/layout.tsx` re-implementing the preamble without the
 * two-factor gate would have been discovered, then never read: verbatim the
 * failure the docblock said this census prevents (contract review, 13 Aug 2026).
 * Now a new group is swept automatically, and exempting it is a visible edit to
 * the reasoned list above rather than an accident of a stale list here.
 */
const ADMIN_LAYOUT_GROUPS = discoverGroupLayouts()
  .map((entry) => entry.group)
  .filter((group) => !(NON_ADMIN_GROUPS as readonly string[]).includes(group));

/** Every discovered group, for the rules that apply to admin and non-admin alike. */
const ALL_LAYOUT_GROUPS = discoverGroupLayouts().map((entry) => entry.group);

/** Every `layout.tsx` under a route group directly inside `src/app`. */
function discoverGroupLayouts(): { group: string; path: string }[] {
  return readdirSync(APP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("("))
    .map((entry) => ({
      group: entry.name,
      path: join(APP_DIR, entry.name, "layout.tsx"),
    }))
    .filter((candidate) => {
      try {
        return statSync(candidate.path).isFile();
      } catch {
        return false;
      }
    });
}

/**
 * The steps a layout must NOT perform itself, by the symbol that performs each.
 *
 * `hasAdminAreaAccess` is deliberately ABSENT, and the distinction matters. The
 * layout legitimately calls it to decide whether to render the site-style banner —
 * that is a rendering decision about one widget, not admission. Forbidding the whole
 * helper would fail an honest layout and teach the next author that this census is
 * noise to be worked around. What is forbidden is ADMISSION: resolving the route's
 * requirement, applying the consolidated-fees special case, and choosing where a
 * refused member goes.
 */
const FORBIDDEN_IN_LAYOUT = [
  "recordAuthBounce",
  "isTwoFactorSessionBlocked",
  "getAdminRouteRequirement",
  "isConsolidatedFeesPath",
  "getFirstAccessibleAdminHref",
  "MEMBER_ONBOARDING_GATE_SELECT",
] as const;

/** Every step the guard itself must still perform, admission included. */
const GUARD_MUST_PERFORM = [
  ...FORBIDDEN_IN_LAYOUT,
  "hasAdminAreaAccess",
] as const;

/**
 * The strictly ADMIN-ADMISSION symbols, forbidden in EVERY group layout including
 * the exempt member-facing ones. `recordAuthBounce`, the two-factor check and the
 * onboarding select are deliberately not here — `(authenticated)` and `(lodge)`
 * legitimately run their own member-session preambles with those pieces. What no
 * non-admin layout may ever do is resolve admin route requirements or route
 * refused members through admin logic.
 */
const ADMIN_ADMISSION_SYMBOLS = [
  "getAdminRouteRequirement",
  "isConsolidatedFeesPath",
  "getFirstAccessibleAdminHref",
] as const;


/**
 * Source with comments AND import statements removed.
 *
 * The import block is stripped for a reason found by mutation, not by taste: the
 * first version of this file asserted the guard "contains" each step's symbol, and
 * deleting the entire two-factor check from the guard still PASSED — because
 * `isTwoFactorSessionBlocked` remained in the import list. The assertion was
 * satisfied by an import that called nothing, on the single most load-bearing step
 * in the file. Stripping imports is what makes "performs" mean performs.
 */
function executableCode(source: string): string {
  return stripComments(source)
    .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];$/gm, "")
    .replace(/^import\s+["'][^"']+["'];$/gm, "");
}

describe("the admin security preamble has exactly one implementation (#2378)", () => {
  it("discovered the route groups, so the assertions below are not vacuous", () => {
    // The swept list is derived, so the guard here is against deriving an EMPTY
    // list: `(admin)` must be in it, or discovery broke (moved directory, renamed
    // group) and every it.each below silently ran zero times.
    expect(ADMIN_LAYOUT_GROUPS).toContain("(admin)");
    // And the exemptions must stay real directories: an exemption for a group that
    // no longer exists is a stale hole waiting for a new group to take the name.
    for (const exempt of NON_ADMIN_GROUPS) {
      expect(
        ALL_LAYOUT_GROUPS,
        `${exempt} is exempted but has no layout.tsx`,
      ).toContain(exempt);
    }
  });

  it.each(ADMIN_LAYOUT_GROUPS)(
    "%s calls the shared guard rather than re-implementing it",
    (group) => {
      const source = readFileSync(join(APP_DIR, group, "layout.tsx"), "utf8");

      expect(source).toContain("guardAdminLayout");
      // And it must ACT on the refusal. Calling the guard and ignoring its verdict
      // would pass a naive "does it import the helper" check while admitting
      // everybody — the one failure mode a census like this can talk itself into.
      expect(source).toMatch(/outcome\s*===\s*"redirect"/);
      expect(source).toContain("redirect(");
    },
  );

  it.each(ADMIN_LAYOUT_GROUPS)(
    "%s does not perform any preamble step itself",
    (group) => {
      const source = readFileSync(join(APP_DIR, group, "layout.tsx"), "utf8");
      const code = stripComments(source);

      for (const symbol of FORBIDDEN_IN_LAYOUT) {
        expect(
          code,
          `${group}/layout.tsx performs "${symbol}" itself. That step belongs to admin-layout-guard.ts — a second implementation is a second thing to forget to update.`,
        ).not.toContain(symbol);
      }
      // The fresh member read in particular: a layout that queries the member table
      // itself has re-created the exact staleness the guard exists to close.
      expect(code).not.toContain("prisma.member.findUnique");
    },
  );

  it("keeps the guard's own steps present, so extraction did not lose one", () => {
    // The other direction. Moving code is where steps go missing, and every one of
    // these is load-bearing: drop the 2FA check and a gated admin walks straight in.
    const guard = executableCode(
      readFileSync(join(import.meta.dirname, "..", "admin-layout-guard.ts"), "utf8"),
    );
    for (const symbol of GUARD_MUST_PERFORM) {
      // A CALL, not a mention. `MEMBER_ONBOARDING_GATE_SELECT` is a constant used as
      // a value, so it is matched bare; everything else must be invoked.
      const needle =
        symbol === "MEMBER_ONBOARDING_GATE_SELECT" ? symbol : `${symbol}(`;
      expect(
        guard,
        `the guard no longer performs "${symbol}" — an import alone is not performing it`,
      ).toContain(needle);
    }
    expect(guard).toContain("forcePasswordChange");
    expect(guard).toContain("member.active");
  });

  it.each(ALL_LAYOUT_GROUPS)(
    "%s performs no ADMIN admission logic, exempt or not",
    (group) => {
      // The exemption above is from must-call-the-guard, never from this: a public
      // or member layout that starts resolving admin route requirements has
      // re-implemented the one thing that must have one implementation.
      const source = readFileSync(join(APP_DIR, group, "layout.tsx"), "utf8");
      const code = stripComments(source);
      for (const symbol of ADMIN_ADMISSION_SYMBOLS) {
        expect(
          code,
          `${group}/layout.tsx performs "${symbol}" — admin admission belongs to admin-layout-guard.ts alone.`,
        ).not.toContain(symbol);
      }
    },
  );

  it("never redirects on the caller's behalf", () => {
    // `redirect()` throws. A helper that throws control flow makes the caller's
    // behaviour depend on where in its body the call sits, including whether a
    // `try/catch` added later swallows it. The guard returns a destination; the
    // layout redirects.
    const guard = readFileSync(
      join(import.meta.dirname, "..", "admin-layout-guard.ts"),
      "utf8",
    );
    const code = stripComments(guard);
    expect(code).not.toContain("redirect(");
    expect(code).not.toContain('from "next/navigation"');
  });
});
