import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Census: there is ONE night-occupancy calculation, and it counts every term
 * (#2681).
 *
 * "How many beds are occupied at this lodge on this night" was written SIX
 * separate times — four near-identical copies in `capacity.ts`, one in the
 * capacity-warnings cron, and one in the custodian bed-hold write path. The
 * cron copy had drifted three terms behind the others and the custodian copy
 * one. Each term was added by remembering to edit every copy, and for #2525
 * that did not happen.
 *
 * The root cause is not the miss; it is that the inventory of occupancy terms
 * and the inventory of occupancy surfaces both lived in reviewers' heads. This
 * file makes both mechanical, in the style of
 * `api-route-boundaries.test.ts`:
 *
 *  - every TERM must still be summed inside `computeNightOccupancy`, and each
 *    term is summed there exactly once;
 *  - every SURFACE that computes per-night bed occupancy must call it, and
 *    every caller holding a transaction client must pass it;
 *  - every file that reads the capacity-holding booking population, or counts
 *    active guests per night, is enumerated below with what it does, so a new
 *    one has to be classified rather than quietly becoming copy number seven.
 *
 * ## What this census does and does not guarantee
 *
 * It is a SOURCE-TEXT census over `src/`, so be honest about its reach. What it
 * guarantees is: no copy that reuses the shared occupancy helpers, the shared
 * capacity-holding population filter, or the shared per-night guest counter can
 * appear without being declared here. A copy that inlines its own
 * `status: { in: [...] }` filter, its own night loop and its own arithmetic —
 * naming none of those symbols — is invisible to it, as is anything under
 * `scripts/` or `prisma/`. That residue is smaller than the six-copy inventory
 * this replaces, and it is stated rather than implied.
 */

const CAPACITY_MODULE = "src/lib/capacity.ts";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/**
 * The occupancy terms, each with the source evidence that proves
 * `computeNightOccupancy` still sums it. Adding a term here without adding it
 * to `computeNightOccupancy` fails, and removing it from
 * `computeNightOccupancy` without removing it here fails.
 */
const OCCUPANCY_TERMS = [
  {
    id: "booked-guest-nights",
    issue: "#713 / #1254",
    what: "capacity-holding bookings, counted through each guest's EXPLICIT night set so a sparse stay is not counted on its gap nights",
    evidence: [
      "capacityHoldingBookingFilter()",
      "guests: { include: { nights: true } }",
      "getOccupiedBedsForNightFromIndex(night, occupancyIndex)",
    ],
  },
  {
    id: "custodian-bed-holds",
    issue: "#2286",
    what: "a bed held for a season by a hut-leader assignment, which has no booking and no guest row",
    evidence: ["buildLodgeCustodianNightCounter(", "custodianCount(night)"],
  },
  {
    id: "policy-exception-reservations",
    issue: "#2525",
    what: "beds provisionally reserved by a HELD booking-policy exception request",
    evidence: [
      "buildLodgePolicyExceptionReservationCounter(",
      "reservationCount(night)",
    ],
  },
  {
    id: "whole-lodge-holds",
    issue: "ADR-001 / #118",
    what: "a capacity-holding booking that holds the whole lodge exclusively",
    evidence: ["buildWholeLodgeHoldIndex(", "isNightWholeLodgeHeld(night, holdIndex)"],
  },
] as const;

/**
 * The symbols that implement an occupancy term. A file naming one of these is
 * either the module that defines it, or `capacity.ts`, or a seventh copy.
 * Matched on word boundaries so `getOccupiedBedsForNightFromIndex` does not
 * count as a mention of `getOccupiedBedsForNight`.
 */
const TERM_SYMBOLS = [
  "buildLodgeCustodianNightCounter",
  "buildLodgePolicyExceptionReservationCounter",
  "buildWholeLodgeHoldIndex",
  "isNightWholeLodgeHeld",
  "getOccupiedBedsForNightFromIndex",
  "getOccupiedBedsForNight",
] as const;

/** Modules that DEFINE an occupancy term (and so must name its symbols). */
const TERM_OWNERS: Record<string, string> = {
  [CAPACITY_MODULE]: "owns computeNightOccupancy and the booking/hold indices",
  "src/lib/custodian-occupancy.ts":
    "owns the custodian bed-hold term (#2286)",
  "src/lib/booking-exception-reservations.ts":
    "owns the policy-exception reservation term (#2525)",
};

/**
 * Surfaces that compute per-night bed occupancy. Every one of them must reach
 * it through `computeNightOccupancy`, and none of them may name a term symbol
 * itself — that is what "no sixth implementation" means mechanically.
 */
const OCCUPANCY_SURFACES: Array<{ file: string; why: string }> = [
  {
    file: "src/lib/cron-capacity-warnings.ts",
    why: "the nightly capacity-warning cron (this is the surface that had drifted three terms behind)",
  },
  {
    file: "src/lib/custodian-assignment.ts",
    why: "the custodian bed-hold write path's over-capacity warn-and-confirm",
  },
];

/**
 * Files that read the capacity-holding booking population for something OTHER
 * than a per-night bed count. Each entry is a decision, so a new reader has to
 * be classified here rather than silently becoming a seventh occupancy copy.
 */
const NON_OCCUPANCY_READERS: Array<{
  file: string;
  why: string;
  /** Term symbols this file is allowed to name, if any. */
  allowedTermSymbols?: string[];
}> = [
  {
    file: "src/lib/booking-status.ts",
    why: "defines capacityHoldingBookingFilter itself",
  },
  {
    file: "src/app/api/admin/reports/route.ts",
    why: "utilisation reporting: measures how much the lodge was BOOKED, so it deliberately counts the bookings term ONLY — no custodian, no reservation, no hold pin (docs/CAPACITY_MODEL.md; pinned by custodian-write-path-contract.test.ts)",
    allowedTermSymbols: ["getOccupiedBedsForNight"],
  },
  {
    file: "src/lib/exclusive-hold-occupancy.ts",
    why: "per-BED planner occupancy for a whole-lodge hold (#2317) — which bed-nights are taken, not how many beds are occupied. Names buildWholeLodgeHoldIndex in prose only, to record that it uses the same half-open night span",
    allowedTermSymbols: ["buildWholeLodgeHoldIndex"],
  },
  {
    file: "src/lib/admin-bookings-service.ts",
    why: "flags admin booking rows that overlap an exclusive hold; no bed count",
  },
  {
    file: "src/app/api/admin/bookings/[id]/exclusive-hold/route.ts",
    why: "re-checks capacity-holding status at write time when setting a hold; no bed count",
  },
  {
    file: "src/app/api/admin/bookings/[id]/capacity-hold/route.ts",
    why: "prose reference only, in the route's own explanation of what a hold does",
  },
  {
    file: "src/lib/booking-exception-requests.ts",
    why: "prose reference only, in the edit-policy explanation",
  },
  {
    file: "src/lib/booking-request.ts",
    why: "prose reference only, in the request-conversion explanation",
  },
  {
    file: "src/lib/diagnostics/tools/packs/booking-search.ts",
    why: "prose reference only (#2679): the lodge-nights arm's docblock names the half-open overlap convention it matches; the statement itself is deliberately lifecycle-independent discovery and counts no beds — effective occupancy belongs to booking_capacity_by_night",
  },
  {
    file: "src/lib/seasonal-membership-assignments.ts",
    why: "lists a member's own capacity-holding bookings for the season roll-over; no bed count",
  },
];

/**
 * Files that count ACTIVE GUESTS per night with `countActiveGuestsForNight`.
 *
 * These are not occupancy copies — none of them answers "how many beds are
 * taken at this lodge tonight" — but the helper is the one primitive from which
 * a hand-rolled seventh copy could be built without naming any symbol in
 * `TERM_SYMBOLS`, so a new user of it has to be classified here. That is not
 * hypothetical: `hut-leader-coverage.ts` already sums it ACROSS bookings for a
 * whole lodge, which is the closest shape in the tree to an occupancy copy.
 */
const PER_NIGHT_GUEST_COUNTERS: Array<{ file: string; why: string }> = [
  {
    file: "src/lib/booking-guest-stay-ranges.ts",
    why: "defines countActiveGuestsForNight itself",
  },
  {
    file: CAPACITY_MODULE,
    why: "counts the PROPOSAL being tested (checkCapacityForGuestRanges, checkCapacityForPartnerSharedAdmission) — existing occupancy comes from computeNightOccupancy",
  },
  {
    file: "src/app/api/admin/bookings/route.ts",
    why: "per-BOOKING peak party size for the admin calendar row label; no lodge-wide sum",
  },
  {
    file: "src/lib/finance-booking-metrics.ts",
    why: "per-BOOKING guest-nights for revenue attribution; no bed count",
  },
  {
    file: "src/lib/policies/booking-route-decisions.ts",
    why: "group-discount applicability for ONE booking's party (#1930)",
  },
  {
    file: "src/lib/policies/pricing.ts",
    why: "group-discount rate substitution for ONE booking's party (#1930)",
  },
  {
    file: "src/lib/hut-leader-coverage.ts",
    why: "lodge-wide guests-per-night for the hut-leader coverage report — a STAFFING figure, not a bed count, and it is not compared against capacity. It selects only stayStart/stayEnd, so a sparse stay falls back to the #713 envelope and its guest total reads slightly high on a gap night; recorded here as a known reporting imprecision rather than a capacity defect",
  },
  {
    file: "src/lib/booking-edit-guest-ranges.ts",
    why: "counts guests still holding a future night on ONE booking (futureActiveGuestCount, #2736) so an edit cannot leave that booking with future nights nobody occupies — a per-BOOKING population test, never summed across bookings and never compared against lodge capacity. It reaches this census by naming countActiveGuestsForNight in a comment rather than calling it: the comment explains that the nights it hands to the capacity check are the exact bed-nights a range occupies, which is the property that stops a sparse guest claiming a gap night. Declared rather than reworded, because the file genuinely does count guests per night and a future reader should find it here",
  },
];

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : listSourceFiles(entryPath);
    }
    if (!/\.tsx?$/.test(entry.name)) return [];
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) return [];
    return [path.relative(process.cwd(), entryPath).split(path.sep).join("/")];
  });
}

