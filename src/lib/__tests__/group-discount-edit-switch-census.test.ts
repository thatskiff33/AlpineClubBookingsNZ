import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Comments are stripped before every count below, because a census that counts
// prose counts the wrong things in both directions. It really happened:
// `booking-edit-guest-ranges.ts` documents what its callers pass by naming the
// mapper and its argument, and the raw-text scan read that sentence as an
// undeclared production call site. The reverse mistake is the dangerous one — a
// scan that cannot tell code from prose can be talked out of a finding by
// wording, in either direction.
import { stripComments } from "./support/strip-comments";

/**
 * Census: the club's edit-time group-discount switch has exactly ONE gate, and
 * every edit path goes through it (#2770, INV-MOD-026).
 *
 * `GroupDiscountSetting.applyToEdits` decides whether a booking edited later
 * earns the group discount on the nights that edit newly buys. The owner's
 * decision (on #2756, 10 Aug 2026) was explicit that the admin controls this
 * **per discount, not per code path**: the switch must govern every edit path
 * uniformly, because the defect it shipped alongside was one planner reading a
 * different discount config from every other path — the same club, the same
 * night, the same party, two prices, decided by nothing but which branch the
 * edit took.
 *
 * That makes the mapper the whole invariant. There are two of them and they
 * differ by one boolean:
 *
 *  - `toGroupDiscountConfig` — a FIRST purchase. Creation, the public quote, a
 *    group booking, a school/booking-request approval, and the waitlist offer
 *    reprice that re-bases a booking at current rates before the member
 *    confirms. Not gated: none of those is an edit to nights somebody already
 *    holds.
 *  - `toEditTimeGroupDiscountConfig` — an EDIT. Gated, and the only place the
 *    switch is applied anywhere in the tree.
 *
 * Nothing in the type system can tell a wrong choice from a deliberate one:
 * both take the same row and return the same type, and the difference is
 * invisible at every call site and in every test that configures the switch's
 * default. Getting it wrong in the creation direction hands out a discount the
 * club switched off; getting it wrong in the edit direction is the two-tier
 * price again. So the inventory is mechanical, in the style of
 * `in-progress-edit-sold-price-census.test.ts` and
 * `guest-stay-expansion-census.test.ts`: a new call site has to be classified
 * here as creation or edit before it can go green.
 *
 * ## The forward guard, and why it is in this file
 *
 * Since #2756 (PR #2772) `buildInProgressGuestRangePlan` takes a group-discount
 * config, and the value it is handed must be the gated one or the two planner
 * branches disagree again and the switch is decorative on the very path that
 * motivated it. This census cannot follow a value across files, so it pins what
 * it can see: every production caller of that planner must be a declared EDIT
 * path, so the config can only ever come from a file that resolves it through
 * the gate. Both current callers — `calculateModifiedPricing` and the
 * modify-quote route — read the setting ONCE and hand the same resolved value to
 * that planner and to their ordinary pricing pass, which is the property the
 * pricing suite then measures in cents at both branches.
 *
 * ## The hand-rolled-literal guard, and why it exists at all
 *
 * A census of mapper CALLS is blind to the one shape that needs it most: a file
 * that never calls a mapper and assembles the config itself. That is not
 * hypothetical — `/api/promo-codes/validate` did exactly that, gated on `enabled`
 * alone, and was therefore invisible to every assertion here while the edit panel
 * called it. It is also the same defect class #2756 closed for seasons: a second,
 * hand-written copy of a config the tree resolves in one place, free to drift
 * from it in silence. So the last test scans for the SHAPE rather than for a
 * name, and fails any production file outside the mapper home that builds one.
 *
 * ## What this census does and does not guarantee
 *
 * It is a SOURCE-TEXT census over `src/`, excluding `__tests__`, run over
 * comment-stripped source so prose can neither add a phantom call site nor hide
 * a real one. It guarantees that no production call to either mapper appears
 * without being declared, that the call COUNT in each declared file is what is
 * declared (so a second call cannot hide behind the first), that no declared
 * edit path calls the creation mapper or vice versa, and that nobody builds the
 * config by hand. It cannot follow a config resolved in one file and passed
 * through three others; the declarations record that route in prose.
 */

