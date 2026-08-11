/**
 * The audit-writer census CONTRACT (#2581).
 *
 * WHAT THIS GATE IS FOR. `AuditLog.category` is the only field a
 * category-filtered reader can filter on, so a row written without one is a row
 * the AI Diagnostics correlation tools return to nobody — `category = ANY ($1)`
 * evaluates to NULL, not true. #2581 found 82 production write sites in that
 * state and no way to notice the 83rd. This file is the way to notice it: the
 * census below is measured from the TypeScript AST on every run and compared
 * against the reviewed manifest, so a new uncategorised audit writer fails CI
 * with its own symbol in the message.
 *
 * IT ALSO CLOSES THE THREE HOLES THAT MADE THE HAND CENSUS UNRELIABLE:
 *
 *  - a category value the taxonomy does not contain (three writers had invented
 *    `membership`, one had invented `auth`, and nothing rejected either);
 *  - a hand-written `auditLog.create` that bypasses the audit boundary and so
 *    gets no sanitisation and no retention derivation;
 *  - a wrapper that stops passing a category, taking every caller with it.
 *
 * WHY IT PINS EXACT SETS RATHER THAN CEILINGS. A "no more than 82" assertion
 * passes when one writer is fixed and another is added. The uncategorised
 * population is pinned as a SET keyed by stable symbol, so fixing a writer means
 * deleting its manifest entry in the same diff, and adding one means adding an
 * entry a reviewer will see.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyAuditRetention } from "@/lib/audit";
import {
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_CORRELATION_DOMAIN,
  AUDIT_CATEGORY_LABELS,
  auditCategoryReaderAreas,
  isAuditCategory,
} from "@/lib/audit-categories";
import { MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS } from "@/lib/audit-query";

import {
  describeCategory,
  scanAuditWriterCensus,
  type AuditWriteSite,
} from "../../../scripts/audit/audit-writer-census";
import {
  APPLIED_AUDIT_CATEGORIES,
  APPROVED_FORWARDED_CATEGORY_SITES,
  APPROVED_MIGRATION_AUDIT_SQL,
  APPROVED_NON_PRODUCING_AUDIT_DML,
  AUDIT_CENSUS_TOTALS,
  AUDIT_WRITER_WRAPPERS,
  AUDIT_WRITERS_WITHOUT_ENTITY_IDENTIFIER,
  MEMBER_RECORD_ACTION_LITERAL_FILES_2755,
  MEMBER_RECORD_ADMIN_ACTIONS_2755,
  MEMBER_RECORD_ADMIN_CATEGORIES_2755,
  MEMBER_RECORD_ADMIN_SURFACES_2755,
  OFFICER_DRIVEN_MEMBER_VISIBLE_WRITERS_2755,
  REVIEWED_ADMIN_CATEGORIES_2730,
  UNCATEGORISED_AUDIT_WRITERS,
} from "../../../scripts/audit/audit-writer-census-manifest";

/**
 * One scan for the whole file. Parsing `src/`, `scripts/` and `prisma/` costs
 * several seconds and nine assertions ask questions of the same result.
 */
let cached: ReturnType<typeof scanAuditWriterCensus> | null = null;
function census() {
  cached ??= scanAuditWriterCensus();
  return cached;
}

function ids(sites: readonly AuditWriteSite[]): string[] {
  return sites.map((site) => site.id).sort();
}

type CurrentCensusClaim = {
  file: string;
  writeSites: number;
  /**
   * `null` for a claim whose wording states the SITE TOTAL and nothing about
   * uncategorised sites — "the site total is unchanged at N", "every one of the N
   * places does it". Those copies drift on the total exactly like the others, and
   * requiring them to mention a second number they never mention would either
   * leave them unpinned or invent an assertion the page did not make.
   */
  uncategorised: number | null;
};

function currentAuditCensusClaims(): CurrentCensusClaim[] {
  const repoRoot = process.cwd();
  const sourceFiles: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(path);
      } else if (entry.name.endsWith(".md") || entry.name.endsWith(".ts")) {
        sourceFiles.push(path);
      }
    }
  };
  walk(resolve(repoRoot, "docs"));
  walk(resolve(repoRoot, "src", "lib", "diagnostics", "tools", "packs"));

  const patterns: readonly {
    pattern: RegExp;
    implicitUncategorised?: number;
    /** The wording states the site total only; see `CurrentCensusClaim`. */
    totalOnly?: boolean;
  }[] = [
    {
      pattern:
        /\b(\d+)\s+row-producing\s+production\s+audit\s+write\s+sites\b[^.]{0,120}?\b(zero|\d+)\b[^.]{0,50}\b(?:record no category|uncategorised)\b/giu,
    },
    {
      pattern:
        /\b(?:the\s+)?census(?:\s+now)?\s+reads\s+(\d+)\s+(?:row-producing\s+)?(?:production\s+)?(?:audit\s+)?write\s+sites\s+and\s+(zero|\d+)\s+uncategorised\b/giu,
    },
    {
      pattern:
        /\bcurrent\s+exact-head\s+production\s+writers\s+have\s+(\d+)\s+row-producing\s+sites\s+and\s+(zero|\d+)\s+uncategorised\s+sites\b/giu,
    },
    {
      pattern:
        /\b(?:the\s+)?exact-head\s+census\s+has\s+(\d+)\s+row-producing\s+current\s+production\s+writer\s+sites\s+and\s+(zero|\d+)\s+uncategorised\s+sites\b/giu,
    },
    {
      pattern: /\ball\s+(\d+)\s+now\s+record\s+a\s+category\b/giu,
      implicitUncategorised: 0,
    },
    /*
      THE FOUR COPIES THE FIVE PATTERNS ABOVE COULD NOT SEE (#2679's review).

      Twelve current-fact copies of the total exist; those patterns matched eight,
      and the inventory pinned exactly the eight that matched — so a stale UNMATCHED
      copy was invisible to the assertion as well as to the discovery, which is how
      8/12 could ship under the name "every". That is the #2677 shape this file's own
      manifest ledger records in as many words: "a figure that no test reads WILL
      drift". This branch had already had to hand-fix two of the four, both of which
      said 427 on `origin/main`, precisely because nothing read them.

      Three new wordings, kept as separate patterns rather than folded into the
      others, because each is a genuinely different sentence shape and a loosened
      shared regex is how a HISTORICAL statement starts matching.
    */
    {
      // The fenced `npm run audit:census` paste on the category-review page. Its
      // DISTRIBUTION is compared against the manifest by its own test below.
      pattern: /\brow-producing\s+sites:\s+(\d+)\s+uncategorised:\s+(zero|\d+)\b/giu,
    },
    {
      // "The site total is unchanged at N" — a total-only claim.
      pattern: /\bsite\s+total\s+is\s+unchanged\s+at\s+(\d+)\b/giu,
      totalOnly: true,
    },
    {
      // "every one of the N sites in the tree" and "every one of the N places does
      // it" — the two prose forms that assert the total as a completeness claim.
      pattern: /\bevery\s+one\s+of\s+the\s+(\d+)\s+(?:sites|places)\b/giu,
      totalOnly: true,
    },
  ];

  const claims: CurrentCensusClaim[] = [];
  for (const sourceFile of sourceFiles) {
    const contents = readFileSync(sourceFile, "utf8")
      .replaceAll("**", "")
      .replace(/\s+\*\s+/g, " ")
      .replace(/\s+/g, " ");
    for (const { pattern, implicitUncategorised, totalOnly } of patterns) {
      for (const match of contents.matchAll(pattern)) {
        const uncategorised = match[2];
        claims.push({
          file: relative(repoRoot, sourceFile).replaceAll("\\", "/"),
          writeSites: Number(match[1]),
          uncategorised: totalOnly
            ? null
            : (implicitUncategorised ??
              (uncategorised?.toLowerCase() === "zero"
                ? 0
                : Number(uncategorised))),
        });
      }
    }
  }
  return claims.sort((left, right) => left.file.localeCompare(right.file));
}

