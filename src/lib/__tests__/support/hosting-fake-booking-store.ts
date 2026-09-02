import { AgeTier, type MemberGuestConsentStatus } from "@prisma/client";

/**
 * The shared in-memory Booking store the adult-member-hosting suites drive their
 * evaluators and fan-outs with (#3037-#3039, epic #2943).
 *
 * WHY A STORE THAT REALLY APPLIES `where`, rather than a `vi.fn` returning a
 * canned list. This whole family of rules is about which bookings ARE and ARE NOT
 * related — same owner, same #738 split pair, same Group Trip — so a double that
 * ignored the clauses would pass every "supplies no cover" test for entirely the
 * wrong reason. `matchesWhere` applies the real predicates and THROWS on an
 * operator it does not model, which is what makes such a test a fact about the
 * production query instead of a fact about the fake.
 *
 * WHY IT IS ONE MODULE AND NOT THREE COPIES (`INV-SSOT-001`). #3037 wrote it,
 * #3038 copied it, #3039 copied it again — and by the time the third copy landed
 * the copies had ALREADY diverged: `guestRow` took a member ID string in one and a
 * whole member row plus a consent status in another, and only one copy modelled the
 * `some` relation filter. Divergence here is not cosmetic. These are the doubles
 * that decide whether a coverage predicate is exercised at all, so a copy missing a
 * clause or a column answers "not related" for a booking the production query
 * relates, and the suite that was supposed to catch that goes green. The precedent
 * is `support/hosting-participant-fence-double.ts`, which the same argument put in
 * one place and which now has sixteen importers.
 *
 * WHAT STAYS IN EACH SUITE. The row BUILDERS and the predicate engine live here,
 * because those are the parts whose drift is silent. Each suite keeps its own
 * `makeStore`: one file records advisory-lock acquisitions and queue writes, another
 * records only the `where` clauses it was handed, and a third mutates the store
 * between two reads to model a concurrent commit. Those differences are what each
 * file is FOR. So is each file's policy default — see `policyRow`.
 */

/** A booking row as the fake store holds it: plain columns and plain relations. */
export type FakeBooking = Record<string, unknown>;

/**
 * The columns of one `AdultMemberHostingPolicy` row.
 *
 * THE COLUMN LIST IS SHARED; THE SCENARIO IS NOT. Every suite needs the same
 * fields — and a field missing from a fake policy row hands the resolver
 * `undefined`, which quietly widens or narrows the rule under test — so the shape
 * belongs in one place. The MODE and the SCOPES do not: an evaluator suite wants
 * `ADMIN_REVIEW_REQUIRED` so an uncovered night yields a violation to inspect
 * rather than a throw, while a fan-out suite wants `ENFORCED` because the questions
 * it asks (would a member be refused, is an incident owed) only exist at an
 * enforcing club. So the default here is the product's own built-in — review-only,
 * `SAME_BOOKING` and no wider scope — and a suite that wants anything else spreads
 * its own answer over it, visibly, in its own file.
 */
export function policyRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "policy-club",
    scopeKey: "club-wide",
    lodgeId: null,
    mode: "ADMIN_REVIEW_REQUIRED",
    capacityMode: "NO_HOLD",
    version: 7,
    hostScopeSameBooking: true,
    hostScopeSameBookingOwner: false,
    hostScopeSameGroupTrip: false,
    ...overrides,
  };
}

/** The `Member` fields `participantQualifiesAsHost` reads off a guest's member. */
export function memberRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "adult-1",
    ageTier: AgeTier.ADULT,
    active: true,
    cancelledAt: null,
    archivedAt: null,
    ...overrides,
  };
}

/**
 * A `BookingGuest` row with its nights and its optional linked member.
 *
 * The member is passed as a ROW rather than as an id, which is the reconciliation of
 * the two diverged copies. An id alone cannot express the cases the rule turns on —
 * an inactive, cancelled or archived member is still linked and still does NOT
 * qualify as a host — so a suite handed only an id could not write the test that
 * matters. Callers that only care that somebody is a qualifying adult pass
 * `memberRow({ id })`.
 */
export function guestRow(
  id: string,
  nights: string[],
  member: Record<string, unknown> | null = null,
  consentStatus: MemberGuestConsentStatus | null = null,
): Record<string, unknown> {
  return {
    id,
    firstName: id,
    lastName: "Person",
    memberId: (member?.id as string | undefined) ?? null,
    stayStart: new Date(`${nights[0]}T00:00:00.000Z`),
    stayEnd: new Date(`${nights[nights.length - 1]}T00:00:00.000Z`),
    consentStatus,
    nights: nights.map((night) => ({
      stayDate: new Date(`${night}T00:00:00.000Z`),
    })),
    member,
  };
}

/**
 * A booking row with every column and relation the coverage predicates read.
 *
 * `groupBookingAsOrganiser` and `groupBookingJoin` are the two authoritative Group
 * Trip relations; `parentBookingId` is present and deliberately unrelated to them,
 * so a test can set a `parentBookingId` link across two DIFFERENT trips and still
 * expect no cover — a store that omitted the column could not tell "the predicate
 * ignores this" from "the column was never there".
 */