const SRC_ROOT = path.resolve(process.cwd(), "src");

function allSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : allSourceFiles(absolute);
    }
    return /\.(ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

function repoRelative(absolute: string): string {
  return path.relative(process.cwd(), absolute).split(path.sep).join("/");
}

function readSource(absolute: string): string {
  return stripComments(fs.readFileSync(absolute, "utf8"));
}

function read(file: string): string {
  return readSource(path.resolve(process.cwd(), file));
}

function countMatches(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

/**
 * A CALL to the creation mapper.
 *
 * The lookbehind drops its own declaration. An import or re-export has no `(`
 * after the name and never matches, which is deliberate: importing the symbol
 * is not what prices a booking. `toEditTimeGroupDiscountConfig` does not contain
 * the substring `toGroupDiscountConfig`, so the two patterns cannot alias.
 */
const CREATION_MAPPER_CALL = /(?<!function\s)\btoGroupDiscountConfig\s*\(/g;

/** A CALL to the edit-time mapper — the gate. */
const EDIT_MAPPER_CALL = /(?<!function\s)\btoEditTimeGroupDiscountConfig\s*\(/g;

/** A CALL to the in-progress planner (see "the forward guard" above). */
const IN_PROGRESS_PLAN_CALL =
  /(?<!function\s)\bbuildInProgressGuestRangePlan\s*\(/g;

/**
 * Every production file that resolves a group-discount config, and which kind of
 * purchase it is resolving one FOR.
 *
 * The two call counts are declared rather than counted, so a second call added to
 * a file already on the list fails the census instead of inheriting the first
 * one's classification — and so a creation call appearing in an edit path, or the
 * reverse, fails as a COUNT as well as a classification.
 *
 * `mapper-home` is where the two mappers and the member-facing note are defined
 * in terms of each other. `either` is the one OTHER shape allowed to hold both,
 * for a route that previews a first purchase for some callers and an edit for
 * others and is told which by the request — exactly one of the two runs per
 * request, so it still never holds two different configs at once.
 */
const MAPPER_CALL_SITES = [
  // ------------------------------------------------------------- mapper home
  {
    file: "src/lib/policies/booking-route-decisions.ts",
    kind: "mapper-home",
    creationCalls: 2,
    editCalls: 1,
    what: "where the mappers live. toEditTimeGroupDiscountConfig applies the switch and then delegates to toGroupDiscountConfig for the rest of the shape, so the two answers can never drift apart field by field. The SECOND creation call is groupDiscountEditNotice's: it derives the member-facing note from the edit mapper (so a quote can never state a withheld discount while the same request grants it) and then asks the UNGATED config whether this stay would have been discounted at all, so the note is never shown beside a number that did not move. That ungated resolution is deliberately kept in here rather than handed to the route, so no caller can reach around the switch",
  },

  // ---------------------------------------------------------------- creation
  {
    file: "src/app/api/bookings/quote/route.ts",
    kind: "creation",
    creationCalls: 1,
    editCalls: 0,
    what: "the public create-flow quote — a price for a booking that does not exist yet",
  },
  {
    file: "src/app/api/bookings/route.ts",
    kind: "creation",
    creationCalls: 1,
    editCalls: 0,
    what: "booking creation itself",
  },
  {
    file: "src/lib/group-booking.ts",
    kind: "creation",
    creationCalls: 2,
    editCalls: 0,
    what: "creating a group booking, and pricing a group booking request at approval — both first purchases",
  },
  {
    file: "src/lib/school-booking-request.ts",
    kind: "creation",
    creationCalls: 1,
    editCalls: 0,
    what: "the school booking request's indicative and approval price — a first purchase",
  },
  {
    file: "src/lib/waitlist.ts",
    kind: "creation",
    creationCalls: 1,
    editCalls: 0,
    what: "the waitlist OFFER reprice: INV-MOD-005's deliberate exception re-bases the whole booking at current rates before the member confirms, and the offer email quotes that number. It buys the original nights rather than adding any, so it is not a later edit and is not gated — gating it would make the offer email disagree with the confirm",
  },
  {
    file: "src/lib/waitlist-cross-lodge.ts",
    kind: "creation",
    creationCalls: 1,
    editCalls: 0,
    what: "the cross-lodge offerability probe for the same reprice",
  },

  // -------------------------------------------------------------------- edit
  {
    file: "src/lib/booking-modify-plan.ts",
    kind: "edit",
    creationCalls: 0,
    editCalls: 1,
    what: "calculateModifiedPricing — the ordinary planner's pricing pass, and the file that also builds the in-progress plan, so it is where the two branches would diverge",
  },
  {
    file: "src/lib/booking-date-modification-service.ts",
    kind: "edit",
    creationCalls: 0,
    editCalls: 1,
    what: "the date-modification service: a check-out extension buys nights, and the switch decides whether they are discounted",
  },
  {
    file: "src/lib/booking-guest-removal-service.ts",
    kind: "edit",
    creationCalls: 0,
    editCalls: 1,
    what: "the single-guest-removal service. A removal buys nothing, so on a healthy booking every remaining night is locked and the switch cannot move a cent; it is gated with the rest because ONE value per edit is the invariant, and because the legacy no-stored-rows guest INV-MOD-005 names does price at current rates",
  },
  {
    file: "src/app/api/bookings/[id]/guests/route.ts",
    kind: "edit",
    creationCalls: 0,
    editCalls: 1,
    what: "the guest-add route — the archetypal later edit",
  },
  {
    file: "src/app/api/bookings/[id]/modify-quote/route.ts",
    kind: "edit",
    creationCalls: 0,
    editCalls: 1,
    what: "the modify-quote preview, which must resolve the same value the save path charges (#1095) or the member is quoted a discount the save then refuses",
  },

  // ------------------------------------------------------- either, by request
  {
    file: "src/app/api/promo-codes/validate/route.ts",
    kind: "either",
    creationCalls: 1,
    editCalls: 1,
    what: "the promo-code preview. ONE route serves both the create wizard and the edit panel, so it is told which by the request's `forBookingEdit` flag (absent = a first purchase, which is what every create-flow client sends) and resolves through the matching mapper. Exactly one branch runs per request. It used to hand-roll the config inline behind `enabled` alone, which is why the shape guard below now exists; nothing here decides a charge — `modify-quote` and the save path each recompute the promo on their own gated pricing (#1095)",
  },
] as const;

const creationSites = MAPPER_CALL_SITES.filter((site) => site.creationCalls > 0);
const editSites = MAPPER_CALL_SITES.filter((site) => site.editCalls > 0);
/** Only these may resolve a config for an edit; the mapper home only defines it. */
const editPathSites = MAPPER_CALL_SITES.filter((site) => site.kind === "edit");
const creationPathSites = MAPPER_CALL_SITES.filter(
  (site) => site.kind === "creation",
);

describe("group-discount edit-time switch census (#2770, INV-MOD-026)", () => {
  it("declares every production caller of the creation mapper", () => {
    const found = allSourceFiles(SRC_ROOT)
      .filter(
        (absolute) =>
          countMatches(readSource(absolute), CREATION_MAPPER_CALL) > 0,
      )
      .map(repoRelative)
      .sort();

    // A file appearing here that is not declared is an UNGATED discount: it
    // hands out the group discount whatever the club set applyToEdits to. If it
    // is an edit path, it must call toEditTimeGroupDiscountConfig instead; if it
    // is genuinely a first purchase, declare it above with the reason.
    expect(found).toEqual(creationSites.map((site) => site.file as string).sort());
  });

  it("declares every production caller of the edit-time mapper", () => {
    const found = allSourceFiles(SRC_ROOT)
      .filter(
        (absolute) =>
          countMatches(readSource(absolute), EDIT_MAPPER_CALL) > 0,
      )
      .map(repoRelative)
      .sort();

    expect(found).toEqual(editSites.map((site) => site.file as string).sort());
  });

  it("counts the calls in each declared file, so a second one cannot hide", () => {
    for (const site of MAPPER_CALL_SITES) {
      const source = read(site.file);
      expect(
        countMatches(source, CREATION_MAPPER_CALL),
        `${site.file} creation-mapper calls`,
      ).toBe(site.creationCalls);
      expect(
        countMatches(source, EDIT_MAPPER_CALL),
        `${site.file} edit-mapper calls`,
      ).toBe(site.editCalls);
    }
  });

  it("keeps the two lists disjoint: no path resolves the discount both ways", () => {
    // One value per edit is the invariant. A file that resolved a gated config
    // for one pricing pass and an ungated one for another would recreate the
    // two-tier price inside a single request. Only the mapper home holds both,
    // because that is where one is defined in terms of the other.
    const problems: string[] = [];
    for (const site of editPathSites) {
      if (countMatches(read(site.file), CREATION_MAPPER_CALL) > 0) {
        problems.push(
          `${site.file} is a declared EDIT path but calls toGroupDiscountConfig — an edit must resolve the discount through toEditTimeGroupDiscountConfig so the club's applyToEdits switch reaches it (#2770, INV-MOD-026)`,
        );
      }
    }
    for (const site of creationPathSites) {
      if (countMatches(read(site.file), EDIT_MAPPER_CALL) > 0) {
        problems.push(
          `${site.file} is a declared FIRST-PURCHASE path but calls toEditTimeGroupDiscountConfig — creation, the waitlist offer reprice and request approvals must not consult the edit switch (#2770, INV-MOD-026)`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("lets the in-progress planner be reached only from a declared edit path", () => {
    // The forward guard. #2756 (PR #2772) gives buildInProgressGuestRangePlan a
    // group-discount config; whoever hands it one must be a file that resolves
    // it through the gate, or the in-progress branch prices a night differently
    // from the ordinary branch at the same club again.
    const callers = allSourceFiles(SRC_ROOT)
      .filter(
        (absolute) =>
          countMatches(readSource(absolute), IN_PROGRESS_PLAN_CALL) > 0,
      )
      .map(repoRelative)
      .sort();

    // Non-empty is part of the assertion: a pattern that stopped matching would
    // otherwise pass this vacuously.
    expect(callers.length).toBeGreaterThan(0);
    const editFiles = new Set(
      editPathSites.map((site) => site.file as string),
    );
    expect(callers.filter((file) => !editFiles.has(file))).toEqual([]);
  });

  it("applies the switch in exactly one place", () => {
    // The chokepoint, asserted rather than assumed. `applyToEdits` may be READ
    // outside the mapper — the admin route validates and persists it, the admin
    // section stages it, the modify-quote route tells the member when it is off,
    // the config-transfer allowlist carries it between clubs — but only one
    // production file may turn it into a pricing DECISION.
    const decidingFiles = allSourceFiles(SRC_ROOT)
      .filter((absolute) =>
        /!setting\?\.applyToEdits|applyToEdits\s*\?\s*toGroupDiscountConfig/.test(
          readSource(absolute),
        ),
      )
      .map(repoRelative);

    expect(decidingFiles).toEqual([
      "src/lib/policies/booking-route-decisions.ts",
    ]);
  });

  it("refuses a group-discount config built by hand instead of through a mapper", () => {
    // The shape guard. Every test above looks for a mapper NAME, so the one
    // failure mode they are all blind to is a file that calls neither and
    // assembles the four-key `GroupDiscountConfig` itself — which is what
    // `/api/promo-codes/validate` did, gated on `enabled` alone, while the edit
    // panel called it. A hand-rolled copy of a config the tree resolves in one
    // place is free to drift from it silently, and this one already had.
    //
    // Matched by shape: an object literal that sets `minGroupSize` to something
    // and `enabled` to the literal `true`. `minGroupSize: true` is excluded
    // because that is a Prisma `select` projection, not a config — the public
    // fee-page tokens select exactly those three columns.
    const HAND_ROLLED_CONFIG =
      /\bminGroupSize\s*:\s*(?!true\b)[^,;}]+[,;][\s\S]{0,400}?\benabled\s*:\s*true\b/;
    const offenders = allSourceFiles(SRC_ROOT)
      .filter((absolute) => HAND_ROLLED_CONFIG.test(readSource(absolute)))
      .map(repoRelative)
      .sort();

    // Only the mapper home may write the literal, because it is the literal
    // everything else must come from.
    expect(offenders).toEqual(["src/lib/policies/booking-route-decisions.ts"]);
  });
});