describe("audit writer census (#2581)", { timeout: 180_000 }, () => {
  it("actually scanned the tree, so a broken walk cannot pass as a clean census", () => {
    // The failure mode this catches is the worst one available: a path change or a
    // bad exclusion makes `listSourceFiles` return nothing, every "no offenders"
    // assertion below passes vacuously, and the gate reports success while
    // measuring an empty tree.
    expect(census().filesScanned).toBeGreaterThan(1_500);
    expect(census().sites.length).toBeGreaterThan(300);
  });

  it("finds exactly the pinned number of production audit write sites", () => {
    expect(
      census().sites.length,
      "The number of production audit write sites moved. That is fine — it moves " +
        "whenever a feature records something new — but it is not a silent change: " +
        "update AUDIT_CENSUS_TOTALS.writeSites, and check the new writer appears " +
        "with a category rather than in UNCATEGORISED_AUDIT_WRITERS.",
    ).toBe(AUDIT_CENSUS_TOTALS.writeSites);
  });

  it("finds exactly the pinned per-sink split", () => {
    // Per-sink as well as in total, because a writer moved from `logAudit` to a
    // hand-built `auditLog.create` leaves the total untouched while losing the
    // boundary's sanitisation and retention derivation.
    const measured = Object.fromEntries(
      Object.entries(census().sinkCounts).map(([sink, counts]) => [
        sink,
        { total: counts.total, uncategorised: counts.uncategorised },
      ]),
    );
    expect(measured).toEqual(AUDIT_CENSUS_TOTALS.bySink);
  });

  it("has exactly the reviewed set of UNCATEGORISED writers, and no others", () => {
    /*
      The gate, and as of #2581's second child the pinned set is EMPTY: all 82
      writers child 1 found have been classified at the source.

      That makes this assertion stricter than it was, not weaker. A set-equality
      pin against an empty manifest means the FIRST new uncategorised writer
      fails CI by name — there is no backlog left for it to hide in, and nobody
      can re-open one by adding an entry here instead of a category at the site.
    */
    expect(
      ids(census().uncategorised),
      "An audit write site records no category. A row with no category is " +
        "returned by NO Diagnostics correlation tool, and it is kept forever: " +
        "every branch of pruneExpiredAuditLogs' predicate carries " +
        "`expiresAt: { lt: now }`, and NULL is not less than anything. Pass a " +
        "canonical category from @/lib/audit-categories at the site. " +
        "The #2581 backlog is CLOSED — do not add an entry to " +
        "UNCATEGORISED_AUDIT_WRITERS to silence this; an addition there is a " +
        "regression under review. " +
        "If you are seeing this from TypeScript at all, something is wrong: " +
        "AuditLogParams.category and StructuredAuditEvent.category are both " +
        "required, so an omitting TypeScript writer does not compile. Reaching " +
        "here means the writer is raw migration SQL or a .mjs script (neither of " +
        "which the compiler sees), or the type mandate has been reverted.",
    ).toEqual(Object.keys(UNCATEGORISED_AUDIT_WRITERS).sort());
  });

  it("discovers and pins every runtime or document current-census claim", () => {
    /*
      Current totals occur in operator docs, model-facing runtime scope, and a
      runtime source contract. The old hand-maintained four-document list missed
      the second booking-guide occurrence and both runtime occurrences. Discover
      the reviewed wording instead, pin the occurrence inventory, and compare every
      value with the manifest.

      Changing a number, deleting/rewording a claim so it escapes the parser, or
      adding a new current-fact copy all fail visibly. Historical statements such
      as "82 were still uncategorised when #2581 opened" deliberately do not match:
      they remain true and are not current-fact copies.

      "EVERY" IS NOW TRUE, AND WAS NOT WHEN THIS TEST WAS NAMED. #2679's review
      counted twelve current-fact copies against five patterns that matched eight —
      and because the inventory below pins exactly what the patterns FIND, the four
      unmatched copies were invisible to the assertion as well as to the discovery.
      Three more wordings close them; the count is asserted by kind below so a future
      regex change cannot quietly retire a shape, and the pasted distribution on the
      category-review page has its own test because a between-category move leaves
      every total untouched.
    */
    const totals = AUDIT_CENSUS_TOTALS;
    const claims = currentAuditCensusClaims();
    expect(
      claims.map((claim) => claim.file),
      "The inventory of runtime/docs current audit-census claims changed. Keep " +
        "the wording recognisable, and review every new or removed copy here.",
    ).toEqual([
      // The fenced `audit:census` paste. It was unmatched by the five original
      // patterns, and an unmatched copy was invisible to this inventory as well —
      // which is how 8/12 could look like "every". The "site total is unchanged
      // at N" sentence that used to sit beside it became a historical statement
      // when #2760's new payment writer made it untrue (the paste block above it
      // carries the current figure), so it is deliberately unmatched now.
      "docs/ai-diagnostics/audit-admin-category-review.md",
      "docs/ai-diagnostics/tool-pack-booking-membership.md",
      "docs/ai-diagnostics/tool-pack-booking-membership.md",
      "docs/ai-diagnostics/tool-pack-finance.md",
      "docs/ai-diagnostics/tool-pack-support.md",
      // "every one of the N sites in the tree".
      "docs/ai-diagnostics/tool-pack-support.md",
      "docs/guides/audit-log.md",
      // "every one of the N places does it".
      "docs/guides/audit-log.md",
      "src/lib/diagnostics/tools/packs/booking-records.ts",
      "src/lib/diagnostics/tools/packs/finance-records.ts",
      "src/lib/diagnostics/tools/packs/support-correlation.ts",
    ]);
    expect(
      claims,
      "A runtime or document current-fact copy is stale. Re-run `npm run " +
        "audit:census`, then update every discovered claim in the same commit.",
    ).toEqual(
      claims.map(({ file, uncategorised }) => ({
        file,
        writeSites: totals.writeSites,
        // A total-only claim asserts the site count and nothing else; see
        // `CurrentCensusClaim`. It is still pinned on the number that drifts.
        uncategorised: uncategorised === null ? null : totals.uncategorised,
      })),
    );
    // Non-vacuous in both directions: the eleven claims must include at least one
    // of each kind, or a future regex change could quietly retire a whole shape.
    // (Twelve became eleven when #2760's new writer made the "site total is
    // unchanged at N" sentence historical; the paste block still pins that page.)
    expect(claims.filter((claim) => claim.uncategorised === null).length).toBe(2);
    expect(claims.filter((claim) => claim.uncategorised !== null).length).toBe(9);
  });

  it("pins the pasted census DISTRIBUTION, not only its total", () => {
    /*
      The fenced `npm run audit:census` output on the category-review page states
      the eleven per-category counts as well as the total, and nothing read either.
      A pass that moves a writer between two categories leaves the total untouched —
      #2755 did exactly that — so a total-only pin would leave that block asserting
      a stale distribution indefinitely, on the page whose stated job is being the
      reviewed record of which category each writer records.

      Parsed out of the page rather than duplicated here: the manifest is the one
      declaration and this asserts the page agrees with it.
    */
    const page = readFileSync(
      resolve(process.cwd(), "docs", "ai-diagnostics", "audit-admin-category-review.md"),
      "utf8",
    );
    const block = page.match(/category values:([\s\S]*?)```/);
    expect(block, "the category-review page has no pasted census distribution").not
      .toBeNull();
    const pasted = Object.fromEntries(
      (block?.[1] ?? "")
        .replace(/\s+/g, " ")
        .split(",")
        .map((pair) => pair.trim())
        .filter((pair) => pair.length > 0)
        .map((pair) => {
          const parts = pair.split(" ");
          return [parts[0], Number(parts[1])] as const;
        }),
    );
    expect(
      pasted,
      "The pasted census distribution on docs/ai-diagnostics/audit-admin-category-review.md " +
        "disagrees with AUDIT_CENSUS_TOTALS.categoryValues. Re-run `npm run audit:census` " +
        "and paste the new block.",
    ).toEqual(AUDIT_CENSUS_TOTALS.categoryValues);
  });

  it("keeps every classification #2581 applied exactly where it was reviewed", () => {
    /*
      The SWAP gate, and the reason this exists on top of `categoryValues`.

      A distribution pin catches a category gaining or losing sites. It does not
      catch a swap: move one writer from `booking` to `payment` and another the
      other way, and every count is identical while BOTH rows changed who can
      read them — `booking` needs `bookings:view`, `payment` needs
      `finance:view`. This pins the per-site answer, so any single
      reclassification among the 83 sites child 2 touched is a named diff.
    */
    const measured = Object.fromEntries(
      census()
        .sites.filter((site) => site.id in APPLIED_AUDIT_CATEGORIES)
        .map((site) => [site.id, describeCategory(site.category)]),
    );

    expect(
      measured,
      "A writer classified by #2581 now records a different category, or has " +
        "moved and taken its identity with it. Category decides which admin " +
        "areas a Diagnostics reader must hold AND whether a member sees the row " +
        "in their own timeline, so this is a readership change: update " +
        "APPLIED_AUDIT_CATEGORIES and say what moved in the changelog.",
    ).toEqual(APPLIED_AUDIT_CATEGORIES);
  });

  it("keeps every RE-classification #2730 applied exactly where it was reviewed", () => {
    /*
      The same swap gate, for the other reviewed population.

      #2581 child 2 classified the 83 sites that recorded NO category and pinned
      them above. It explicitly did not read the 118 that already said `admin`,
      and #2730 was the pass that did: 22 of them were moved to `lodge` and 96
      were kept. Those 22 need the identical protection and did not have it —
      the distribution pin alone cannot see a compensating pair (one of these
      back to `admin`, one `admin` site into `lodge` leaves `admin: 96` and
      `lodge: 52` untouched while both rows change who may read them).

      MEASURED FROM THE TREE, not read back out of the manifest, so this bites
      when somebody edits a ROUTE rather than only when they edit the table.
    */
    const measured = Object.fromEntries(
      census()
        .sites.filter((site) => site.id in REVIEWED_ADMIN_CATEGORIES_2730)
        .map((site) => [site.id, describeCategory(site.category)]),
    );

    expect(
      measured,
      "A writer #2730 reviewed now records a different category, or has moved " +
        "and taken its identity with it. These are the bed-allocation and " +
        "lodge-display sites that were split across two permission gates until " +
        "#2730 read them: reverting one re-opens the split silently, because " +
        "the category distribution can stay identical while it happens. Update " +
        "REVIEWED_ADMIN_CATEGORIES_2730 and say what moved in the changelog.",
    ).toEqual(REVIEWED_ADMIN_CATEGORIES_2730);

    // The property that made the move safe, asserted rather than asserted-in-prose:
    // every destination is a category a member CANNOT see in their own timeline,
    // so none of the 22 crossed the member self-timeline boundary. If a future
    // edit sends one of them somewhere member-visible, this fails with the
    // direction named even if the id-to-category map above was updated to match.
    const memberVisible = new Set<string>(
      MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS.map((option) => option.value),
    );
    expect(
      Object.values(REVIEWED_ADMIN_CATEGORIES_2730).filter((category) =>
        memberVisible.has(category),
      ),
      "A site #2730 moved now lands in a MEMBER-VISIBLE category. #2730 took " +
        "only the narrowings and left every widening to the owner, so this is " +
        "a decision, not a reclassification: the row would appear on the acting " +
        "administrator's own activity page and, where a subject member is set, " +
        "on theirs.",
    ).toEqual([]);
    expect([...new Set(Object.values(REVIEWED_ADMIN_CATEGORIES_2730))]).toEqual([
      "lodge",
    ]);
    expect(Object.keys(REVIEWED_ADMIN_CATEGORIES_2730)).toHaveLength(22);
  });

  it("keeps every member-record admin writer on ONE category, and not a member-visible one", () => {
    /*
      The anti-drift gate for #2755, and the reason it is a THIRD map rather than
      more rows in the two above.

      Until #2755 the same business act — an officer editing somebody else's
      member record — was filed three ways according to which screen the officer
      opened: `admin` from the member detail page, `account` from the bulk
      screen's deactivate/reactivate branch, `security` from its set-role branch.
      Nothing tied the three sites together, so each was reviewed against its own
      neighbours and never against the others. Two of them sit in
      `APPLIED_AUDIT_CATEGORIES` and the third (`admin-member-detail-service.ts`)
      carried no per-site pin at all, so every existing gate passed while they
      disagreed.

      MEASURED FROM THE TREE, so this bites when somebody edits a ROUTE and not
      only when they edit the table.
    */
    const measured = Object.fromEntries(
      census()
        .sites.filter((site) => site.id in MEMBER_RECORD_ADMIN_CATEGORIES_2755)
        .map((site) => [site.id, describeCategory(site.category)]),
    );

    expect(
      measured,
      "A member-record admin writer records a different category, or has moved " +
        "and taken its identity with it. These three sites are the SAME business " +
        "act reached from two screens; #2755 unified them because filing one act " +
        "three ways means a category-scoped reader sees a third of the picture " +
        "and cannot tell. Update MEMBER_RECORD_ADMIN_CATEGORIES_2755 and say what " +
        "moved in the changelog.",
    ).toEqual(MEMBER_RECORD_ADMIN_CATEGORIES_2755);

    // Agreement alone is not the property that matters — "all three agree" is
    // equally true of the wrong answer. All three of these rows REACH the subject
    // member's own timeline, so a member-visible destination publishes an
    // officer's edit of a member's record to that member, and audit rows are
    // append-only. Note HOW they reach it, because it is not uniform and the
    // difference misleads: the detail writer passes `subjectMemberId`, while both
    // bulk writers pass no subject at all and arrive through
    // `buildMemberAuditLogWhere`'s null-subject `targetId` leg (pinned in
    // `audit.test.ts`). "Passes a subject" is not the boundary test.
    const memberVisible = new Set<string>(
      MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS.map((option) => option.value),
    );
    expect(
      Object.values(MEMBER_RECORD_ADMIN_CATEGORIES_2755).filter((category) =>
        memberVisible.has(category),
      ),
      "A member-record admin writer now files a MEMBER-VISIBLE category. All " +
        "three of these rows reach the subject member's own timeline, so this " +
        "publishes an administrator's edits of a member's record to that member. " +
        "Whether a member sees a given event is meant to become a separate " +
        "explicit declaration at the writing site, denied by default — #2695 " +
        "decided that and it is NOT BUILT YET, so today the category is the only " +
        "lever, and this is not reversible afterwards.",
    ).toEqual([]);

    // One category, stated as a set, so unifying all three onto the WRONG value
    // fails here rather than passing as "they agree now".
    expect([
      ...new Set(Object.values(MEMBER_RECORD_ADMIN_CATEGORIES_2755)),
    ]).toEqual(["admin"]);
    expect(Object.keys(MEMBER_RECORD_ADMIN_CATEGORIES_2755)).toHaveLength(3);
  });

  it("lets no OTHER writer file a member-record action under a different category", () => {
    /*
      The failure the site map above cannot see: a FOURTH screen for the same act.

      A quick edit on the members list, or an importer that reactivates, written
      with a literal `admin.member.deactivated` and `category: "account"` because
      its author read only its own neighbours — that is exactly how the three
      pinned sites diverged in the first place. So the action NAMES are pinned too,
      and any site outside the map that writes one of them is reported.

      Neither pinned site writes a literal action (one returns from a helper, one
      interpolates over a zod enum), so they cannot match this scan themselves —
      which is why the enum is re-derived from the route's own source below rather
      than trusted from the list.

      THE HOLE THIS USED TO HAVE, measured rather than reasoned (review of #2755).
      The census resolves a non-literal action to `(dynamic) <expression>`, so a
      writer whose action came from a constant escaped a gate that compared action
      strings: a new file with `const A = "admin.member.deactivated"` and
      `category: "account"` passed this test outright, leaving only the census
      distribution counts to object — and their message invites bumping `account`
      by one. Two additions close it. `resolveActionLiteral` resolves ONE level of
      same-file `const` indirection, and the corpus gate below fails when any
      non-test file in the census's own scan NAMES one of these literals, which
      catches a writer that assembles the string from an imported constant too.
    */
    const pinned = new Set(MEMBER_RECORD_ADMIN_ACTIONS_2755);

    /*
      One level of same-file `const` indirection, and no more.

      Deliberately not a general evaluator: it reads the site's own file for
      `const NAME = "literal"`, which is the house style for an action constant at
      every dynamic-action site in the census (`XERO_MEMBER_IMPORT_*_ACTION`,
      `SEASONAL_MEMBERSHIP_*_ACTION`, `TOKEN_EMAIL_RECOVERY_ACTION`). Anything it
      cannot resolve is left as the census reported it and is caught by the corpus
      gate below instead, so an unresolvable expression fails loudly somewhere
      rather than passing quietly here.
    */
    const sourceCache = new Map<string, string>();
    const readSource = (file: string): string => {
      const cached = sourceCache.get(file);
      if (cached !== undefined) return cached;
      const text = readFileSync(join(process.cwd(), file), "utf8");
      sourceCache.set(file, text);
      return text;
    };
    const resolveActionLiteral = (site: AuditWriteSite): string => {
      const identifier = /^\(dynamic\) ([A-Za-z_$][\w$]*)$/.exec(site.action);
      if (!identifier) return site.action;
      const declared = new RegExp(
        String.raw`\b(?:const|let|var)\s+` +
          identifier[1] +
          String.raw`\s*(?::[^=\n]+)?=\s*"([^"]+)"`,
      ).exec(readSource(site.file));
      return declared?.[1] ?? site.action;
    };

    const offenders = census()
      .sites.filter(
        (site) =>
          pinned.has(resolveActionLiteral(site)) &&
          !(site.id in MEMBER_RECORD_ADMIN_CATEGORIES_2755) &&
          describeCategory(site.category) !== "admin",
      )
      .map(
        (site) =>
          `${site.id} → ${resolveActionLiteral(site)} → ${describeCategory(site.category)}`,
      );

    expect(
      offenders,
      "A writer outside the pinned member-record set records one of their action " +
        "names under a different category. One business act filed two ways is the " +
        "defect #2755 closed: category follows the business domain affected, not " +
        "the screen the officer used. File it `admin` like its siblings, or add " +
        "the site to MEMBER_RECORD_ADMIN_CATEGORIES_2755 with the reason it is a " +
        "different domain — as `/api/profile` is, because there the actor is the " +
        "subject.",
    ).toEqual([]);

    // The corpus gate: which FILES name these literals at all. Keyed on the
    // census's own scan list, so this gate and the census cannot disagree about
    // what the tree is. It fires on a mention rather than on a write, which is the
    // point — a mention is cheap to review, and a new writer cannot avoid one.
    const literalFiles = census()
      .files.filter((file) =>
        MEMBER_RECORD_ADMIN_ACTIONS_2755.some((action) =>
          readSource(file).includes(action),
        ),
      )
      .sort();
    expect(
      literalFiles,
      "A file that is not on the reviewed list names one of the six member-record " +
        "action literals. If it writes audit rows it must file `admin` " +
        "(`INV-PRIV-012`) — a fourth screen for this act does not get its own " +
        "answer. If it only mentions the name, add it to " +
        "MEMBER_RECORD_ACTION_LITERAL_FILES_2755.",
    ).toEqual([...MEMBER_RECORD_ACTION_LITERAL_FILES_2755].sort());

    // And the bulk half of the action family is re-derived from the route's own
    // zod enum, so a fourth bulk action cannot mint an unpinned member-record
    // action name. The enum is the route's whole bound on `action`, and the audit
    // call interpolates it as `member.bulk-${action}`.
    const bulkRoute = readFileSync(
      join(process.cwd(), "src/app/api/admin/members/bulk-update/route.ts"),
      "utf8",
    );
    const enumMatch = /action:\s*z\.enum\(\[([^\]]*)\]\)/.exec(bulkRoute);
    expect(
      enumMatch,
      "The bulk-update route no longer bounds `action` with an inline z.enum, so " +
        "this test can no longer derive which `member.bulk-*` audit actions exist. " +
        "Re-establish the bound before relying on MEMBER_RECORD_ADMIN_ACTIONS_2755.",
    ).not.toBeNull();
    const bulkActions = [...(enumMatch?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
      (match) => `member.bulk-${match[1]}`,
    );
    expect(bulkActions.length).toBeGreaterThan(0);
    expect(
      bulkActions.filter((action) => !pinned.has(action)),
      "The bulk-update route can write a `member.bulk-*` audit action that " +
        "MEMBER_RECORD_ADMIN_ACTIONS_2755 does not name. Add it there, and check " +
        "the writer files `admin` like its siblings.",
    ).toEqual([]);

    // The detail-page half likewise: every `admin.member.*` literal in that
    // service must be a pinned action, so adding a fourth outcome to
    // `getAdminMemberAuditAction` is a named diff rather than a silent one.
    const detailService = readFileSync(
      join(process.cwd(), "src/lib/admin-member-detail-service.ts"),
      "utf8",
    );
    const detailActions = [
      ...new Set(
        [...detailService.matchAll(/"(admin\.member\.[a-z0-9_.-]+)"/g)].map(
          (match) => match[1],
        ),
      ),
    ].sort();
    expect(detailActions.length).toBeGreaterThan(0);
    expect(
      detailActions.filter((action) => !pinned.has(action)),
      "The member detail service can write an `admin.member.*` audit action that " +
        "MEMBER_RECORD_ADMIN_ACTIONS_2755 does not name. Add it there, and check " +
        "it files `admin` like its siblings.",
    ).toEqual([]);
  });

  it("names every MEMBER-VISIBLE writer on the officer member-record surfaces, and keeps the named exceptions visible", () => {
    /*
      The gate keyed on WHERE a writer lives rather than on what it is called
      (#2755 review), and it exists because the two gates above are both keyed on
      the six action names. A fourth screen that invents a new name for the same act
      — `admin.member.archived` on a quick-action route — satisfies both while
      publishing an officer's edit of a member's record to that member. Today the
      only assertion that would notice is the `account` distribution count, whose
      message reads "a reclassification is visible" and invites bumping the number.

      IT ALSO PINS THE OTHER DIRECTION, which is the half a category sweep gets
      wrong. `INV-PRIV-012` is scoped to the six member-record actions, NOT to
      "an officer acted": the member-photo pair and the cancellation-review writers
      record an officer acting on somebody else's record and stay member-visible on
      reviewed decisions (#2581 chose that for the photo on purpose). Measured here,
      so a lane citing the unification to "finish the job" and move them to `admin`
      fails with the withdrawal named instead of silently taking rows off members'
      timelines.
    */
    const memberVisible = new Set<string>(
      MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS.map((option) => option.value),
    );

    // (a) Exhaustive over the surfaces: every member-visible writer there is named.
    const unnamedOnSurface = census()
      .sites.filter(
        (site) =>
          MEMBER_RECORD_ADMIN_SURFACES_2755.some((surface) =>
            site.file.startsWith(surface),
          ) &&
          memberVisible.has(describeCategory(site.category)) &&
          !(site.id in OFFICER_DRIVEN_MEMBER_VISIBLE_WRITERS_2755),
      )
      .map((site) => `${site.id} → ${describeCategory(site.category)}`);
    expect(
      unnamedOnSurface,
      "A writer on an officer member-record surface files a MEMBER-VISIBLE " +
        "category and is not one of the reviewed exceptions. That publishes an " +
        "officer's action on a member's record to that member, and audit rows are " +
        "append-only. If it is member-record administration it files `admin` " +
        "(`INV-PRIV-012`). If it is genuinely a narrower domain that a member " +
        "should see, add it to OFFICER_DRIVEN_MEMBER_VISIBLE_WRITERS_2755 with the " +
        "reason — and say so in the changelog, because it is a readership change.",
    ).toEqual([]);

    // (b) The named exceptions still say what they are pinned to say. Measured from
    // the tree, so moving one to `admin` fails here rather than only moving a count.
    const measured = Object.fromEntries(
      census()
        .sites.filter(
          (site) => site.id in OFFICER_DRIVEN_MEMBER_VISIBLE_WRITERS_2755,
        )
        .map((site) => [site.id, describeCategory(site.category)]),
    );
    expect(
      measured,
      "A reviewed member-visible officer-driven writer changed category or moved. " +
        "If it moved to `admin` that WITHDRAWS a row from the subject member's own " +
        "timeline — the direction `INV-PRIV-012` does not authorise, because the " +
        "rule is scoped to the six member-record actions and these are its named " +
        "exceptions. That needs the owner's decision, not a sweep.",
    ).toEqual(OFFICER_DRIVEN_MEMBER_VISIBLE_WRITERS_2755);

    // And every pinned exception really is member-visible, so the map cannot be
    // quietly turned into a list of hidden writers while still passing (b).
    expect(
      Object.values(OFFICER_DRIVEN_MEMBER_VISIBLE_WRITERS_2755).filter(
        (category) => !memberVisible.has(category),
      ),
    ).toEqual([]);
  });

  it("changes no member-record row's retention by unifying the category", () => {
    /*
      The property that made #2755's move safe on the retention axis, asserted
      rather than asserted in prose.

      `classifyAuditRetention` reads category AND action: an access-shaped action
      under `security` or `admin` becomes `sensitive_access`, which expires at 24
      months instead of seven years. None of these six actions normalises to an
      access word, so all six are `critical` under the categories they left AND
      under `admin` — the move shortens no evidence the club may need for a
      membership dispute. `family-group.login-holder-swapped` is the site in the
      tree where this genuinely differed, which is why it is checked rather than
      assumed.
    */
    for (const action of MEMBER_RECORD_ADMIN_ACTIONS_2755) {
      for (const category of ["admin", "account", "security"] as const) {
        expect(
          classifyAuditRetention({ action, category }),
          `${action} under ${category} no longer classifies as critical`,
        ).toBe("critical");
      }
    }
  });

  it("pins which classified writers a MEMBER can now see about themselves", () => {
    /*
      The member-facing half of the same question, stated as a number rather than
      left to be inferred from the table above.

      The member self-timeline filters on category (`buildMemberVisibleAuditLogWhere`),
      so classifying a previously null-category writer INTO a member-visible
      category can publish it on a member-facing surface. Both halves are pinned,
      so moving a writer ACROSS the boundary in either direction fails here with
      the direction named.

      What made the visible half safe to publish, checked per family rather than
      assumed: every one of those rows is about the member who can now see it or
      about a club-wide rule they are subject to, the member projection returns no
      metadata, no request id, no IP and no drill-downs, and each row's `details`
      is either a JSON object (which the member projection suppresses entirely)
      or a sentence the member already knows.

      56 -> 54 AND 27 -> 29 (#2755), THE FIRST CROSSING IN THE WITHDRAWING
      DIRECTION and the reason `admin` now appears in the hidden set. Child 2's
      two `bulk-update/route.ts` branches moved to `admin` so that all three
      officer-driven member-record writers agree; `admin` is not member-visible,
      so the subject member stops seeing a bulk deactivation or role change of
      their own account on their own activity list. They already saw NOTHING when
      an officer did the same thing from the member detail page, so the outcome is
      uniform invisibility rather than visibility decided by which screen the
      officer opened. The visibility question itself is meant to become an explicit
      per-event declaration rather than a by-product of a label — #2695 decided
      that on 9 Aug 2026 and it is NOT BUILT YET, so between this release and that
      one these two events have no declaration path and are simply invisible to the
      member. Rows already written keep their stored category, so nothing is
      withdrawn from a member who has already seen it (#2763 holds that data
      question).

      54 -> 55 (#2760), AND IT IS THE PROXY MOVING RATHER THAN THE BOUNDARY. The
      new writer is `booking.payment.auto_refund_record_failed`, categorised
      `payment` — which IS in the member-visible set, so the count above has to
      move. What does not move is what any member can actually see: the count is
      taken over the sites listed in `APPLIED_AUDIT_CATEGORIES`, and #2760 pinned
      BOTH ordinals at `handleCancelledBookingAdditionalPaymentSucceeded` where
      only `#0` had been listed, so the +1 is the second ordinal being named, not
      a row being published. Neither site reaches a self-timeline: the member query
      is `buildMemberVisibleAuditLogWhere`, which requires the row to carry the
      member as `subjectMemberId`, `actorMemberId`, `memberId` or `targetId`
      (`buildMemberAuditLogWhere`), and both of these rows carry a BOOKING id in
      `targetId` and no member column at all — the same shape the
      `booking.payment.refunded_after_cancellation` row beside them has always
      had. The `payment` category is what gates the ADMIN read (`support` plus
      `finance`), which is the gate the finance operator who has to reconcile the
      lost row already holds.
    */
    // MEASURED from the tree, not read back out of the manifest, deliberately.
    // A pin that reads its own table only bites when somebody edits the table;
    // this one bites when somebody edits a ROUTE, which is where the crossing
    // actually happens.
    const memberVisible = new Set<string>(
      MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS.map((option) => option.value),
    );
    const classified = census()
      .sites.filter((site) => site.id in APPLIED_AUDIT_CATEGORIES)
      .map((site) => describeCategory(site.category));
    const visible = classified.filter((category) => memberVisible.has(category));
    const hidden = classified.filter((category) => !memberVisible.has(category));

    expect(
      visible.length,
      "A writer #2581 classified crossed the MEMBER SELF-TIMELINE boundary. " +
        "That publishes an event on a member-facing surface, or withdraws one " +
        "from it — never a side effect of a refactor. Say which way it moved and " +
        "why the row is safe for the member it is about.",
    ).toBe(55);
    expect([...new Set(hidden)].sort()).toEqual(["admin", "lodge", "xero"]);
    expect(hidden).toHaveLength(29);
  });

  it("names every classified writer that still carries NO entity identifier", () => {
    /*
      Child 1 measured that only 9 of the 82 passed an `entityType` or `entityId`,
      which is the "missing entity identifiers that prevent bounded correlation"
      case the owner named as in-scope. Child 2 added them at 67 of the 83.

      The remaining 16 are pinned by NAME rather than by a count, because the
      tempting wrong answer is available at every one of them: the acting
      administrator's member id is always in scope, and writing it as the entity
      would put a false reference into the club's audit trail that reads as
      correlation. Each entry records why the site genuinely has no record to
      name.
    */
    const missing = census()
      .sites.filter(
        (site) => site.id in APPLIED_AUDIT_CATEGORIES && !site.hasEntityIdentifier,
      )
      .map((site) => site.id)
      .sort();

    expect(
      missing,
      "A writer classified by #2581 carries no entityType or entityId, so a " +
        "categorised row from it still cannot be correlated to a record. Add " +
        "the identifier at the site, or — if the event genuinely affects a " +
        "collection rather than a row — record why in " +
        "AUDIT_WRITERS_WITHOUT_ENTITY_IDENTIFIER.",
    ).toEqual(Object.keys(AUDIT_WRITERS_WITHOUT_ENTITY_IDENTIFIER).sort());
  });

  it("pins the uncategorised count the issue and the docs quote", () => {
    // The same number reaches three prose surfaces — this issue, the Diagnostics
    // docblock and docs/ai-diagnostics/tool-pack-support.md — and all three have
    // already carried a stale one (81 of ~350). Pinning it here is what makes them
    // fixable in lockstep.
    expect(census().uncategorised.length).toBe(AUDIT_CENSUS_TOTALS.uncategorised);
    expect(Object.keys(UNCATEGORISED_AUDIT_WRITERS)).toHaveLength(
      AUDIT_CENSUS_TOTALS.uncategorised,
    );
  });

  it("writes only CANONICAL category values", () => {
    /*
      The invented-value gate. Before #2581 the writer type ended in
      `| (string & {})`, so `category: "membership"` (three nomination writers) and
      `category: "auth"` (the auth-bounce writer) both compiled and both produced
      rows that no Admin filter and no correlation tool could select. The closed
      type is the primary defence; this is the one that still works if someone
      widens the type again, or writes the value through a cast.
    */
    const offenders = census()
      .sites.filter(
        (site) => site.category.kind === "literal" && !isAuditCategory(site.category.value),
      )
      .map((site) => `${site.id} → ${describeCategory(site.category)}`);

    expect(
      offenders,
      "An audit writer passes a category that is not in AUDIT_CATEGORIES. Rows " +
        "written with an unknown value are selectable by no reader. Either use a " +
        "canonical value, or add the new one to audit-categories.ts — which also " +
        "requires giving it a badge colour and a correlation domain.",
    ).toEqual([]);
  });

  it("pins how many sites write each category, so a reclassification is visible", () => {
    expect(
      census().categoryCounts,
      "The distribution of audit categories across production writers changed. " +
        "That is a change to WHO CAN READ WHAT — `admin`, `security` and `system` " +
        "are readable with support:view alone, while `family`, `account`, " +
        "`communication` and `privacy` need membership:view as well. Update " +
        "AUDIT_CENSUS_TOTALS.categoryValues and say so in the changelog.",
    ).toEqual(AUDIT_CENSUS_TOTALS.categoryValues);
  });

  it("chooses no category by WHO ACTED", () => {
    /*
      The owner's binding rule on #2581: category follows the affected business
      DOMAIN, never the actor. The member-photo writers used to read
      `category: actor.onBehalf ? "admin" : "account"` — the same action on the same
      record filed in two different categories, hence read by two different
      permission sets, depending on whether an administrator did it for the member.

      A conditional between literals is not always wrong in principle, but there is
      no legitimate one today, so the honest pin is zero: a new one has to argue for
      itself in a diff rather than arrive as an idiom.
    */
    const offenders = census().conditional.map(
      (site) => `${site.id} → ${describeCategory(site.category)}`,
    );

    expect(
      offenders,
      "An audit writer picks its category with a conditional. Category follows the " +
        "affected business domain, not who acted, so the same action on the same " +
        "record must land in the same category however it was initiated.",
    ).toEqual([]);
  });

  it("lets no writer decide its category outside the call site, except by declaration", () => {
    // A wrapper that takes `category` as a parameter, or forwards a whole event
    // object, is the shape that can smuggle a missing or invented value past both
    // the closed type and the site-level scan. Exactly one exists, and it is safe
    // because the type it forwards has a REQUIRED closed category.
    expect(
      ids(census().forwarded),
      "An audit writer's category comes from outside the call site — a variable, a " +
        "shorthand property, an opaque spread, or a forwarded event object. Either " +
        "pass a literal, or add the site to APPROVED_FORWARDED_CATEGORY_SITES with " +
        "the reason its indirection cannot drop or invent a category.",
    ).toEqual(Object.keys(APPROVED_FORWARDED_CATEGORY_SITES).sort());
  });

  it("has exactly the approved non-row-producing AuditLog statements", () => {
    // `update`/`updateMany`/`delete`/`deleteMany` on `auditLog` cannot carry a
    // category, so they must not be counted as omissions — but they are hand-written
    // mutations of the platform's audit trail, so they must not be invisible either.
    // Today they are the three retention statements, and nothing else.
    expect(
      ids(census().nonProducingDml),
      "Production code mutates or deletes AuditLog rows outside the approved " +
        "retention seam. Rewriting or removing audit evidence needs a reviewed " +
        "reason recorded in APPROVED_NON_PRODUCING_AUDIT_DML.",
    ).toEqual(Object.keys(APPROVED_NON_PRODUCING_AUDIT_DML).sort());
  });

  it("keeps every declared audit wrapper writing, with the category it declared", () => {
    /*
      A wrapper is one syntactic site standing for many logical events, so the
      site-level pins above under-count it and a change inside it can go unseen. The
      fourteen wrappers are declared with the sink they reach and the category they
      pass; a wrapper that stops writing, changes sink, or changes category fails
      here.

      `recordAgeUpParentEmailHandoffAudit` is the one whose declared SINK moved in
      this change: it was a hand-built Prisma `create` that bypassed the boundary's
      sanitisation and retention derivation while putting a recipient email address
      in its metadata, and it now reaches `createStructuredAuditLog` like the rest.
      This assertion is what stops it drifting back — a hand-built create would
      report `auditLog.create` here and fail by name.
    */
    const measured = Object.fromEntries(
      census()
        .sites.filter((site) => site.id in AUDIT_WRITER_WRAPPERS)
        .map((site) => [
          site.id,
          { sink: site.sink, category: describeCategory(site.category) },
        ]),
    );

    expect(
      measured,
      "A declared audit wrapper stopped writing, changed its sink, or changed the " +
        "category it passes. Every caller of a wrapper inherits its answer, so this " +
        "is a change to many audit rows rather than to one call.",
    ).toEqual(AUDIT_WRITER_WRAPPERS);
  });

  it("keeps the census's own tooling out of the census", () => {
    // The scanner and the manifest name every sink in string form. If the walk ever
    // counted them the totals would drift with the tooling, which is the reason the
    // manifest lives under `scripts/audit/` rather than beside the writers.
    const selfReferences = census().sites.filter((site) =>
      site.file.startsWith("scripts/audit/"),
    );
    expect(selfReferences).toEqual([]);
  });

  it("finds no TypeScript audit write in scripts/ or prisma/", () => {
    // Both trees reach the same database without going through a route, so a seed or
    // an operator backfill could write audit rows with no request context and no
    // review. Neither does today; a first one should be a conversation.
    //
    // Scoped to TypeScript deliberately, because `prisma/` is NOT clean in SQL —
    // see the migration assertion below. An unqualified "nothing writes the table
    // outside src/" would have been false.
    const outsideSrc = [...census().sites, ...census().nonProducingDml].filter(
      (site) => !site.file.startsWith("src/"),
    );
    expect(ids(outsideSrc)).toEqual([]);
  });

  it("has exactly the approved raw-SQL AuditLog statements in migrations", () => {
    /*
      The form no TypeScript census can see, and the reason the assertion above is
      qualified. Two committed migrations write `"AuditLog"` in raw SQL: a
      door-code redaction (four UPDATEs) and an email-override cleanup (one INSERT).
      Both bypass `audit.ts` entirely — no metadata sanitisation, no retention
      derivation, no closed category type — so a third one needs the same review,
      and before this pin nothing would have shown it.

      The scan strips SQL comments first: the door-code migration's own header
      discusses `UPDATE "AuditLog"` as well as performing it, which is the same
      comment false positive that put a phantom uncategorised writer in this
      issue's title.
    */
    expect(census().sqlFilesScanned).toBeGreaterThan(250);

    expect(
      census().sqlStatements.map((statement) => statement.id).sort(),
      "A migration writes, rewrites or deletes AuditLog rows in raw SQL. That " +
        "bypasses the audit boundary's sanitisation, retention derivation and " +
        "category type, and it changes the club's own history, so it must be " +
        "declared in APPROVED_MIGRATION_AUDIT_SQL with its reason.",
    ).toEqual(Object.keys(APPROVED_MIGRATION_AUDIT_SQL).sort());

    // And a row-producing INSERT must name the column, or its rows are born
    // uncategorised in exactly the way the 82 TypeScript sites are.
    expect(
      census()
        .sqlStatements.filter(
          (statement) => statement.producesRow && !statement.namesCategory,
        )
        .map((statement) => statement.id),
      "A migration INSERTs AuditLog rows without naming \"category\" in its " +
        "column list. Those rows are returned by no correlation tool and, unless " +
        "the migration also sets expiresAt by hand, are kept forever.",
    ).toEqual([]);
  });
});