function mentions(source: string, symbol: string): boolean {
  // Test helper: `symbol` comes from the closed literal lists above, not input.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(`\\b${symbol}\\b`).test(source);
}

/**
 * Source with block and line comments removed.
 *
 * Every assertion in this file that asks "is this term still summed?" runs over
 * the stripped text. Otherwise a comment is enough to satisfy it: deleting
 * `+ reservationCount(night)` from the sum while leaving
 * `// reservationCount(night) is handled elsewhere now` would pass, which is
 * precisely the "documented but not enforced" failure this census exists to
 * stop. Stripping also frees the docblocks to name the helpers in prose without
 * moving any count.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** The body of `computeNightOccupancy`, up to the next top-level declaration. */
function computeNightOccupancySource(): string {
  const source = readRepoFile(CAPACITY_MODULE);
  const start = source.indexOf("export async function computeNightOccupancy(");
  expect(
    start,
    "computeNightOccupancy must exist in src/lib/capacity.ts",
  ).toBeGreaterThan(-1);
  const candidates = [
    source.indexOf("\nexport ", start + 1),
    source.indexOf("\n/**", start + 1),
  ].filter((index) => index > -1);
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;
  return withoutComments(source.slice(start, end));
}

describe("#2681 night-occupancy census: one calculation, every term", () => {
  it.each(OCCUPANCY_TERMS)(
    "computeNightOccupancy still sums the $id term ($issue)",
    (term) => {
      const body = computeNightOccupancySource();
      for (const evidence of term.evidence) {
        expect(
          body.includes(evidence),
          `computeNightOccupancy no longer shows evidence of the ${term.id} term (${term.issue}) — ${term.what}. Missing: ${evidence}`,
        ).toBe(true);
      }
    },
  );

  it("sums each term exactly once in capacity.ts, so the four engines cannot diverge again", () => {
    // Comments stripped, so a docblock is free to name any of these in prose
    // without moving a count — and cannot satisfy one either.
    const source = withoutComments(readRepoFile(CAPACITY_MODULE));
    const countOf = (needle: string) => source.split(needle).length - 1;

    // One call each. Before #2681 these read 4, 4 and 4: one per engine.
    expect(
      countOf("buildLodgeCustodianNightCounter("),
      "the custodian term (#2286) must be summed in exactly one place — computeNightOccupancy",
    ).toBe(1);
    expect(
      countOf("buildLodgePolicyExceptionReservationCounter("),
      "the policy-exception reservation term (#2525) must be summed in exactly one place — computeNightOccupancy",
    ).toBe(1);
    expect(
      countOf("getOccupiedBedsForNightFromIndex(night, occupancyIndex)"),
      "the booked-guest-nights term (#713) must be summed in exactly one place — computeNightOccupancy",
    ).toBe(1);

    // buildWholeLodgeHoldIndex has exactly two call sites: the shared
    // calculation, and getLodgeHeldNights, which reports WHICH nights are held
    // rather than how many beds are taken. Its own query is the hold-only
    // population, so it is not an occupancy sum.
    expect(
      countOf("buildWholeLodgeHoldIndex("),
      "buildWholeLodgeHoldIndex must have exactly its definition plus two call sites: computeNightOccupancy (the occupancy term) and getLodgeHeldNights (which nights are held, not how many beds are taken). A third call site is a new occupancy copy.",
    ).toBe(3); // 1 definition + 2 calls
  });

  it("keeps the four engines and the cron on the one calculation", () => {
    const capacity = readRepoFile(CAPACITY_MODULE);
    for (const engine of [
      "export async function checkCapacity(",
      "export async function checkCapacityForGuestRanges(",
      "export async function checkCapacityForPartnerSharedAdmission(",
      "export async function getMonthAvailability(",
    ]) {
      const start = capacity.indexOf(engine);
      expect(start, `${engine} must exist`).toBeGreaterThan(-1);
      const next = capacity.indexOf("\nexport ", start + 1);
      const body = capacity.slice(start, next === -1 ? undefined : next);
      expect(
        body.includes("await computeNightOccupancy({"),
        `${engine} must get its occupancy from computeNightOccupancy, not its own copy`,
      ).toBe(true);
    }

    for (const surface of OCCUPANCY_SURFACES) {
      const source = readRepoFile(surface.file);
      expect(
        source.includes("computeNightOccupancy({"),
        `${surface.file} (${surface.why}) must call computeNightOccupancy`,
      ).toBe(true);
    }
  });

  /**
   * `computeNightOccupancy`'s `db` is optional and falls back to `prisma`, so a
   * caller that HAS a transaction client and forgets to pass it reads outside
   * its own per-lodge capacity lock — silently, with no type error. That is the
   * single-token way to reintroduce the overbooking hazard #2681 was told not
   * to touch, so it is pinned here rather than left to review.
   *
   * The two surfaces absent from this list are absent on purpose:
   * `getMonthAvailability` and the capacity-warnings cron have no transaction
   * client and have never held a lock — both only display or warn.
   */
  const TRANSACTIONAL_CALLERS: Array<{ file: string; caller: string }> = [
    { file: CAPACITY_MODULE, caller: "export async function checkCapacity(" },
    {
      file: CAPACITY_MODULE,
      caller: "export async function checkCapacityForGuestRanges(",
    },
    {
      file: CAPACITY_MODULE,
      caller: "export async function checkCapacityForPartnerSharedAdmission(",
    },
    {
      file: "src/lib/custodian-assignment.ts",
      caller: "export async function validateCustodianBedHold(",
    },
  ];

  it.each(TRANSACTIONAL_CALLERS)(
    "keeps $caller reading occupancy on its own transaction client",
    ({ file, caller }) => {
      const source = readRepoFile(file);
      const start = source.indexOf(caller);
      expect(start, `${caller} must exist in ${file}`).toBeGreaterThan(-1);
      const callIndex = source.indexOf("await computeNightOccupancy({", start);
      expect(
        callIndex,
        `${caller} must get its occupancy from computeNightOccupancy`,
      ).toBeGreaterThan(-1);
      const callEnd = source.indexOf("});", callIndex);
      const call = source.slice(callIndex, callEnd);
      expect(
        /^\s*db,\s*$/m.test(call),
        `${caller} holds a transaction client, so it must pass \`db\` to computeNightOccupancy. Without it the occupancy read falls back to the bare \`prisma\` client and happens OUTSIDE that caller's per-lodge capacity lock.`,
      ).toBe(true);
    },
  );

  it("lets no surface outside the calculation name an occupancy term", () => {
    const allowedElsewhere = new Map<string, string[]>();
    for (const reader of NON_OCCUPANCY_READERS) {
      allowedElsewhere.set(reader.file, reader.allowedTermSymbols ?? []);
    }

    const offenders: string[] = [];
    for (const file of listSourceFiles(path.resolve(process.cwd(), "src"))) {
      if (file in TERM_OWNERS) continue;
      const source = readRepoFile(file);
      const allowed = allowedElsewhere.get(file) ?? [];
      for (const symbol of TERM_SYMBOLS) {
        if (!mentions(source, symbol)) continue;
        if (allowed.includes(symbol)) continue;
        offenders.push(`${file} names ${symbol}`);
      }
    }

    expect(
      offenders,
      "A new file is summing an occupancy term itself. Call computeNightOccupancy (src/lib/capacity.ts) instead, or — if it genuinely is not a per-night bed count — declare it in NON_OCCUPANCY_READERS in this file with the reason.",
    ).toEqual([]);
  });

  it("enumerates every reader of the capacity-holding booking population", () => {
    const declared = new Set<string>([
      ...Object.keys(TERM_OWNERS),
      ...OCCUPANCY_SURFACES.map((surface) => surface.file),
      ...NON_OCCUPANCY_READERS.map((reader) => reader.file),
    ]);

    const readers = listSourceFiles(path.resolve(process.cwd(), "src")).filter(
      (file) => mentions(readRepoFile(file), "capacityHoldingBookingFilter"),
    );

    const undeclared = readers.filter((file) => !declared.has(file));
    expect(
      undeclared,
      "A new file reads the capacity-holding booking population. If it counts beds per night it must call computeNightOccupancy and be listed in OCCUPANCY_SURFACES; otherwise list it in NON_OCCUPANCY_READERS with what it does instead.",
    ).toEqual([]);

    // And the inventory must not rot the other way: every declared entry has to
    // still exist, or the list is describing a tree that is no longer there.
    for (const file of declared) {
      expect(
        fs.existsSync(path.resolve(process.cwd(), file)),
        `${file} is declared in the occupancy census but no longer exists`,
      ).toBe(true);
    }
  });

  it("enumerates every per-night active-guest counter", () => {
    const declared = new Set(
      PER_NIGHT_GUEST_COUNTERS.map((counter) => counter.file),
    );

    const counters = listSourceFiles(path.resolve(process.cwd(), "src")).filter(
      (file) => mentions(readRepoFile(file), "countActiveGuestsForNight"),
    );

    expect(
      counters.filter((file) => !declared.has(file)),
      "A new file counts active guests per night. If it sums them across bookings and compares the result against lodge capacity, it is an occupancy calculation — call computeNightOccupancy instead. Otherwise declare it in PER_NIGHT_GUEST_COUNTERS with what it counts and why that is not a bed count.",
    ).toEqual([]);

    for (const counter of PER_NIGHT_GUEST_COUNTERS) {
      expect(
        counters.includes(counter.file),
        `${counter.file} is declared as a per-night guest counter but no longer uses countActiveGuestsForNight — drop the entry`,
      ).toBe(true);
    }
  });
});