export function booking(
  lodgeId: string,
  overrides: FakeBooking = {},
): FakeBooking {
  return {
    id: "b-main",
    memberId: "owner-1",
    parentBookingId: null,
    groupBookingAsOrganiser: null,
    groupBookingJoin: null,
    lodgeId,
    status: "CONFIRMED",
    deletedAt: null,
    checkIn: new Date("2026-08-03T00:00:00.000Z"),
    checkOut: new Date("2026-08-05T00:00:00.000Z"),
    adultMemberHostingReview: null,
    adultMemberHostingReviewStatus: null,
    guests: [],
    ...overrides,
  };
}

/** The organiser's booking in `trip`. */
export function organiserOf(
  lodgeId: string,
  trip: string,
  overrides: FakeBooking = {},
): FakeBooking {
  return booking(lodgeId, {
    id: `organiser-${trip}`,
    memberId: `organiser-member-${trip}`,
    groupBookingAsOrganiser: { id: trip },
    ...overrides,
  });
}

/** A joined booking in `trip`. */
export function joinerOf(
  lodgeId: string,
  trip: string,
  id: string,
  overrides: FakeBooking = {},
): FakeBooking {
  return booking(lodgeId, {
    id,
    memberId: `joiner-member-${id}`,
    groupBookingJoin: { groupBookingId: trip },
    ...overrides,
  });
}

/**
 * Apply a Prisma-shaped `where` to a plain row.
 *
 * Supports exactly the operators the hosting coverage predicates use, and THROWS on
 * anything else. Throwing rather than ignoring is the point: a clause this fake
 * silently skipped would make a "not related" test pass while the production query
 * related the two bookings.
 */
export function matchesWhere(
  row: FakeBooking,
  where: Record<string, unknown>,
): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "AND") {
      const clauses = condition as Array<Record<string, unknown>>;
      if (!clauses.every((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    if (key === "OR") {
      const clauses = condition as Array<Record<string, unknown>>;
      if (!clauses.some((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    const value = row[key];
    if (condition === null || typeof condition !== "object") {
      if (value !== condition) return false;
      continue;
    }
    const operators = condition as Record<string, unknown>;
    // A to-one relation filter: `groupBookingJoin: { is: { groupBookingId } }`. A
    // null relation matches nothing, which is the whole reason a booking in no Group
    // Trip supplies no Group Trip cover.
    if ("is" in operators) {
      const nested = operators.is as Record<string, unknown> | null;
      if (nested === null) {
        if (value != null) return false;
        continue;
      }
      if (value == null) return false;
      if (!matchesWhere(value as FakeBooking, nested)) return false;
      continue;
    }
    // A to-many relation filter: `guests: { some: { memberId } }`.
    if ("some" in operators) {
      const nested = operators.some as Record<string, unknown>;
      const list = (value ?? []) as FakeBooking[];
      if (!list.some((entry) => matchesWhere(entry, nested))) return false;
      continue;
    }
    for (const [operator, operand] of Object.entries(operators)) {
      switch (operator) {
        case "not":
          if (value === operand) return false;
          break;
        case "in":
          if (!(operand as unknown[]).includes(value)) return false;
          break;
        case "notIn":
          if ((operand as unknown[]).includes(value)) return false;
          break;
        case "lt":
          if (!((value as Date) < (operand as Date))) return false;
          break;
        case "gt":
          if (!((value as Date) > (operand as Date))) return false;
          break;
        case "gte":
          if (!((value as Date) >= (operand as Date))) return false;
          break;
        default:
          throw new Error(`fake store cannot apply operator ${operator}`);
      }
    }
  }
  return true;
}

/**
 * Return only the columns and relations a `select` asked for.
 *
 * NOT A DETAIL. The Group Trip relations reach the evaluator through
 * `BOOKING_HOSTING_SELECT`, and Prisma does not typecheck `select` keys through the
 * hand-written client interfaces the hosting paths use — so a select that quietly
 * stopped naming them would hand the resolver `undefined` and every booking would
 * read as belonging to no Group Trip, with a green typecheck. A store that returned
 * whole rows regardless of the select cannot see that at all: it answers with data
 * the production query never asked for.
 */
export function project(
  row: FakeBooking,
  select: Record<string, unknown> | undefined,
): FakeBooking {
  if (!select) return row;
  const out: FakeBooking = {};
  for (const key of Object.keys(select)) out[key] = row[key];
  return out;
}

/**
 * Sort matched rows by a Prisma `orderBy` list, then apply `take`.
 *
 * ORDERING IS LOAD-BEARING IN THESE SUITES rather than presentational: the Group
 * Trip fan-out plans a bounded set, re-reads it under the trip key and compares an
 * ORDER-SENSITIVE fingerprint, so a store that returned insertion order would make
 * the re-verify pass for the wrong reason at any trip above the ceiling.
 */
export function orderAndTake(
  rows: FakeBooking[],
  orderBy: unknown,
  take: unknown,
): FakeBooking[] {
  let matched = rows;
  const clauses = Array.isArray(orderBy)
    ? (orderBy as Array<Record<string, string>>)
    : orderBy && typeof orderBy === "object"
      ? [orderBy as Record<string, string>]
      : [];
  for (const clause of [...clauses].reverse()) {
    const [field, direction] = Object.entries(clause)[0] as [string, string];
    matched = [...matched].sort((left, right) => {
      const a = left[field] as never;
      const b = right[field] as never;
      const cmp = a < b ? -1 : a > b ? 1 : 0;
      return direction === "desc" ? -cmp : cmp;
    });
  }
  if (typeof take === "number") matched = matched.slice(0, take);
  return matched;
}