describe("canonical audit taxonomy (#2581)", () => {
  it("gives every category a label and a correlation domain", () => {
    // The `Record<AuditCategory, …>` types already force this at compile time. The
    // runtime assertion is for the reverse direction: a key left behind after a
    // category is REMOVED from the list, which the exhaustive Record does not catch.
    expect(Object.keys(AUDIT_CATEGORY_LABELS).sort()).toEqual(
      [...AUDIT_CATEGORIES].sort(),
    );
    expect(Object.keys(AUDIT_CATEGORY_CORRELATION_DOMAIN).sort()).toEqual(
      [...AUDIT_CATEGORIES].sort(),
    );
  });

  it("pins the ADMIN AREAS each category's evidence needs", () => {
    /*
      The readership pin, and the reason the taxonomy is a security artefact rather
      than a display concern. A category IS a permission decision: it decides which
      correlation entry can return the row, and therefore which admin areas an
      operator must hold before the platform will show them the event.

      Pinned as a literal table so a change to `AUDIT_CATEGORY_CORRELATION_DOMAIN`
      cannot pass review as a refactor. Three categories sit behind `support:view`
      ALONE — `admin`, `security` and `system` — so moving a category INTO that row
      is the widening to argue for, and moving one OUT of it takes evidence away
      from a support-only operator who can read it today.
    */
    const measured = Object.fromEntries(
      AUDIT_CATEGORIES.map((category) => [
        category,
        [...auditCategoryReaderAreas(category)].join(" + "),
      ]),
    );

    expect(measured).toEqual({
      account: "support + membership",
      booking: "support + bookings",
      payment: "support + finance",
      xero: "support + finance",
      family: "support + membership",
      admin: "support",
      security: "support",
      lodge: "support + lodge",
      // Moved out of the support-only set in #2581 (decision 7): these payloads
      // carry recipient email addresses.
      communication: "support + membership",
      privacy: "support + membership",
      system: "support",
    });
  });

  it("pins how many write sites sit behind the WEAKEST gate", () => {
    // The number the "do not widen" constraint is really about. `admin`, `security`
    // and `system` are readable with `support:view` alone, so the count of writers
    // in them is the size of the population a support-only operator can correlate.
    // It moves only when a classification decision moves it, and then deliberately.
    const supportOnly = census().sites.filter(
      (site) =>
        site.category.kind === "literal" &&
        isAuditCategory(site.category.value) &&
        auditCategoryReaderAreas(site.category.value).length === 1,
    );

    expect(
      supportOnly.length,
      "The number of audit write sites readable with support:view alone changed. " +
        "That is a widening or a narrowing of who can correlate audit evidence, " +
        "not a refactor — say which in the changelog and update this pin.",
    ).toBe(
      AUDIT_CENSUS_TOTALS.categoryValues.admin +
        AUDIT_CENSUS_TOTALS.categoryValues.security +
        AUDIT_CENSUS_TOTALS.categoryValues.system,
    );
  });

  it("pins the categories a MEMBER can see in their own timeline", () => {
    /*
      The other readership boundary, and the one a taxonomy change can cross by
      accident. `audit-categories.ts` says membership of the canonical taxonomy must
      never publish a category to members as a side effect — but RE-classifying an
      existing writer still can, because the member timeline filters on category
      too (`buildMemberVisibleAuditLogWhere`).

      #2581 crossed it four times, all of them a writer moving from a category
      members cannot see into one they can: the three membership-application
      writers (invented `membership` → `account`), the auth-bounce writer (invented
      `auth` → `security`), and the on-behalf branch of the two member-photo
      writers (`admin` → `account`). Each row is about the member seeing it, and
      the member projection returns no metadata, no request id, no IP and no
      drill-downs — but "who can read this" changed, so it is pinned rather than
      left to be noticed.
    */
    const memberVisible = MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS.map(
      (option) => option.value,
    );

    expect(
      memberVisible,
      "The categories a member can see in their own audit timeline changed. That " +
        "publishes (or withdraws) a whole class of events on a member-facing " +
        "surface, so it is a reviewed decision — never a consequence of adding a " +
        "category to the taxonomy.",
    ).toEqual([
      "all",
      "account",
      "booking",
      "payment",
      "family",
      "security",
      "communication",
      "privacy",
    ]);

    // And the four the platform keeps to administrators.
    expect(
      AUDIT_CATEGORIES.filter(
        (category) => !memberVisible.includes(category),
      ),
    ).toEqual(["admin", "lodge", "xero", "system"]);
  });

  it("rejects the values that used to reach the database through the open union", () => {
    expect(isAuditCategory("membership")).toBe(false);
    expect(isAuditCategory("auth")).toBe(false);
    // And a plausible misspelling, which the old `(string & {})` escape also took.
    expect(isAuditCategory("familly")).toBe(false);
    expect(isAuditCategory("")).toBe(false);
    expect(isAuditCategory(undefined)).toBe(false);
    expect(isAuditCategory("family")).toBe(true);
  });
});
