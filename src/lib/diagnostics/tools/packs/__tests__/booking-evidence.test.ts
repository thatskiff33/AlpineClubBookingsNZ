/**
 * AID-6B's three authoritative booking/membership calculations (#2376).
 *
 * `booking-evidence.ts` owns the only `server_owned` sources in the booking pack:
 * `readBookingBlockStateEvidence`, `readBookingCapacityEvidence` and
 * `readMemberEligibilityEvidence`. The other entries return stored rows and a
 * contract test is enough for them. These three COMPOSE — a lifecycle test, a
 * policy evaluator, the capacity engine, a person-night guard, an edit-window
 * classifier, an erasure predicate, a settlement rule and a lockout mode — so what
 * has to be proved is the composition: which inputs are read, which are
 * SUPPRESSED, which classification wins when several are true at once, and which
 * facts are deliberately withheld rather than guessed.
 *
 * ## THE PRISMA DOUBLE HONOURS `where`, AND THAT IS THE POINT OF IT
 *
 * AID-6C's consistency suite (`finance-authoritative-consistency.test.ts`) stubs
 * `prisma.*` with `mockResolvedValue`, so every read returns the same fixture rows
 * whatever `where` it was handed. That is survivable for a source whose reads are
 * all `findUnique({ where: { id } })`, and it is NOT survivable here: this module's
 * reads are FILTERS. `bookingGuest.findMany({ where: { bookingId } })`,
 * `bookingChangeRequest.findMany({ where: { bookingId, status: "REQUESTED" } })`,
 * `bedAllocation.findMany({ where: { bookingId, stayDate, bookingGuest } })` and — the sharpest one —
 * `member.count({ where: { id, passwordHash: DELETED_ACCOUNT_PASSWORD_HASH } })`
 * all mean something only because of their predicate. Under a `where`-blind mock a
 * predicate that selected the WRONG rows would return the right ones anyway, and
 * the entire suite would be blind to it. An erasure test that dropped `id` from
 * its `where` would report every ordinary member as ERASED, and a suite built on
 * `mockResolvedValue` would go green.
 *
 * So this file builds a small in-memory store — Booking, BookingGuest,
 * BookingGuestNight, BookingChangeRequest, PolicyExceptionReservationNight,
 * BedAllocation, Member, MemberSubscription, MemberInduction — and implements
 * `findUnique`, `findFirst`, `findMany` and `count` doubles that
 * actually APPLY the `where` they are given. Unsupported operators and unknown
 * field names THROW rather than being ignored, because a filter the double
 * silently drops is worse than no double at all.
 *
 * Every scenario also seeds a DECOY: a second booking with its own guests, its own
 * open change requests and its own bed allocations, and a second member who
 * carries both erasure markers, an unpaid subscription and an incomplete
 * induction. Nothing under test may ever see them. The decoy is permanent rather
 * than confined to one test so that dropping any `bookingId` or `memberId` filter
 * fails most of this file at once — mutation proofs for that are in the report.
 *
 * ## IT ALSO HONOURS `select`
 *
 * A named `select` returns ONLY the named fields. AID-6C's blocker #1 was a
 * projection reading a column its `select` did not name — which in a
 * `mockResolvedValue` world reads back fine and in production reads `undefined`.
 * Here it reads `undefined` in the test too. `select` is strict: an unknown field
 * name throws.
 *
 * `include` THROWS OUTRIGHT, and that is a control rather than a gap in the
 * double. Every read this module makes is a named `select`, because the module's
 * own header says those clauses are the ONLY boundary between it and
 * `Booking."notes"`, `Member."comments"` and the rest. The one read that was not —
 * `getInductionForMember`, whose `include` pulls the induction's `finalComments`,
 * every sign-off's `comments` and `signerName`, the template prompts and the
 * assigned signers' names into this process — was narrowed to
 * `getInductionStatusForMember` in #2679's security review. Making the double
 * refuse an `include` is what stops a later edit from quietly widening it back:
 * the wide call now fails this suite instead of passing it.
 *
 * ## WHAT IS MOCKED, AND WHY EXACTLY THAT LINE
 *
 * The AUTHORITIES this module delegates to run FOR REAL, because reusing them
 * instead of re-deriving their rules is the whole argument for these being
 * `server_owned` entries, and stubbing one would test a copy of the thing under
 * test: `isDeletedAccountRecord`, `getLifecycleStatusConfig`,
 * `bookingReviewReasonCodes`, `isCheckinBlockedByPendingReview`,
 * `getBookingEditPolicy`, `resolveMemberSubscriptionSettlement`,
 * `subscriptionIsUnpaid`, `participantQualifiesAsHost`, `formatBookingReference`
 * and every `date-only` helper.
 *
 * The INPUTS are stubbed, because each is a whole subsystem (the capacity engine
 * takes advisory-lock-adjacent reads across four tables; the policy evaluator
 * composes three more) and because several assertions here are about a call NOT
 * HAPPENING, which can only be observed on a spy: `checkCapacity`,
 * the persisted non-hosting and canonical hosting evaluators,
 * `findBookingMemberNightConflicts`,
 * `resolveMembershipTypePolicyForMember`, `getAgeTierSettings` and
 * `peekSubscriptionLockoutMode`. `getInductionForMember` is deliberately NOT
 * stubbed — it is a one-line `findFirst` and letting it run proves its
 * `where: { memberId }` against the decoy.
 *
 * ## THE CLOCK
 *
 * The repo-wide frozen clock (#2481) pins "now" at 2026-07-01T00:00:00Z, which is
 * midday 1 July 2026 in the club's zone, so NZ and UTC agree on the calendar day.
 * the club's season year is therefore 2026 and its calendar day 2026-07-01.
 * Every fixture date below is written relative to that and nothing here reads the
 * real calendar.
 *
 * THAT INSTANT IS ALSO WHY THIS SUITE COULD NOT SEE #2679's SEASON-YEAR BLOCKER,
 * and the fix is a fixture rather than a stricter assertion. 1 July is inside the
 * season under BOTH the correct rule and the wrong one — the calendar year and the
 * season year agree for nine months of every year — and every subscription fixture
 * here is seeded at `seasonYear: 2026`, so the year was never the discriminating
 * predicate and three assertions pinning the literal 2026 passed either way. The
 * season starts on the first of the month AFTER the club's financial year-end
 * (April by default, the NZ 31-March convention), so January, February and March
 * are the months where the two answers differ. The eligibility suite therefore
 * pins its OWN instant on both sides of that boundary with `vi.setSystemTime`,
 * which runs after the freeze is installed and so wins, and restores the frozen
 * instant afterwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import { DELETED_ACCOUNT_PASSWORD_HASH } from "@/lib/deleted-account";
import {
  DEFAULT_FINANCIAL_YEAR_END_MONTH,
  __setFinancialYearEndMonthForTesting,
} from "@/lib/financial-year";

// ---------------------------------------------------------------------------
// The doubles. Created in a hoisted block so the `vi.mock` factories below can
// close over them; their implementations are wired in `beforeEach`, which runs
// long after this module has finished evaluating.
// ---------------------------------------------------------------------------

const {
  prismaMock,
  txMock,
  checkCapacityMock,
  evaluatePersistedNonHostingViolationsMock,
  evaluatePersistedHostingMock,
  findBookingMemberNightConflictsMock,
  resolveMembershipTypePolicyForMemberMock,
  getAgeTierSettingsMock,
  peekSubscriptionLockoutModeMock,
} = vi.hoisted(() => {
  const prismaMock = {
    booking: { findUnique: vi.fn() },
    bookingGuest: { findMany: vi.fn() },
    bookingChangeRequest: { findMany: vi.fn() },
    bedAllocation: { findMany: vi.fn() },
    member: { findUnique: vi.fn(), count: vi.fn() },
    memberSubscription: { findUnique: vi.fn() },
    memberInduction: { findFirst: vi.fn() },
    membershipLockoutSettings: { findUnique: vi.fn() },
    // #2870: the club's persisted timezone, read THROUGH THE TRANSACTION so the
    // season the club is currently in stays inside the seam's READ ONLY fence,
    // snapshot and statement timeout. Present on both doubles because it is a
    // `tx` read; the first version of that code used the global client instead.
    clubTimeSettings: { findUnique: vi.fn() },
    xeroToken: { findFirst: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  /**
   * A DISTINCT OBJECT, THE SAME FUNCTIONS.
   *
   * `$transaction` used to hand the callback `prismaMock` itself, which made every
   * "the collaborator received the transaction client" assertion vacuous: the two
   * clients were one object, so `toBe(prismaMock)` passed whether the code passed
   * `tx` or reached for the global client. This is a shallow copy — a different
   * object identity, holding the SAME `vi.fn()` instances — so
   * `toBe(txMock)`/`not.toBe(prismaMock)` is now a real discrimination while every
   * `prismaMock.booking.findUnique` assertion in this file keeps working unchanged.
   *
   * Written out field by field rather than spread-minus-a-key, so that
   * `$transaction`'s ABSENCE is a line somebody chose: a `Prisma.TransactionClient`
   * has no such method, and a nested interactive transaction therefore throws here
   * instead of quietly opening a second pool connection.
   */
  const txMock = {
    booking: prismaMock.booking,
    bookingGuest: prismaMock.bookingGuest,
    bookingChangeRequest: prismaMock.bookingChangeRequest,
    bedAllocation: prismaMock.bedAllocation,
    member: prismaMock.member,
    memberSubscription: prismaMock.memberSubscription,
    memberInduction: prismaMock.memberInduction,
    membershipLockoutSettings: prismaMock.membershipLockoutSettings,
    clubTimeSettings: prismaMock.clubTimeSettings,
    xeroToken: prismaMock.xeroToken,
    $executeRaw: prismaMock.$executeRaw,
  };
  return {
    prismaMock,
    txMock,
    checkCapacityMock: vi.fn(),
    evaluatePersistedNonHostingViolationsMock: vi.fn(),
    evaluatePersistedHostingMock: vi.fn(),
    findBookingMemberNightConflictsMock: vi.fn(),
    resolveMembershipTypePolicyForMemberMock: vi.fn(),
    getAgeTierSettingsMock: vi.fn(),
    peekSubscriptionLockoutModeMock: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/capacity", () => ({ checkCapacity: checkCapacityMock }));
vi.mock("@/lib/booking-exception-request-service", () => ({
  evaluatePersistedBookingNonHostingPolicyViolations:
    evaluatePersistedNonHostingViolationsMock,
}));
vi.mock("@/lib/adult-member-hosting-review", () => ({
  evaluatePersistedBookingAdultMemberHostingReadOnly: evaluatePersistedHostingMock,
}));
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  findBookingMemberNightConflicts: findBookingMemberNightConflictsMock,
}));
vi.mock("@/lib/membership-type-policy", () => ({
  resolveMembershipTypePolicyForMember: resolveMembershipTypePolicyForMemberMock,
}));
// PARTIAL mocks: both modules are imported by real code left running here
// (`subscription-lockout-facts` reads `getAgeTierSettings`), so only the one
// export each is replaced and the rest of the module stays genuine.
//
// THE `Strict` VARIANTS ARE THE ONES REPLACED, because the strict variants are the
// ones this pack calls. Doubling the swallowing readers instead would have made
// every assertion below about a code path the pack no longer uses -- and would have
// hidden the whole point of the strict seams, which is that a failed read reaches
// the caller.
vi.mock("@/lib/age-tier", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/age-tier")>()),
  getAgeTierSettingsStrict: getAgeTierSettingsMock,
}));
vi.mock("@/lib/member-subscription-eligibility", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/member-subscription-eligibility")>()),
  peekSubscriptionLockoutModeStrict: peekSubscriptionLockoutModeMock,
}));

import {
  DIAGNOSTICS_READ_ONLY_STATEMENT_TIMEOUT_MS,
  DIAGNOSTICS_READ_ONLY_TRANSACTION_TIMEOUT_MS,
  resolveReadOnlyMaxWaitMs,
} from "../../read-only-transaction";
import { DIAGNOSTICS_TOOL_BOUNDS } from "../../types";
import {
  AID6B_BOOKING_GUEST_CEILING,
  AID6B_CAPACITY_NIGHT_CEILING,
  AID6B_EVIDENCE_DEADLINE_MS,
  AID6B_HOSTING_SAME_OWNER_SOURCE_CEILING,
  AID6B_HOSTING_SIBLING_CEILING,
  AID6B_OPEN_REQUEST_CEILING,
  BOOKING_BLOCKER_CODES,
  MEMBER_ELIGIBILITY_CODES,
  readBookingBlockStateEvidence,
  readBookingCapacityEvidence,
  readMemberEligibilityEvidence,
} from "../booking-evidence";

// ---------------------------------------------------------------------------
// The in-memory store.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface Store {
  booking: Row[];
  bookingRequest: Row[];
  bookingGuest: Row[];
  bookingGuestNight: Row[];
  bookingChangeRequest: Row[];
  policyExceptionReservationNight: Row[];
  bedAllocation: Row[];
  member: Row[];
  memberSubscription: Row[];
  memberInduction: Row[];
}

type ModelName = keyof Store;

interface ModelSpec {
  /**
   * Every column the double will answer for. A `select` naming anything else
   * throws: that is the AID-6C blocker-#1 guard, so a projection reading a field
   * the source did not select fails HERE rather than reading `undefined` in
   * production.
   */
  columns: readonly string[];
  relations?: Record<string, (row: Row, store: Store) => Row[] | Row | null>;
  counts?: Record<string, (row: Row, store: Store) => number>;
}

const MODELS: Record<ModelName, ModelSpec> = {
  booking: {
    columns: [
      "id",
      "memberId",
      "lodgeId",
      "status",
      "checkIn",
      "checkOut",
      "deletedAt",
      "requiresAdminReview",
      "adminReviewStatus",
      "adminReviewedAt",
      "adultMemberHostingReviewStatus",
      "adultMemberHostingReviewedAt",
      "waitlistPosition",
      "waitlistOfferExpiresAt",
      "wholeLodgeHold",
      "adminCapacityHoldAt",
      "capacityOverriddenAt",
      "parentBookingId",
      "draftExpiresAt",
      // The club's own subscription refusal reads this as a PREDICATE and projects
      // nothing from it: `confirm-draft` gates only a zero-price draft.
      "finalPriceCents",
      // Present on the model and NEVER selectable without this test noticing:
      // the pack doc names these as the columns that sit one `select` away.
      "notes",
      "adminReviewNotes",
      "deletedReason",
    ],
    relations: {
      originBookingRequest: (row) =>
        row.originBookingRequest && typeof row.originBookingRequest === "object"
          ? (row.originBookingRequest as Row)
          : null,
      // The OWNER, resolved through `memberId` exactly as the schema relation
      // does. The block-state select reaches it for one field — the live age tier
      // the club's subscription refusal reads — and the `member` model spec above
      // is what makes a select of any OTHER column throw here.
      member: (row, state) =>
        state.member.find((candidate) => candidate.id === row.memberId) ?? null,
    },
  },
  bookingRequest: {
    columns: ["id"],
  },
  bookingGuest: {
    columns: [
      "id",
      "bookingId",
      "firstName",
      "lastName",
      "ageTier",
      "isMember",
      "memberId",
      "stayStart",
      "stayEnd",
      "consentStatus",
    ],
    relations: {
      nights: (row, store) =>
        store.bookingGuestNight.filter(
          (night) => night.bookingGuestId === row.id,
        ),
    },
  },
  bookingGuestNight: {
    columns: ["id", "bookingGuestId", "stayDate"],
  },
  bedAllocation: {
    columns: ["id", "bookingId", "bookingGuestId", "stayDate"],
    relations: {
      bookingGuest: (row, state) =>
        state.bookingGuest.find((guest) => guest.id === row.bookingGuestId) ?? null,
    },
  },
  bookingChangeRequest: {
    columns: [
      "id",
      "bookingId",
      "requestedByMemberId",
      "status",
      "kind",
      "holdExpiresAt",
      "createdAt",
      "internalNotes",
    ],
    counts: {
      reservationNights: (row, store) =>
        store.policyExceptionReservationNight.filter(
          (night) => night.requestId === row.id,
        ).length,
    },
  },
  policyExceptionReservationNight: {
    columns: ["id", "requestId", "stayDate"],
  },
  member: {
    columns: [
      "id",
      "email",
      // A real column, deliberately declared so `member.count`'s predicate can
      // be applied against it — and so a `select` that named it would be
      // visible to the test that forbids exactly that.
      "passwordHash",
      "ageTier",
      "active",
      "canLogin",
      "cancelledAt",
      "archivedAt",
      "requiresInduction",
      "hutLeaderEligible",
      "joinedDate",
      "firstName",
      "lastName",
    ],
  },
  memberSubscription: {
    columns: [
      "memberId",
      "seasonYear",
      "status",
      "paidAt",
      "manuallyMarkedPaidAt",
    ],
  },
  memberInduction: {
    columns: ["id", "memberId", "status", "createdAt"],
  },
};

let store: Store;

function emptyStore(): Store {
  return {
    booking: [],
    bookingRequest: [],
    bookingGuest: [],
    bookingGuestNight: [],
    bookingChangeRequest: [],
    policyExceptionReservationNight: [],
    bedAllocation: [],
    member: [],
    memberSubscription: [],
    memberInduction: [],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

/**
 * Apply one scalar condition. Every operator the sources could reach is handled
 * explicitly and everything else THROWS — a double that ignored an operator it
 * did not recognise would quietly return unfiltered rows, which is the exact
 * failure this whole design exists to prevent.
 */
function matchScalar(actual: unknown, condition: unknown, where: string): boolean {
  if (condition === null) return actual === null || actual === undefined;
  if (condition instanceof Date) return comparable(actual) === condition.getTime();
  if (isPlainObject(condition)) {
    for (const [operator, operand] of Object.entries(condition)) {
      switch (operator) {
        case "equals":
          if (!matchScalar(actual, operand, where)) return false;
          break;
        case "not":
          if (matchScalar(actual, operand, where)) return false;
          break;
        case "in":
          if (!(operand as unknown[]).some((v) => matchScalar(actual, v, where)))
            return false;
          break;
        case "notIn":
          if ((operand as unknown[]).some((v) => matchScalar(actual, v, where)))
            return false;
          break;
        case "lt":
          if (!((comparable(actual) as number) < (comparable(operand) as number)))
            return false;
          break;
        case "lte":
          if (!((comparable(actual) as number) <= (comparable(operand) as number)))
            return false;
          break;
        case "gt":
          if (!((comparable(actual) as number) > (comparable(operand) as number)))
            return false;
          break;
        case "gte":
          if (!((comparable(actual) as number) >= (comparable(operand) as number)))
            return false;
          break;
        default:
          throw new Error(
            `booking-evidence test double: unsupported filter operator "${operator}" at ${where}. ` +
              "Teach the double the operator rather than letting it match everything.",
          );
      }
    }
    return true;
  }
  return actual === condition;
}

function matchesWhere(
  model: ModelName,
  row: Row,
  where: Row | undefined,
): boolean {
  if (!where) return true;
  const spec = MODELS[model];
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (key === "AND") {
      const clauses = Array.isArray(condition) ? condition : [condition];
      if (!clauses.every((clause) => matchesWhere(model, row, clause as Row)))
        return false;
      continue;
    }
    if (key === "OR") {
      const clauses = (condition as Row[]) ?? [];
      if (!clauses.some((clause) => matchesWhere(model, row, clause))) return false;
      continue;
    }
    if (key === "NOT") {
      const clauses = Array.isArray(condition) ? condition : [condition];
      if (clauses.some((clause) => matchesWhere(model, row, clause as Row)))
        return false;
      continue;
    }
    if (spec.columns.includes(key)) {
      if (!matchScalar(row[key], condition, `${model}.${key}`)) return false;
      continue;
    }
    const relation = spec.relations?.[key];
    if (relation) {
      const related = relation(row, store);
      const rows = Array.isArray(related) ? related : related ? [related] : [];
      const filter = condition as Record<string, Row>;
      const relatedModel = relationModel(model, key);
      // Only the relation predicates the sources could reach; anything else
      // throws below rather than silently passing.
      if (filter.is !== undefined) {
        if (
          rows.length !== 1 ||
          !matchesWhere(relatedModel, rows[0], filter.is)
        ) {
          return false;
        }
        continue;
      }
      if (filter.some !== undefined) {
        if (
          !rows.some((candidate) =>
            matchesWhere(relatedModel, candidate, filter.some),
          )
        )
          return false;
        continue;
      }
      if (filter.none !== undefined) {
        if (
          rows.some((candidate) =>
            matchesWhere(relatedModel, candidate, filter.none),
          )
        )
          return false;
        continue;
      }
      throw new Error(
        `booking-evidence test double: unsupported relation filter on ${model}.${key}`,
      );
    }
    // A compound unique key, e.g. `memberId_seasonYear: { memberId, seasonYear }`.
    if (
      isPlainObject(condition) &&
      Object.keys(condition).length > 0 &&
      Object.keys(condition).every((part) => spec.columns.includes(part))
    ) {
      if (!matchesWhere(model, row, condition)) return false;
      continue;
    }
    throw new Error(
      `booking-evidence test double: unknown filter field "${model}.${key}". ` +
        "Add it to the model spec — do not let an unrecognised predicate match every row.",
    );
  }
  return true;
}

function shapeRow(
  model: ModelName,
  row: Row,
  args: { select?: Row; include?: Row } | undefined,
): Row {
  const spec = MODELS[model];
  if (args?.select) {
    const out: Row = {};
    for (const [key, want] of Object.entries(args.select)) {
      if (want === false || want === undefined) continue;
      if (key === "_count") {
        const counts: Row = {};
        const requested = (want as { select?: Record<string, boolean> }).select ?? {};
        for (const [name, wanted] of Object.entries(requested)) {
          if (!wanted) continue;
          const counter = spec.counts?.[name];
          if (!counter) {
            throw new Error(
              `booking-evidence test double: ${model} has no countable relation "${name}"`,
            );
          }
          counts[name] = counter(row, store);
        }
        out._count = counts;
        continue;
      }
      if (spec.columns.includes(key)) {
        // ONLY the named fields. A projection reading a column this `select`
        // did not name gets `undefined` here, exactly as it would in Postgres.
        out[key] = row[key] === undefined ? null : row[key];
        continue;
      }
      const relation = spec.relations?.[key];
      if (relation) {
        const related = relation(row, store);
        const nested = want as QueryArgs;
        if (Array.isArray(related)) {
          const relatedRows = applyOrderBy(related, nested.orderBy);
          const limitedRows =
            nested.take === undefined
              ? relatedRows
              : relatedRows.slice(0, nested.take);
          out[key] = limitedRows.map((candidate) =>
            shapeRow(relationModel(model, key), candidate, nested),
          );
        } else {
          out[key] = related
            ? shapeRow(relationModel(model, key), related, nested)
            : null;
        }
        continue;
      }
      throw new Error(
        `booking-evidence test double: unknown field "${model}.${key}" in select`,
      );
    }
    return out;
  }

  if (args?.include) {
    // REFUSED, not resolved. Every read this module makes is a named `select`,
    // and an `include` is how the one read that was not — `getInductionForMember`,
    // which materialises the induction's free text, its sign-offs' comments and
    // signer names, the template prompts and the assigned signers' names — got
    // into a module whose header calls the `select` clauses its only boundary.
    // Failing here is the guard against that being widened back.
    throw new Error(
      `booking-evidence test double: ${model} was read with an \`include\` ` +
        `(${Object.keys(args.include).join(", ")}). This module reads with named ` +
        "`select` clauses only — they are its projection boundary. Narrow the read.",
    );
  }

  const out: Row = {};
  for (const column of spec.columns) {
    out[column] = row[column] === undefined ? null : row[column];
  }
  return out;
}

function relationModel(model: ModelName, relation: string): ModelName {
  if (model === "bookingGuest" && relation === "nights") return "bookingGuestNight";
  if (model === "booking" && relation === "originBookingRequest") {
    return "bookingRequest";
  }
  if (model === "bedAllocation" && relation === "bookingGuest") {
    return "bookingGuest";
  }
  if (model === "booking" && relation === "member") return "member";
  throw new Error(
    `booking-evidence test double: no model registered for ${model}.${relation}`,
  );
}

function compareValues(left: unknown, right: unknown): number {
  const a = comparable(left);
  const b = comparable(right);
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function applyOrderBy(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const clauses = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Record<
    string,
    "asc" | "desc"
  >[];
  return [...rows].sort((left, right) => {
    for (const clause of clauses) {
      for (const [field, direction] of Object.entries(clause)) {
        const delta = compareValues(left[field], right[field]);
        if (delta !== 0) return direction === "desc" ? -delta : delta;
      }
    }
    return 0;
  });
}

interface QueryArgs {
  where?: Row;
  select?: Row;
  include?: Row;
  orderBy?: unknown;
  take?: number;
}

function findMany(model: ModelName, args: QueryArgs = {}): Row[] {
  const matched = store[model].filter((row) => matchesWhere(model, row, args.where));
  const ordered = applyOrderBy(matched, args.orderBy);
  const limited = args.take === undefined ? ordered : ordered.slice(0, args.take);
  return limited.map((row) => shapeRow(model, row, args));
}

function findFirst(model: ModelName, args: QueryArgs = {}): Row | null {
  return findMany(model, { ...args, take: 1 })[0] ?? null;
}

function findUnique(model: ModelName, args: QueryArgs = {}): Row | null {
  const matched = store[model].filter((row) => matchesWhere(model, row, args.where));
  if (matched.length > 1) {
    throw new Error(
      `booking-evidence test double: findUnique on ${model} matched ${matched.length} rows`,
    );
  }
  return matched[0] ? shapeRow(model, matched[0], args) : null;
}

function count(model: ModelName, args: QueryArgs = {}): number {
  return store[model].filter((row) => matchesWhere(model, row, args.where)).length;
}

function wirePrisma(): void {
  prismaMock.booking.findUnique.mockImplementation(
    async (args: QueryArgs) => findUnique("booking", args),
  );
  prismaMock.bookingGuest.findMany.mockImplementation(
    async (args: QueryArgs) => findMany("bookingGuest", args),
  );
  prismaMock.bookingChangeRequest.findMany.mockImplementation(
    async (args: QueryArgs) => findMany("bookingChangeRequest", args),
  );
  prismaMock.bedAllocation.findMany.mockImplementation(
    async (args: QueryArgs) => findMany("bedAllocation", args),
  );
  prismaMock.member.findUnique.mockImplementation(
    async (args: QueryArgs) => findUnique("member", args),
  );
  prismaMock.member.count.mockImplementation(
    async (args: QueryArgs) => count("member", args),
  );
  prismaMock.memberSubscription.findUnique.mockImplementation(
    async (args: QueryArgs) => findUnique("memberSubscription", args),
  );
  prismaMock.memberInduction.findFirst.mockImplementation(
    async (args: QueryArgs) => findFirst("memberInduction", args),
  );
  prismaMock.$executeRaw.mockResolvedValue(0);
  prismaMock.$transaction.mockImplementation(
    async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock),
  );
}

// ---------------------------------------------------------------------------
// Fixture identities and dates.
// ---------------------------------------------------------------------------

const LODGE_ID = "clzlodge000000000000000001";
const BOOKING_ID = "clzbooking0000000000000001";
const DECOY_BOOKING_ID = "clzbooking0000000000000002";
const MEMBER_ID = "clzmember00000000000000001";
const DECOY_MEMBER_ID = "clzmember00000000000000002";

/** The frozen clock's own calendar day, as `getTodayDateOnly()` resolves it. */
const TODAY = "2026-07-01";
const CHECK_IN = "2026-07-10";
const CHECK_OUT = "2026-07-12";
const NIGHT_ONE = "2026-07-10";
const NIGHT_TWO = "2026-07-11";

/**
 * The membership season `CHECK_IN` falls in, with the default 31-March year end:
 * a July night belongs to the season that opened on 1 April 2026. The owner's
 * subscription row is keyed on it, because the club's refusal is judged in the
 * season of the STAY and not the season the diagnostic runs in.
 */
const BOOKING_SEASON_YEAR = 2026;

/**
 * What an ordinary booking COSTS, in integer cents, and it is the fixture default.
 *
 * `booking-create.ts` prices every draft, so a priced draft is the normal record
 * and the free one is the exception — which is the shape the club's `HARD_BLOCK`
 * refusal turns on, because `confirm-draft` sends a priced draft to the payment
 * flow before it reaches its subscription gate.
 */
const PRICED_BOOKING_CENTS = 42_000;

/** A draft that costs nothing: the one confirm door the club's refusal gates. */
const FREE_BOOKING_CENTS = 0;

function day(dateOnly: string): Date {
  return new Date(`${dateOnly}T00:00:00.000Z`);
}

function nightsBetween(checkIn: string, checkOut: string): string[] {
  const nights: string[] = [];
  for (
    let cursor = day(checkIn);
    cursor < day(checkOut);
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    nights.push(cursor.toISOString().slice(0, 10));
  }
  return nights;
}

/**
 * Age-tier settings: ADULT and YOUTH owe a paid subscription, CHILD and INFANT do
 * not. Constant across the file, because every subscription scenario below varies
 * the membership TYPE behaviour and the season row instead — which is exactly the
 * pair `resolveMemberSubscriptionSettlement` reads.
 *
 * YOUTH owing one is a deliberate choice and not a convenience. `not_adult_age_tier`
 * and `subscription_unpaid` are otherwise mutually exclusive under a settings row
 * that exempts every non-adult tier, so the combined-ranking fixtures below could
 * not raise both — and the ranking between them would be untested. A club charging
 * youth subscriptions is an ordinary configuration of `subscriptionRequiredForBooking`,
 * and CHILD keeps the exempt case honest for the BASED_ON_AGE_TIER test.
 */
const AGE_TIER_SETTINGS = [
  { tier: "INFANT", subscriptionRequiredForBooking: false },
  { tier: "CHILD", subscriptionRequiredForBooking: false },
  { tier: "YOUTH", subscriptionRequiredForBooking: true },
  { tier: "ADULT", subscriptionRequiredForBooking: true },
];

// ---------------------------------------------------------------------------
// Scenario builders.
// ---------------------------------------------------------------------------

interface NightSpec {
  night: string;
  occupied?: number;
  available?: number;
  held?: boolean;
}

interface GuestSpec {
  id?: string;
  memberId?: string | null;
  ageTier?: string;
  isMember?: boolean;
  firstName?: string;
  lastName?: string;
  /** Explicit `BookingGuestNight` rows. Omit to exercise the envelope arm. */
  nights?: string[];
  stayStart?: string;
  stayEnd?: string;
}

interface RequestSpec {
  id?: string;
  status?: string;
  kind?: string;
  holdExpiresAt?: Date | null;
  createdAt?: Date;
  /** How many `PolicyExceptionReservationNight` rows the request really holds. */
  reservationNights?: number;
}

interface BookingScenario {
  status?: string;
  checkIn?: string;
  checkOut?: string;
  deletedAt?: Date | null;
  requiresAdminReview?: boolean;
  adminReviewStatus?: string | null;
  adultMemberHostingReviewStatus?: string | null;
  wholeLodgeHold?: boolean;
  isRequestConverted?: boolean;
  adminCapacityHoldAt?: Date | null;
  capacityOverriddenAt?: Date | null;
  guests?: GuestSpec[];
  requests?: RequestSpec[];
  /** Nights this booking has bed allocations on, one allocation per entry. */
  allocatedNights?: string[];
  capacityNights?: NightSpec[];
  violations?: { reasonCode: string; capacityMode?: "HOLD" | "NO_HOLD" }[];
  conflicts?: Row[];
  /** Booking row absent altogether. */
  missing?: boolean;
  /**
   * The club's subscription-lockout mode, as the STRICT reader answers it.
   *
   * Defaults to the platform's own default, `HARD_BLOCK`
   * (`src/config/club-settings-defaults.ts`), because a suite whose default mode
   * was the permissive one could never see the refusal the default mode applies —
   * which is exactly how `booking_block_state` came to answer "nothing is
   * blocking" about a draft the club refuses.
   */
  lockoutMode?: string;
  /** The OWNER's live `Member.ageTier`, the one input the refusal reads about them. */
  ownerAgeTier?: string;
  /** The owner's effective membership-type subscription behaviour. */
  ownerSubscriptionBehavior?: string;
  /**
   * The owner's season `MemberSubscription.status`. `undefined` means NO ROW,
   * which is a different fact from a status — and for a tier that owes one, the
   * unpaid case.
   */
  ownerSubscriptionStatus?: string;
  /**
   * `Booking."finalPriceCents"`, and the DEFAULT IS A PRICED BOOKING on purpose.
   *
   * It is the second half of what `confirm-draft` checks before its subscription
   * refusal: that route 400s on any draft whose price is not zero ("Use the payment
   * flow to complete non-zero bookings"), so the club's `HARD_BLOCK` refusal stands
   * in front of a FREE confirm and nothing else. A suite that defaulted this to 0
   * could not see the difference — every draft would be the gated one — which is
   * exactly how the entry came to report the club's refusal against a $420 draft the
   * member pays for through Stripe and confirms.
   */
  finalPriceCents?: number;
}

interface MemberScenario {
  email?: string;
  passwordHash?: string;
  ageTier?: string;
  active?: boolean;
  canLogin?: boolean;
  cancelledAt?: Date | null;
  archivedAt?: Date | null;
  requiresInduction?: boolean;
  hutLeaderEligible?: boolean;
  joinedDate?: Date | null;
  bookingBehavior?: string;
  subscriptionBehavior?: string;
  /** `null` means NO season row at all, which is a different fact from a status. */
  subscription?: {
    status: string;
    paidAt?: Date | null;
    manuallyMarkedPaidAt?: Date | null;
  } | null;
  inductionStatus?: string | null;
  lockoutMode?: string;
  /** Member row absent altogether. */
  missing?: boolean;
  /** No membership type resolves for the season. */
  noTypePolicy?: boolean;
}

/**
 * The DECOY rows. Seeded for every scenario, never legitimately visible to
 * anything under test, and the reason most tests in this file double as a proof
 * that the source's `where` clauses are applied.
 */
function seedDecoys(): void {
  store.booking.push({
    id: DECOY_BOOKING_ID,
    memberId: DECOY_MEMBER_ID,
    lodgeId: LODGE_ID,
    status: "PAID",
    checkIn: day(CHECK_IN),
    checkOut: day(CHECK_OUT),
    deletedAt: null,
    requiresAdminReview: true,
    adminReviewStatus: "PENDING",
    adminReviewedAt: null,
    adultMemberHostingReviewStatus: "PENDING",
    adultMemberHostingReviewedAt: null,
    waitlistPosition: null,
    waitlistOfferExpiresAt: null,
    wholeLodgeHold: true,
    adminCapacityHoldAt: null,
    originBookingRequest: null,
    capacityOverriddenAt: day(CHECK_IN),
    parentBookingId: null,
    draftExpiresAt: null,
    notes: "DECOY NOTES — never projectable",
    adminReviewNotes: "DECOY REVIEW NOTES",
    deletedReason: "DECOY REASON",
  });
  for (let index = 0; index < 3; index += 1) {
    const guestId = `decoy-guest-${index}`;
    store.bookingGuest.push({
      id: guestId,
      bookingId: DECOY_BOOKING_ID,
      firstName: "Decoy",
      lastName: `Guest${index}`,
      ageTier: "ADULT",
      isMember: true,
      memberId: DECOY_MEMBER_ID,
      stayStart: day(NIGHT_ONE),
      stayEnd: day(CHECK_OUT),
      consentStatus: "ACCEPTED",
    });
    store.bookingGuestNight.push({
      id: `${guestId}-n1`,
      bookingGuestId: guestId,
      stayDate: day(NIGHT_ONE),
    });
  }
  for (let index = 0; index < 2; index += 1) {
    const requestId = `decoy-request-${index}`;
    store.bookingChangeRequest.push({
      id: requestId,
      bookingId: DECOY_BOOKING_ID,
      requestedByMemberId: DECOY_MEMBER_ID,
      status: "REQUESTED",
      kind: "POLICY_EXCEPTION",
      holdExpiresAt: new Date("2026-07-02T00:00:00.000Z"),
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      internalNotes: "DECOY INTERNAL NOTES",
    });
    store.policyExceptionReservationNight.push(
      { id: `${requestId}-a`, requestId, stayDate: day(NIGHT_ONE) },
      { id: `${requestId}-b`, requestId, stayDate: day(NIGHT_TWO) },
    );
  }
  for (const night of [NIGHT_ONE, NIGHT_TWO]) {
    for (let index = 0; index < 2; index += 1) {
      store.bedAllocation.push({
        id: `decoy-alloc-${night}-${index}`,
        bookingId: DECOY_BOOKING_ID,
        bookingGuestId: `decoy-guest-${index}`,
        bedId: `bed-${index}`,
        stayDate: day(night),
      });
    }
  }

  // The decoy MEMBER carries BOTH erasure markers, an unpaid season row and an
  // incomplete induction. A member-eligibility read that lost its `id` filter
  // would report the ordinary member under test as erased, unpaid and
  // un-inducted — three findings, none of them true.
  store.member.push({
    id: DECOY_MEMBER_ID,
    email: "deleted-aaaabbbb@deleted.invalid",
    passwordHash: DELETED_ACCOUNT_PASSWORD_HASH,
    ageTier: "YOUTH",
    active: false,
    canLogin: false,
    cancelledAt: day("2026-01-01"),
    archivedAt: day("2026-02-01"),
    requiresInduction: true,
    hutLeaderEligible: false,
    joinedDate: day("2019-03-04"),
    firstName: "Decoy",
    lastName: "Member",
  });
  store.memberSubscription.push({
    memberId: DECOY_MEMBER_ID,
    seasonYear: 2026,
    status: "UNPAID",
    paidAt: null,
    manuallyMarkedPaidAt: null,
  });
  store.memberInduction.push({
    id: "decoy-induction",
    memberId: DECOY_MEMBER_ID,
    status: "IN_PROGRESS",
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
  });
}

function seedBooking(scenario: BookingScenario = {}): void {
  const checkIn = scenario.checkIn ?? CHECK_IN;
  const checkOut = scenario.checkOut ?? CHECK_OUT;
  const stayNights = nightsBetween(checkIn, checkOut);

  if (!scenario.missing) {
    store.booking.push({
      id: BOOKING_ID,
      memberId: MEMBER_ID,
      lodgeId: LODGE_ID,
      status: scenario.status ?? "CONFIRMED",
      checkIn: day(checkIn),
      checkOut: day(checkOut),
      deletedAt: scenario.deletedAt ?? null,
      requiresAdminReview: scenario.requiresAdminReview ?? false,
      adminReviewStatus: scenario.adminReviewStatus ?? null,
      adminReviewedAt: null,
      adultMemberHostingReviewStatus:
        scenario.adultMemberHostingReviewStatus ?? null,
      adultMemberHostingReviewedAt: null,
      waitlistPosition: null,
      waitlistOfferExpiresAt: null,
      wholeLodgeHold: scenario.wholeLodgeHold ?? false,
      adminCapacityHoldAt: scenario.adminCapacityHoldAt ?? null,
      originBookingRequest: scenario.isRequestConverted
        ? { id: "origin-request-1" }
        : null,
      capacityOverriddenAt: scenario.capacityOverriddenAt ?? null,
      parentBookingId: null,
      draftExpiresAt: null,
      finalPriceCents: scenario.finalPriceCents ?? PRICED_BOOKING_CENTS,
      notes: "PRIVATE booking notes about Jane Tramper",
      adminReviewNotes: "PRIVATE officer note",
      deletedReason: "PRIVATE deletion reason",
    });
  }

  const guests: GuestSpec[] = scenario.guests ?? [
    { id: "guest-1", memberId: MEMBER_ID, nights: stayNights },
    { id: "guest-2", memberId: null, isMember: false, nights: stayNights },
  ];
  guests.forEach((guest, index) => {
    const guestId = guest.id ?? `guest-${index + 1}`;
    const explicit = guest.nights;
    store.bookingGuest.push({
      id: guestId,
      bookingId: BOOKING_ID,
      firstName: guest.firstName ?? `Guest${index + 1}`,
      lastName: guest.lastName ?? "Under-Test",
      ageTier: guest.ageTier ?? "ADULT",
      isMember: guest.isMember ?? true,
      memberId: guest.memberId ?? null,
      stayStart: day(guest.stayStart ?? explicit?.[0] ?? checkIn),
      stayEnd: day(guest.stayEnd ?? checkOut),
      consentStatus: "ACCEPTED",
    });
    (explicit ?? []).forEach((night, nightIndex) => {
      store.bookingGuestNight.push({
        id: `${guestId}-night-${nightIndex}`,
        bookingGuestId: guestId,
        stayDate: day(night),
      });
    });
  });

  (scenario.requests ?? []).forEach((request, index) => {
    const requestId = request.id ?? `request-${index + 1}`;
    store.bookingChangeRequest.push({
      id: requestId,
      bookingId: BOOKING_ID,
      requestedByMemberId: MEMBER_ID,
      status: request.status ?? "REQUESTED",
      kind: request.kind ?? "POLICY_EXCEPTION",
      holdExpiresAt: request.holdExpiresAt ?? null,
      createdAt: request.createdAt ?? new Date("2026-06-15T00:00:00.000Z"),
      internalNotes: "PRIVATE officer commentary",
    });
    for (let night = 0; night < (request.reservationNights ?? 0); night += 1) {
      store.policyExceptionReservationNight.push({
        id: `${requestId}-reservation-${night}`,
        requestId,
        stayDate: day(stayNights[night % stayNights.length] ?? NIGHT_ONE),
      });
    }
  });

  (scenario.allocatedNights ?? []).forEach((night, index) => {
    store.bedAllocation.push({
      id: `alloc-${index}`,
      bookingId: BOOKING_ID,
      bookingGuestId: scenario.guests?.[0]?.id ?? "guest-1",
      bedId: `bed-${index}`,
      stayDate: day(night),
    });
  });

  const capacityNights: NightSpec[] =
    scenario.capacityNights ?? stayNights.map((night) => ({ night }));
  checkCapacityMock.mockImplementation(async () => ({
    available: true,
    minAvailable: 8,
    nightDetails: capacityNights.map((spec) => ({
      date: day(spec.night),
      occupiedBeds: spec.occupied ?? 4,
      availableBeds: spec.available ?? 8,
      wholeLodgeHeld: spec.held ?? false,
    })),
  }));
  const preparedViolations = (scenario.violations ?? []).map((violation) => ({
      reasonCode: violation.reasonCode,
      capacityMode: violation.capacityMode ?? "NO_HOLD",
      policyId: "policy-1",
      policyVersion: 1,
    }));
  evaluatePersistedNonHostingViolationsMock.mockImplementation(async () =>
    preparedViolations.filter(
      (violation) => violation.reasonCode !== "ADULT_MEMBER_HOSTING_REQUIRED",
    ),
  );
  evaluatePersistedHostingMock.mockResolvedValue({
    violation:
      preparedViolations.find(
        (violation) => violation.reasonCode === "ADULT_MEMBER_HOSTING_REQUIRED",
      ) ?? null,
    resolved: {},
  });
  findBookingMemberNightConflictsMock.mockImplementation(
    async () => scenario.conflicts ?? [],
  );

  /**
   * THE OWNER'S OWN MEMBERSHIP FACTS, seeded for every booking scenario.
   *
   * `booking_block_state` needs three things about the owner before it can say
   * whether the club's HARD_BLOCK refusal stands: the club's mode, the owner's live
   * age tier, and their season subscription. The mode DEFAULTS TO `HARD_BLOCK`
   * here, which is the platform default and the mode the missing blocker was found
   * under — a suite defaulting to `NO_BLOCK` would have proved nothing.
   *
   * The owner is seeded PAID by default, so an existing fixture raises no new code
   * and any fixture that DOES raise it is asking for it explicitly. `ADULT` +
   * `REQUIRED` + a `PAID` row is the ordinary financial member.
   */
  store.member.push({
    id: MEMBER_ID,
    email: "owner@example.test",
    passwordHash: "owner-hash",
    ageTier: scenario.ownerAgeTier ?? "ADULT",
    active: true,
    canLogin: true,
    cancelledAt: null,
    archivedAt: null,
    requiresInduction: false,
    hutLeaderEligible: false,
    joinedDate: null,
    firstName: "Owner",
    lastName: "Under-Test",
  });
  store.memberSubscription.push({
    memberId: MEMBER_ID,
    seasonYear: BOOKING_SEASON_YEAR,
    status: scenario.ownerSubscriptionStatus ?? "PAID",
    paidAt: null,
    manuallyMarkedPaidAt: null,
  });
  resolveMembershipTypePolicyForMemberMock.mockImplementation(async () => ({
    memberId: MEMBER_ID,
    seasonYear: BOOKING_SEASON_YEAR,
    source: "assignment",
    membershipType: { key: "FULL", name: "Full Member" },
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: scenario.ownerSubscriptionBehavior ?? "REQUIRED",
  }));
  peekSubscriptionLockoutModeMock.mockImplementation(
    async () => scenario.lockoutMode ?? "HARD_BLOCK",
  );
}

function seedMember(scenario: MemberScenario = {}): void {
  /**
   * `seedBooking` now seeds the same member id — the booking's OWNER, whose live
   * age tier and season subscription the club's HARD_BLOCK refusal reads. When a
   * test seeds BOTH, the member-scoped scenario is the one under test and has to
   * win, so its own rows replace the owner defaults rather than sitting behind
   * them where `findUnique` would never reach them.
   */
  store.member = store.member.filter((row) => row.id !== MEMBER_ID);
  store.memberSubscription = store.memberSubscription.filter(
    (row) => row.memberId !== MEMBER_ID,
  );
  if (!scenario.missing) {
    store.member.push({
      id: MEMBER_ID,
      email: scenario.email ?? "ordinary.member@example.test",
      passwordHash: scenario.passwordHash ?? "$2b$12$anOrdinaryBcryptHashValue",
      ageTier: scenario.ageTier ?? "ADULT",
      active: scenario.active ?? true,
      canLogin: scenario.canLogin ?? true,
      cancelledAt: scenario.cancelledAt ?? null,
      archivedAt: scenario.archivedAt ?? null,
      requiresInduction: scenario.requiresInduction ?? false,
      hutLeaderEligible: scenario.hutLeaderEligible ?? false,
      // `in` and not `??`: an explicit `null` is a member with no recorded joining
      // date, which is a case the projection has to answer for, and `??` would
      // quietly hand it the default instead.
      joinedDate: "joinedDate" in scenario ? scenario.joinedDate : day("2020-01-15"),
      firstName: "Ordinary",
      lastName: "Member",
    });
  }
  if (scenario.subscription) {
    store.memberSubscription.push({
      memberId: MEMBER_ID,
      seasonYear: 2026,
      status: scenario.subscription.status,
      paidAt: scenario.subscription.paidAt ?? null,
      manuallyMarkedPaidAt: scenario.subscription.manuallyMarkedPaidAt ?? null,
    });
  }
  if (scenario.inductionStatus) {
    store.memberInduction.push({
      id: "induction-1",
      memberId: MEMBER_ID,
      status: scenario.inductionStatus,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    });
  }
  resolveMembershipTypePolicyForMemberMock.mockImplementation(async () =>
    scenario.noTypePolicy
      ? null
      : {
          memberId: MEMBER_ID,
          memberName: "Ordinary Member",
          memberRole: "USER",
          memberAgeTier: scenario.ageTier ?? "ADULT",
          seasonYear: 2026,
          // The resolver's OWN value, not an invented one. `MembershipTypePolicySource`
          // is "assignment" | "role_default" | "built_in_default", and the entry's
          // scope line tells the model that the two default sources mean NO
          // assignment exists for the season — so a fixture that returned a source
          // the resolver cannot return would leave that sentence untested.
          source: "assignment",
          membershipType: { key: "FULL", name: "Full Member" },
          bookingBehavior: scenario.bookingBehavior ?? "MEMBER_RATE",
          subscriptionBehavior: scenario.subscriptionBehavior ?? "NOT_REQUIRED",
        },
  );
  peekSubscriptionLockoutModeMock.mockImplementation(
    async () => scenario.lockoutMode ?? "NO_BLOCK",
  );
}

async function blockStateRow(): Promise<Row> {
  const rows = await readBookingBlockStateEvidence({ bookingId: BOOKING_ID });
  expect(rows).toHaveLength(1);
  return rows[0] as unknown as Row;
}

async function eligibilityRow(): Promise<Row> {
  const rows = await readMemberEligibilityEvidence({ memberId: MEMBER_ID });
  expect(rows).toHaveLength(1);
  return rows[0] as unknown as Row;
}

/** `blocker_codes` is `null` when nothing is raised — not the string "none". */
function blockers(row: Row): string[] {
  return row.blocker_codes === null ? [] : String(row.blocker_codes).split(",");
}

function eligibilityCodes(row: Row): string[] {
  return row.eligibility_codes === null
    ? []
    : String(row.eligibility_codes).split(",");
}

beforeEach(() => {
  vi.clearAllMocks();
  store = emptyStore();
  seedDecoys();
  wirePrisma();
  getAgeTierSettingsMock.mockImplementation(async () => AGE_TIER_SETTINGS);
  prismaMock.membershipLockoutSettings.findUnique.mockResolvedValue({
    financialYearEndMonthOverride: DEFAULT_FINANCIAL_YEAR_END_MONTH,
  });
  prismaMock.xeroToken.findFirst.mockResolvedValue(null);
  prismaMock.clubTimeSettings.findUnique.mockResolvedValue({
    timeZone: "Pacific/Auckland",
  });
});

// ---------------------------------------------------------------------------
// 0. The double itself.
// ---------------------------------------------------------------------------

describe("the Prisma double actually applies its filters (#2376)", () => {
  it("hides a SECOND booking's guests, open requests and bed allocations", async () => {
    // THE TEST THAT ONLY PASSES IF THE `where` IS APPLIED. The decoy booking
    // carries three guests, two open REQUESTED change requests holding four
    // reservation nights between them, and four bed allocations — every one of
    // them on the same lodge and the same nights. Under AID-6C's own
    // `mockResolvedValue` style of stub this booking would report five guests and
    // two open exception requests it does not have, and an officer would be sent
    // to an exception queue that has nothing of theirs in it.
    seedBooking({ guests: [{ id: "guest-1", nights: [NIGHT_ONE, NIGHT_TWO] }] });
    const row = await blockStateRow();
    expect(row.guest_count).toBe(1);
    expect(row.open_exception_request_count).toBe(0);
    expect(row.exception_held_night_count).toBe(0);
    expect(row.booking_id).toBe(BOOKING_ID);
  });

  it("does not count a request whose status is not REQUESTED as open", async () => {
    // `status: "REQUESTED"` is half of that `where`, and it is the half a
    // filter-blind double cannot see: an APPROVED and a REJECTED request are
    // finished business. Counting them would tell an operator the ball is still
    // with an officer on a booking nobody is holding up.
    seedBooking({
      requests: [
        { id: "approved", status: "APPROVED", reservationNights: 2 },
        { id: "rejected", status: "REJECTED", reservationNights: 2 },
        { id: "cancelled", status: "CANCELLED", reservationNights: 2 },
      ],
    });
    const row = await blockStateRow();
    expect(row.open_exception_request_count).toBe(0);
    expect(row.exception_held_night_count).toBe(0);
    expect(blockers(row)).not.toContain("exception_request_open");
  });

  it("returns ONLY the selected columns, so an unselected one reads undefined", async () => {
    // The other half of the design, and AID-6C's blocker #1: a projection that
    // reads a column its `select` did not name reads `undefined` in production
    // and `undefined` here. The fixtures deliberately carry `notes`,
    // `adminReviewNotes` and `deletedReason` — the three columns the pack doc
    // says must never be one typo away from a projected row — so if the source
    // ever widened its select this assertion is where it surfaces.
    seedBooking();
    await blockStateRow();
    const select = prismaMock.booking.findUnique.mock.calls[0]?.[0]?.select as Row;
    expect(select).toBeDefined();
    for (const forbidden of [
      "notes",
      "adminReviewNotes",
      "memberReviewJustification",
      "deletedReason",
      "adultMemberHostingReview",
    ]) {
      expect(Object.keys(select)).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 1. booking_block_state — absence, suppression, lifecycle.
// ---------------------------------------------------------------------------

describe("booking block state: absence and refusal (#2376)", () => {
  it("returns NO rows for a booking that does not exist", async () => {
    // Zero rows is the executor's `not_found` — "we looked and there is nothing"
    // — which is a different answer from a row full of zeroes, and a different
    // answer again from the rejection the next test asserts.
    seedBooking({ missing: true });
    await expect(
      readBookingBlockStateEvidence({ bookingId: BOOKING_ID }),
    ).resolves.toEqual([]);
  });

  it.each([
    ["the booking read", () => prismaMock.booking.findUnique],
    ["the guest read", () => prismaMock.bookingGuest.findMany],
    ["the open-request read", () => prismaMock.bookingChangeRequest.findMany],
  ])("REJECTS rather than returning a partial row when %s fails", async (
    _label,
    pick,
  ) => {
    // THE ROW IS ALL-OR-NOTHING. The executor turns a rejection into
    // `evidence_unavailable`; an operator told "the evidence could not be
    // gathered" is strictly better served than one told "no policy violations"
    // by a calculation that never ran. Each input is failed on its own so that a
    // future `try/catch` around any single one of them fails here.
    seedBooking();
    pick().mockRejectedValueOnce(new Error("database unreachable"));
    await expect(
      readBookingBlockStateEvidence({ bookingId: BOOKING_ID }),
    ).rejects.toThrow();
  });

  it.each([
    [
      "the non-hosting policy evaluation",
      () => evaluatePersistedNonHostingViolationsMock,
    ],
    ["the persisted hosting evaluation", () => evaluatePersistedHostingMock],
    ["the capacity engine", () => checkCapacityMock],
    ["the person-night conflict scan", () => findBookingMemberNightConflictsMock],
  ])("REJECTS rather than returning a partial row when %s fails", async (
    _label,
    pick,
  ) => {
    // The three that run inside one `Promise.all`. A row that reported "no policy
    // violations" because the evaluator threw would be the exact fabricated
    // answer this pack is designed against, and the `Promise.all` is what makes
    // the refusal structural rather than a habit.
    seedBooking();
    pick().mockRejectedValueOnce(new Error("evaluator unavailable"));
    await expect(
      readBookingBlockStateEvidence({ bookingId: BOOKING_ID }),
    ).rejects.toThrow();
  });
});

describe("booking block state: terminal and deleted suppression (#2376)", () => {
  it.each(["CANCELLED", "BUMPED"])(
    "runs NO policy evaluation, NO capacity read and NO conflict scan on a %s booking",
    async (status) => {
      // Asserted on the COLLABORATORS, not on the output. A source that ran all
      // three and then dropped their findings would produce an identical row and
      // would still be wrong: evaluating a cancelled booking's party produces
      // violations that are true of the rows and false of the world, and the
      // suppression below would then be the only thing standing between those
      // violations and an officer. It also costs the capacity engine's fan-out on
      // a booking that cannot use the answer.
      seedBooking({
        status,
        violations: [{ reasonCode: "MINIMUM_STAY" }],
        conflicts: [{ memberId: MEMBER_ID }],
        capacityNights: [
          { night: NIGHT_ONE, available: 0, held: true },
          { night: NIGHT_TWO, available: 0 },
        ],
      });
      const row = await blockStateRow();

    expect(evaluatePersistedNonHostingViolationsMock).not.toHaveBeenCalled();
    expect(evaluatePersistedHostingMock).not.toHaveBeenCalled();
      expect(checkCapacityMock).not.toHaveBeenCalled();
      expect(findBookingMemberNightConflictsMock).not.toHaveBeenCalled();

      expect(blockers(row)).toEqual(["booking_lifecycle_terminal"]);
      expect(row.booking_lifecycle_state).toBe("terminal");
      expect(row.policy_violation_codes).toBeNull();
      expect(row.policy_capacity_mode).toBeNull();
    },
  );

  it("runs none of the three on a SOFT-DELETED booking either", async () => {
    // CANCELLED, because that is the only status a deleted booking can carry:
    // `deleteBooking` 400s on anything else and nothing else in the tree writes
    // `deletedAt`. A `PAID` + deleted fixture would be testing a row the product
    // cannot produce.
    seedBooking({
      status: "CANCELLED",
      deletedAt: new Date("2026-06-20T00:00:00.000Z"),
      violations: [{ reasonCode: "MINIMUM_STAY" }],
      conflicts: [{ memberId: MEMBER_ID }],
    });
    const row = await blockStateRow();
    expect(evaluatePersistedNonHostingViolationsMock).not.toHaveBeenCalled();
    expect(evaluatePersistedHostingMock).not.toHaveBeenCalled();
    expect(checkCapacityMock).not.toHaveBeenCalled();
    expect(findBookingMemberNightConflictsMock).not.toHaveBeenCalled();
    expect(blockers(row)).toEqual(["booking_deleted"]);
  });

  it("reports tightest_spare_beds as ABSENT, never as zero, when capacity did not run", async () => {
    // "Not measured" and "no spare beds" are different claims, and the second one
    // sends an officer to fix a booking that is simply over. A zero here would
    // read as "it fits exactly" about a booking that no longer exists — and it is
    // the one field on this row that is null-guarded for that reason.
    seedBooking({ status: "CANCELLED" });
    const row = await blockStateRow();
    expect(row.tightest_spare_beds).toBeNull();
    expect(row.tightest_spare_beds).not.toBe(0);
  });

  it("suppresses EVERY downstream blocker while keeping the facts that were still read", async () => {
    // The catalogue's `TERMINAL_SURVIVING_BLOCKERS` is empty, and this is the end
    // to end proof: a cancelled booking carrying an open exception request whose
    // hold is about to expire, and a locked edit window, reports NEITHER as a
    // blocker. AID-6C kept its bookkeeping blockers alive on a terminal booking
    // because money outlives the booking; nothing in this pack does.
    //
    // The open-request FACTS survive, because that read is not suppressed — the
    // count and the held-night count are still true statements about rows that
    // exist. Only the actionable classification is withheld.
    seedBooking({
      status: "CANCELLED",
      checkIn: "2026-06-01",
      checkOut: "2026-06-03",
      requiresAdminReview: true,
      adminReviewStatus: "PENDING",
      adultMemberHostingReviewStatus: "PENDING",
      requests: [
        {
          id: "open-1",
          reservationNights: 2,
          holdExpiresAt: new Date("2026-07-05T09:00:00.000Z"),
        },
      ],
    });
    const row = await blockStateRow();
    expect(blockers(row)).toEqual(["booking_lifecycle_terminal"]);
    expect(row.open_exception_request_count).toBe(1);
    expect(row.exception_held_night_count).toBe(2);
    expect(row.exception_hold_expires_at_utc).toBe("2026-07-05T09:00:00.000Z");
    expect(row.member_can_modify).toBe(false);
  });

  it("reports the deletion ALONE, not beside the cancellation it presupposes", async () => {
    // THE ONLY SHAPE A DELETED BOOKING COMES IN. `deleteBooking` refuses any
    // status but `CANCELLED`, it is the single writer of `Booking.deletedAt`, and
    // there is no restore path — so a deleted booking is ALWAYS also terminal.
    //
    // That is why raising both codes was a defect rather than thoroughness: it
    // reported one fact twice, inflated `blocker_count` to 2, and sent an operator
    // to two screens (the deleted-bookings view AND a cancellation record) when
    // only the first is a real next step. `booking_lifecycle_state` already
    // resolved the same ambiguity the same way, and the blocker list now agrees
    // with it.
    seedBooking({
      status: "CANCELLED",
      deletedAt: new Date("2026-06-20T00:00:00.000Z"),
    });
    const row = await blockStateRow();
    expect(row.booking_lifecycle_state).toBe("deleted");
    expect(row.booking_status).toBe("CANCELLED");
    expect(blockers(row)).toEqual(["booking_deleted"]);
    expect(row.blocker_codes).toBe("booking_deleted");
    expect(row.blocker_count).toBe(1);
  });

  it("still reports the cancellation on a booking that is terminal WITHOUT being deleted", async () => {
    // The other half of the exclusion, so narrowing `booking_lifecycle_terminal`
    // cannot silently swallow the ordinary cancelled booking — which is the far
    // more common record of the two.
    seedBooking({ status: "CANCELLED" });
    const row = await blockStateRow();
    expect(row.booking_lifecycle_state).toBe("terminal");
    expect(blockers(row)).toEqual(["booking_lifecycle_terminal"]);
    expect(row.blocker_count).toBe(1);
  });

  it("says LIVE for an ordinary booking and raises nothing", async () => {
    seedBooking();
    const row = await blockStateRow();
    expect(row.booking_lifecycle_state).toBe("live");
    expect(blockers(row)).toEqual([]);
    expect(row.blocker_codes).toBeNull();
    expect(row.blocker_count).toBe(0);
    expect(row.tightest_spare_beds).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// 2. booking_block_state — the blocker catalogue, code by code.
// ---------------------------------------------------------------------------

/**
 * ONE FIXTURE PER BLOCKER CODE, and the assertion is the WHOLE emitted list
 * rather than "contains".
 *
 * AID-6C's blocker #2 was a predicate keyed on a booking's lifecycle status while
 * the comment justifying it was about one payment method — so an ordinary record
 * reported the wrong PRIMARY problem, and the suite passed because it only ever
 * asserted the motivating case. Asserting the entire list for every code closes
 * that: a predicate that fires on the wrong input shows up as an extra code in
 * some other row's list, not as a silent mis-ranking.
 *
 * Two codes cannot be raised alone, and the expectations say so rather than
 * pretending otherwise:
 *
 *  - `exception_hold_expiring` needs an OPEN request to hold the beds, so
 *    `exception_request_open` is always raised with it. The pair's ORDER is the
 *    real assertion: the reason they asked comes before the deadline.
 *  - `booking_waitlisted` drags `edit_window_locked`, because WAITLISTED is not a
 *    member-editable status. That is a true second fact about the booking, not
 *    noise, and it is asserted rather than filtered out.
 */
const BLOCKER_FIXTURES: [string, BookingScenario, string[]][] = [
  [
    // CANCELLED with it, because that is the only status a deleted booking has —
    // and the expected list is STILL one code, which is the whole point: the
    // cancellation is the deletion's precondition, not a second finding.
    "booking_deleted",
    {
      status: "CANCELLED",
      deletedAt: new Date("2026-06-20T00:00:00.000Z"),
    },
    ["booking_deleted"],
  ],
  ["booking_lifecycle_terminal", { status: "CANCELLED" }, ["booking_lifecycle_terminal"]],
  [
    "booking_waitlisted",
    { status: "WAITLISTED" },
    ["booking_waitlisted", "edit_window_locked"],
  ],
  [
    "member_night_conflict",
    { conflicts: [{ memberId: MEMBER_ID, conflictingNights: [NIGHT_ONE] }] },
    ["member_night_conflict"],
  ],
  [
    "capacity_exceeded",
    {
      capacityNights: [
        { night: NIGHT_ONE, occupied: 19, available: 1 },
        { night: NIGHT_TWO },
      ],
    },
    ["capacity_exceeded"],
  ],
  [
    "whole_lodge_held",
    {
      // The party stays only the SECOND night, so the held first night creates no
      // shortfall of its own. That is the realistic shape: nobody has guests on a
      // night another booking holds exclusively, which is exactly why the hold has
      // to be reported as its own fact rather than inferred from a shortfall.
      guests: [{ id: "guest-1", nights: [NIGHT_TWO], stayStart: NIGHT_TWO }],
      capacityNights: [
        { night: NIGHT_ONE, occupied: 20, available: 0, held: true },
        { night: NIGHT_TWO },
      ],
    },
    ["whole_lodge_held"],
  ],
  [
    "admin_review_pending",
    { requiresAdminReview: true, adminReviewStatus: "PENDING" },
    ["admin_review_pending"],
  ],
  [
    "hosting_review_pending",
    { adultMemberHostingReviewStatus: "PENDING" },
    ["hosting_review_pending"],
  ],
  [
    "policy_minimum_stay",
    { violations: [{ reasonCode: "MINIMUM_STAY" }] },
    ["policy_minimum_stay"],
  ],
  [
    "policy_adult_member_hosting",
    { violations: [{ reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED" }] },
    ["policy_adult_member_hosting"],
  ],
  [
    // The club's own flat refusal, on the platform's DEFAULT mode, and the ONLY
    // code raised: a future-dated draft is otherwise sound, which is precisely the
    // shape that used to return `blockerCount: 0` on a booking the club refuses.
    "subscription_unpaid_hard_block",
    {
      status: "DRAFT",
      finalPriceCents: FREE_BOOKING_CENTS,
      lockoutMode: "HARD_BLOCK",
      ownerSubscriptionStatus: "UNPAID",
    },
    ["subscription_unpaid_hard_block"],
  ],
  [
    // NON_MEMBER_PRICING, so the club does NOT refuse and only the
    // exception-eligible rule can fire. Set explicitly because the suite's default
    // mode is HARD_BLOCK: under that mode this violation cannot be produced at all.
    "policy_paid_up_adult_member",
    {
      lockoutMode: "NON_MEMBER_PRICING",
      violations: [{ reasonCode: "PAID_UP_ADULT_MEMBER_REQUIRED" }],
    },
    ["policy_paid_up_adult_member"],
  ],
  [
    "exception_request_open",
    { requests: [{ id: "open-1", reservationNights: 0 }] },
    ["exception_request_open"],
  ],
  [
    "exception_hold_expiring",
    {
      requests: [
        {
          id: "open-1",
          reservationNights: 2,
          holdExpiresAt: new Date("2026-07-05T09:00:00.000Z"),
        },
      ],
    },
    ["exception_request_open", "exception_hold_expiring"],
  ],
  [
    "edit_window_locked",
    // A finished stay: check-out is before the frozen "today", so the member has
    // no future night left to change and `getBookingEditPolicy` refuses.
    { status: "PAID", checkIn: "2026-06-01", checkOut: "2026-06-03" },
    ["edit_window_locked"],
  ],
];

describe("booking block state: every blocker code, ranked (#2376)", () => {
  it("has a fixture for every code in the catalogue", () => {
    // The table above is only a ranking proof if it is COMPLETE. A code added to
    // `BOOKING_BLOCKER_CODES` without a fixture would otherwise slip in ranked by
    // nothing but the order somebody typed it.
    expect(BLOCKER_FIXTURES.map(([code]) => code)).toEqual([
      ...BOOKING_BLOCKER_CODES,
    ]);
  });

  it.each(BLOCKER_FIXTURES)(
    "raises %s as the PRIMARY blocker, and emits exactly the expected list",
    async (code, scenario, expected) => {
      seedBooking(scenario);
      const row = await blockStateRow();
      expect(blockers(row)).toEqual(expected);
      expect(blockers(row)[0]).toBe(expected[0]);
      expect(blockers(row)).toContain(code);
      expect(row.blocker_count).toBe(expected.length);
    },
  );

  it.each([
    ["non-zero", {}],
    ["zero", { guests: [] }],
  ] satisfies [string, BookingScenario][])(
    "reports an exclusive hold, not an ordinary shortfall, with %s demand",
    async (_demandLabel, scenario) => {
      // One held night and no ordinary night makes the absence contract
      // observable. Under the old subtraction, demand 2 manufactured a -2
      // shortfall and a second blocker; demand 0 manufactured a measured spare
      // of 0. Neither figure exists: availability 0 is the hold policy's pin.
      seedBooking({
        ...scenario,
        checkIn: NIGHT_ONE,
        checkOut: NIGHT_TWO,
        capacityNights: [
          { night: NIGHT_ONE, occupied: 20, available: 0, held: true },
        ],
      });

      const row = await blockStateRow();
      expect(blockers(row)).toEqual(["whole_lodge_held"]);
      expect(row.shortfall_night_count).toBe(0);
      expect(row.whole_lodge_held_night_count).toBe(1);
      expect(row.tightest_spare_beds).toBeNull();
    },
  );

  it("emits ELEVEN simultaneous blockers in the declared priority order", async () => {
    // THE ORDER IS THE PRODUCT. Several of these are true at once on a real
    // booking, and telling an officer the edit window is locked when a member is
    // double-booked on a night sends them to the wrong screen. The emitting code
    // FILTERS the catalogue rather than sorting a list, so the order is
    // structural — this drives it end to end on a booking carrying eleven at once.
    //
    // `AWAITING_REVIEW` is the status because it is neither terminal nor
    // waitlisted (so nothing is suppressed) and is not member-editable (so the
    // edit-window blocker is genuinely raised rather than staged).
    //
    // ELEVEN AND NOT TWELVE, because the catalogue's two subscription codes cannot
    // both be true: `policy_paid_up_adult_member` is a NON_MEMBER_PRICING-only
    // violation and `subscription_unpaid_hard_block` is a HARD_BLOCK-only refusal.
    // The mode is set here so this fixture is a booking that can exist — under
    // HARD_BLOCK the paid-up-adult violation below could never have been produced.
    seedBooking({
      lockoutMode: "NON_MEMBER_PRICING",
      status: "AWAITING_REVIEW",
      requiresAdminReview: true,
      adminReviewStatus: "PENDING",
      adultMemberHostingReviewStatus: "PENDING",
      guests: [{ id: "guest-1", nights: [NIGHT_TWO], stayStart: NIGHT_TWO }],
      capacityNights: [
        { night: NIGHT_ONE, occupied: 20, available: 0, held: true },
        { night: NIGHT_TWO, occupied: 20, available: 0 },
      ],
      conflicts: [{ memberId: MEMBER_ID, conflictingNights: [NIGHT_TWO] }],
      violations: [
        { reasonCode: "PAID_UP_ADULT_MEMBER_REQUIRED" },
        { reasonCode: "MINIMUM_STAY" },
        { reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED", capacityMode: "HOLD" },
      ],
      requests: [
        {
          id: "open-1",
          reservationNights: 2,
          holdExpiresAt: new Date("2026-07-05T09:00:00.000Z"),
        },
      ],
    });
    const row = await blockStateRow();
    expect(blockers(row)).toEqual([
      "member_night_conflict",
      "capacity_exceeded",
      "whole_lodge_held",
      "admin_review_pending",
      "hosting_review_pending",
      "policy_minimum_stay",
      "policy_adult_member_hosting",
      "policy_paid_up_adult_member",
      "exception_request_open",
      "exception_hold_expiring",
      "edit_window_locked",
    ]);
    expect(row.blocker_count).toBe(11);
    // The violation reason codes are reported as their own field, DEDUPLICATED
    // and sorted — a different question from the ranked blocker list.
    expect(row.policy_violation_codes).toBe(
      "ADULT_MEMBER_HOSTING_REQUIRED,MINIMUM_STAY,PAID_UP_ADULT_MEMBER_REQUIRED",
    );
    // HOLD-if-any-HOLD: one holding violation among three decides the aggregate,
    // because that is the difference between a member keeping their place while
    // an officer decides and losing it.
    expect(row.policy_capacity_mode).toBe("HOLD");
  });

  it("suppresses all eleven on the same booking once it is deleted and cancelled", async () => {
    seedBooking({
      status: "CANCELLED",
      deletedAt: new Date("2026-06-20T00:00:00.000Z"),
      requiresAdminReview: true,
      adminReviewStatus: "PENDING",
      adultMemberHostingReviewStatus: "PENDING",
      capacityNights: [
        { night: NIGHT_ONE, occupied: 20, available: 0, held: true },
        { night: NIGHT_TWO, occupied: 20, available: 0 },
      ],
      conflicts: [{ memberId: MEMBER_ID }],
      violations: [{ reasonCode: "MINIMUM_STAY" }],
      requests: [{ id: "open-1", reservationNights: 2 }],
    });
    const row = await blockStateRow();
    // ONE code, not two: the deletion presupposes the cancellation, so the
    // cancellation is not reported beside it.
    expect(blockers(row)).toEqual(["booking_deleted"]);
    // ALL FOUR MEASUREMENTS ARE ABSENT, not zero, and this assertion is the
    // reason the suite was written before the pack was reviewed. It read
    // `member_night_conflict_count === 0` when this file was first written, which
    // is what the source emitted: a cancelled booking reporting "0 member-night
    // conflicts, 0 nights short" from a conflict scan and a capacity read that
    // were both deliberately skipped two hundred lines earlier. `tightest_spare_beds`
    // already refused that conflation and the three counts beside it did not.
    // `null` is "not measured"; `0` is "measured, and there are none".
    expect(row.member_night_conflict_count).toBeNull();
    expect(row.shortfall_night_count).toBeNull();
    expect(row.whole_lodge_held_night_count).toBeNull();
    expect(row.tightest_spare_beds).toBeNull();
    // The counts whose calculation DID run on a suppressed booking stay numbers:
    // the open-request query is not suppressed, so a zero here is a measurement.
    expect(row.open_exception_request_count).toBe(1);
    expect(row.exception_held_night_count).toBe(2);
  });

  it("reports NO_HOLD when violations exist but none of them holds beds", async () => {
    seedBooking({
      lockoutMode: "NON_MEMBER_PRICING",
      violations: [
        { reasonCode: "MINIMUM_STAY", capacityMode: "NO_HOLD" },
        { reasonCode: "PAID_UP_ADULT_MEMBER_REQUIRED", capacityMode: "NO_HOLD" },
      ],
    });
    const row = await blockStateRow();
    expect(row.policy_capacity_mode).toBe("NO_HOLD");
  });
});

// ---------------------------------------------------------------------------
// 2b. booking_block_state — the club's own HARD_BLOCK subscription refusal.
// ---------------------------------------------------------------------------

/**
 * WHY THIS SUITE EXISTS.
 *
 * `booking_block_state` could return `blockerCodes: null, blockerCount: 0` — with
 * a scope line telling the model "absent means nothing is blocking" — about a saved
 * draft the club will refuse outright, on the platform's DEFAULT lockout mode. The
 * paid-up-adult rule structurally cannot cover it:
 * `evaluateNonMemberPricingRequirements` returns `null` unless the mode is
 * `NON_MEMBER_PRICING`, so under `HARD_BLOCK` the soft-policy evaluator is silent
 * and the refusal lives at the route as a flat 403. The officer was told the
 * booking was clear; the member's confirm then returned "Your membership
 * subscription for the 2026/2027 season is not paid".
 *
 * WHAT IS ASSERTED. Not just that the code appears, but the five boundaries that
 * keep it from becoming a fabricated blocker of its own: it is scoped to the status
 * whose confirm is gated, it is scoped to the ZERO PRICE that makes that confirm the
 * door the member actually uses (a priced draft goes to the payment flow, and
 * `confirm-draft` 400s on it before its subscription refusal), it is scoped to the
 * mode that refuses, it honours the CANONICAL settlement rule rather than a local
 * re-reading of the rows, and it fails closed on an unreadable input instead of
 * guessing.
 */
describe("booking block state: the club's HARD_BLOCK subscription refusal (#2376)", () => {
  it("raises it on a FREE DRAFT whose owner owes an unpaid season subscription", async () => {
    seedBooking({
      status: "DRAFT",
      finalPriceCents: FREE_BOOKING_CENTS,
      lockoutMode: "HARD_BLOCK",
      ownerSubscriptionStatus: "UNPAID",
    });
    const row = await blockStateRow();
    expect(blockers(row)).toEqual(["subscription_unpaid_hard_block"]);
    expect(row.blocker_count).toBe(1);
    // And NOT as a policy violation, because the evaluator produced none: the
    // refusal is the club's, not an exception-eligible rule.
    expect(row.policy_violation_codes).toBeNull();
    expect(row.policy_capacity_mode).toBeNull();
  });

  it("does not raise it for an owner who has PAID", async () => {
    seedBooking({
      status: "DRAFT",
      finalPriceCents: FREE_BOOKING_CENTS,
      lockoutMode: "HARD_BLOCK",
    });
    const row = await blockStateRow();
    expect(blockers(row)).toEqual([]);
    expect(row.blocker_count).toBe(0);
  });

  it.each(["NO_BLOCK", "NON_MEMBER_PRICING"])(
    "does not raise it under %s, and does not even read the owner's settlement",
    async (lockoutMode) => {
      // Under NO_BLOCK the club does not care; under NON_MEMBER_PRICING the unpaid
      // member confirms and is REPRICED, which is `policy_paid_up_adult_member`'s
      // territory. Reporting a refusal in either mode would be a fabricated
      // blocker. The reads are asserted absent as well, because the enforcement
      // sites short-circuit on the mode in exactly this order and a diagnostic that
      // read the rows anyway would be paying for an answer it must discard.
      seedBooking({
        status: "DRAFT",
        finalPriceCents: FREE_BOOKING_CENTS,
        lockoutMode,
        ownerSubscriptionStatus: "UNPAID",
      });
      const row = await blockStateRow();
      expect(blockers(row)).toEqual([]);
      expect(resolveMembershipTypePolicyForMemberMock).not.toHaveBeenCalled();
      expect(getAgeTierSettingsMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a fully priced draft", PRICED_BOOKING_CENTS],
    // ONE CENT, because the boundary is zero rather than "cheap": the route's own
    // condition is `finalPriceCents !== 0`.
    ["a draft priced at one cent", 1],
  ])(
    "does not raise it on %s, whose confirm the route never reaches",
    async (_label, finalPriceCents) => {
    /**
     * THE OTHER HALF OF THE DOOR, and the entry read only the first half.
     *
     * `confirm-draft` 400s on any draft whose `finalPriceCents` is not zero — "Use
     * the payment flow to complete non-zero bookings" — BEFORE its subscription
     * refusal. A priced draft is completed through
     * `POST /api/payments/create-payment-intent` (`DRAFT -> PAYMENT_PENDING ->
     * PAID`), and the booking page renders the confirm button only for a free draft.
     *
     * So the club's flat refusal never stood in front of a priced draft, and raising
     * it there told an officer the club had refused a booking the member pays for and
     * confirms — the fabricated blocker this entry's own contract forbids in as many
     * words. Everything else here is the shape that DOES raise it: DRAFT, HARD_BLOCK,
     * owner owing.
     */
    seedBooking({
      status: "DRAFT",
      finalPriceCents,
      lockoutMode: "HARD_BLOCK",
      ownerSubscriptionStatus: "UNPAID",
    });
    const row = await blockStateRow();
    expect(blockers(row)).toEqual([]);
    expect(row.blocker_count).toBe(0);
    // And it asks nothing about the owner, on the same short-circuit reasoning as
    // the mode: a diagnostic that read the rows anyway would be paying for an answer
    // it must discard.
    expect(resolveMembershipTypePolicyForMemberMock).not.toHaveBeenCalled();
    expect(getAgeTierSettingsMock).not.toHaveBeenCalled();
    },
  );

  it.each(["CONFIRMED", "PAID", "PENDING", "AWAITING_REVIEW", "PAYMENT_PENDING"])(
    "does not raise it on a %s booking, whose confirm the club does not gate",
    async (status) => {
      // THE SCOPING DECISION, asserted rather than left implicit. The HARD_BLOCK
      // refusal sits on `POST /api/bookings/[id]/confirm-draft`, which 400s on any
      // status but DRAFT before it reaches the subscription gate, and on creation,
      // which has no persisted booking to diagnose. On an already-confirmed booking
      // the owner's unpaid subscription blocks nothing about THAT booking, so
      // raising it would be exactly the false actionable finding this pack exists
      // to avoid. `member_eligibility_state` is where the member-level fact lives.
      // Zero-price, so the STATUS is the only reason the code is absent — a
      // priced fixture would pass this test for the wrong reason.
      seedBooking({
        status,
        finalPriceCents: FREE_BOOKING_CENTS,
        lockoutMode: "HARD_BLOCK",
        ownerSubscriptionStatus: "UNPAID",
      });
      const row = await blockStateRow();
      expect(blockers(row)).not.toContain("subscription_unpaid_hard_block");
      expect(resolveMembershipTypePolicyForMemberMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    // The canonical rule's three exemptions, each of which a local re-reading of
    // `MemberSubscription.status` would have got wrong.
    [
      "a NOT_REQUIRED membership type",
      { ownerSubscriptionBehavior: "NOT_REQUIRED", ownerSubscriptionStatus: "UNPAID" },
    ],
    [
      "a BASED_ON_AGE_TIER type whose season row says NOT_REQUIRED",
      {
        ownerSubscriptionBehavior: "BASED_ON_AGE_TIER",
        ownerSubscriptionStatus: "NOT_REQUIRED",
      },
    ],
    [
      "an age tier the club exempts",
      { ownerAgeTier: "CHILD", ownerSubscriptionStatus: "UNPAID" },
    ],
  ] satisfies [string, BookingScenario][])(
    "honours the canonical settlement rule: %s owes nothing",
    async (_label, scenario) => {
      seedBooking({
        status: "DRAFT",
        finalPriceCents: FREE_BOOKING_CENTS,
        lockoutMode: "HARD_BLOCK",
        ...scenario,
      });
      const row = await blockStateRow();
      expect(blockers(row)).toEqual([]);
    },
  );

  it("treats an owner whose Member row cannot be resolved as OWING one", async () => {
    // `resolveMemberSubscriptionSettlement` documents this direction: an id that
    // does not resolve must never silently price at member rates. For evidence the
    // same direction is right — a booking whose owner cannot be read is not a
    // booking anyone should be told is clear.
    seedBooking({
      status: "DRAFT",
      finalPriceCents: FREE_BOOKING_CENTS,
      lockoutMode: "HARD_BLOCK",
    });
    // The whole owner, gone: no `Member` row and therefore no season subscription
    // either, which is the only shape a cascading delete could leave behind. The
    // tier is then unresolvable, and the canonical rule requires a subscription of
    // a member it cannot read.
    store.member = store.member.filter((row) => row.id !== MEMBER_ID);
    store.memberSubscription = store.memberSubscription.filter(
      (row) => row.memberId !== MEMBER_ID,
    );
    const row = await blockStateRow();
    expect(blockers(row)).toEqual(["subscription_unpaid_hard_block"]);
  });

  it("REFUSES when the strict age-tier read fails, rather than answering without it", async () => {
    // The swallowing reader would have returned `AGE_TIER_DEFAULTS` here and the
    // row would have carried a confident refusal — or a confident absence — derived
    // from a club rule nobody observed. `evidence_unavailable` is the honest answer.
    seedBooking({
      status: "DRAFT",
      finalPriceCents: FREE_BOOKING_CENTS,
      lockoutMode: "HARD_BLOCK",
      ownerSubscriptionStatus: "UNPAID",
    });
    getAgeTierSettingsMock.mockRejectedValueOnce(
      new Error("age tier settings unavailable"),
    );
    await expect(
      readBookingBlockStateEvidence({ bookingId: BOOKING_ID }),
    ).rejects.toThrow("age tier settings unavailable");
  });

  it("judges the owner in the season the BOOKING's check-in falls in", async () => {
    // The season is the stored one keyed on the stay, not on "now" and not on the
    // process-level financial-year cache. A club whose year ends in JUNE puts this
    // July stay in the 2026 season that opened on 1 July 2026 — the same year here,
    // so the discriminating assertion is the LOOKUP: the row read has to be the one
    // for the booking's season, and a subscription row filed under any other season
    // must not settle the owner.
    seedBooking({
      status: "DRAFT",
      finalPriceCents: FREE_BOOKING_CENTS,
      lockoutMode: "HARD_BLOCK",
      ownerSubscriptionStatus: "UNPAID",
    });
    // A PAID row for the NEXT season, which must not clear the stay's own season.
    store.memberSubscription.push({
      memberId: MEMBER_ID,
      seasonYear: BOOKING_SEASON_YEAR + 1,
      status: "PAID",
      paidAt: null,
      manuallyMarkedPaidAt: null,
    });
    const row = await blockStateRow();
    expect(blockers(row)).toEqual(["subscription_unpaid_hard_block"]);
    expect(
      resolveMembershipTypePolicyForMemberMock.mock.calls[0]?.[1],
    ).toMatchObject({ seasonYear: BOOKING_SEASON_YEAR });
  });

  it.each([
    ["deleted", { status: "CANCELLED", deletedAt: new Date("2026-06-20T00:00:00.000Z") }],
    ["terminal", { status: "CANCELLED" }],
  ] satisfies [string, BookingScenario][])(
    "asks nothing about the owner's subscription on a %s booking",
    async (_label, scenario) => {
      seedBooking({
        ...scenario,
        finalPriceCents: FREE_BOOKING_CENTS,
        lockoutMode: "HARD_BLOCK",
        ownerSubscriptionStatus: "UNPAID",
      });
      await blockStateRow();
      expect(resolveMembershipTypePolicyForMemberMock).not.toHaveBeenCalled();
      expect(getAgeTierSettingsMock).not.toHaveBeenCalled();
      expect(peekSubscriptionLockoutModeMock).not.toHaveBeenCalled();
    },
  );

  it("hands BOTH canonical rules the same strict, transaction-bound age-tier reader", async () => {
    /**
     * THE READ THE CLIENT-THREADING RULE COULD NOT REACH.
     *
     * Under `NON_MEMBER_PRICING` the paid-up-adult rule and the #2364 hosting bridge
     * both decide "does this member owe a subscription" through
     * `loadMemberSubscriptionSettlements`, which read the club's per-tier flag via
     * `getAgeTierSettings` — a function with NO client parameter, which dynamic-
     * imports the global client, serves a five-minute cache and CATCHES every
     * database error to return `AGE_TIER_DEFAULTS`. So one input to this row's
     * subscription findings ran outside the snapshot, the statement timeout and
     * `READ ONLY`, and a transient failure produced `policy_paid_up_adult_member` —
     * and through the bridge `policy_adult_member_hosting` — against a named member
     * from the platform's defaults rather than the club's rule.
     *
     * The loader now takes a READER, and this asserts the four properties the fix
     * rests on: both collaborators get one, it is the SAME one, it reads through the
     * transaction client, and it is memoised so the row observes the club's tier
     * policy once.
     */
    seedBooking({
      status: "DRAFT",
      finalPriceCents: FREE_BOOKING_CENTS,
      lockoutMode: "NON_MEMBER_PRICING",
      ownerSubscriptionStatus: "UNPAID",
    });
    await blockStateRow();

    const nonHostingOptions = evaluatePersistedNonHostingViolationsMock.mock
      .calls[0]?.[4] as { readAgeTierSettings?: () => Promise<unknown> };
    const hostingOptions = evaluatePersistedHostingMock.mock.calls[0]?.[2] as {
      readAgeTierSettings?: () => Promise<unknown>;
    };
    expect(typeof nonHostingOptions?.readAgeTierSettings).toBe("function");
    expect(hostingOptions?.readAgeTierSettings).toBe(
      nonHostingOptions?.readAgeTierSettings,
    );

    // LAZY. A row whose rules never consult the tier flag performs no settings read,
    // which is what keeps a failed read from refusing a row that had no subscription
    // finding in it. Under this mode the pack's own refusal is not evaluated, and the
    // two collaborators are doubles here, so nothing has called it yet.
    expect(getAgeTierSettingsMock).not.toHaveBeenCalled();

    await nonHostingOptions.readAgeTierSettings?.();
    await hostingOptions.readAgeTierSettings?.();
    // ONE read for both consumers, and it went through the transaction client.
    expect(getAgeTierSettingsMock).toHaveBeenCalledTimes(1);
    expect(getAgeTierSettingsMock.mock.calls[0]?.[0]).toBe(txMock);
    expect(getAgeTierSettingsMock.mock.calls[0]?.[0]).not.toBe(prismaMock);
  });

  it("reads the owner's settlement inside the entry's own transaction client", async () => {
    // Not the global client: this read joins the same read-only REPEATABLE READ
    // snapshot and the same statement timeout as every other read on the graph, or
    // the newest read on the entry is the one the database cannot cancel.
    seedBooking({
      status: "DRAFT",
      finalPriceCents: FREE_BOOKING_CENTS,
      lockoutMode: "HARD_BLOCK",
      ownerSubscriptionStatus: "UNPAID",
    });
    await blockStateRow();
    expect(resolveMembershipTypePolicyForMemberMock.mock.calls[0]?.[0]).toBe(txMock);
    expect(resolveMembershipTypePolicyForMemberMock.mock.calls[0]?.[0]).not.toBe(
      prismaMock,
    );
    expect(getAgeTierSettingsMock.mock.calls[0]?.[0]).toBe(txMock);
  });
});

// ---------------------------------------------------------------------------
// 3. booking_block_state — the waitlist carve-out and the held-bed test.
// ---------------------------------------------------------------------------

describe("booking block state: waitlist, holds and the edit window (#2376)", () => {
  it.each(["WAITLISTED", "WAITLIST_OFFERED"])(
    "reports the shortfall on a %s booking as a FACT and never as capacity_exceeded",
    async (status) => {
      // A waitlisted booking does not fit BY DEFINITION, so reporting
      // `capacity_exceeded` as its problem would outrank the status that explains
      // it. The scope text says the shortfall is reported as a supporting fact and
      // the waitlist status as the reason, and the code agrees: `shortfallNights`
      // is still computed and still projected, only the BLOCKER is withheld.
      seedBooking({
        status,
        capacityNights: [
          { night: NIGHT_ONE, occupied: 20, available: 0 },
          { night: NIGHT_TWO, occupied: 20, available: 0 },
        ],
      });
      const row = await blockStateRow();
      expect(blockers(row)).toContain("booking_waitlisted");
      expect(blockers(row)).not.toContain("capacity_exceeded");
      // The fact survives, in full: two nights short and two spare beds in
      // deficit. Withholding it would leave an officer unable to see how far off
      // the booking is.
      expect(row.shortfall_night_count).toBe(2);
      expect(row.tightest_spare_beds).toBe(-2);
      expect(blockers(row).indexOf("booking_waitlisted")).toBe(0);
    },
  );

  it("still reports capacity_exceeded on a non-waitlisted booking with the same shortfall", async () => {
    // The control for the carve-out above: identical capacity, ordinary status.
    // Without this the waitlist assertion would also pass for an implementation
    // that never raised `capacity_exceeded` at all.
    seedBooking({
      status: "CONFIRMED",
      capacityNights: [
        { night: NIGHT_ONE, occupied: 20, available: 0 },
        { night: NIGHT_TWO, occupied: 20, available: 0 },
      ],
    });
    const row = await blockStateRow();
    expect(blockers(row)).toContain("capacity_exceeded");
    expect(row.shortfall_night_count).toBe(2);
  });

  it("counts held beds from the RESERVATION NIGHTS, not from holdExpiresAt", async () => {
    // The schema states the trap in as many words: a row written before the
    // `holdExpiresAt` column existed can be holding beds with a NULL deadline. A
    // capacity question filtered on the deadline would report "no beds held" about
    // beds that are held, and the member's place would be given away by an officer
    // who believed nothing was reserved.
    seedBooking({
      requests: [{ id: "legacy-hold", reservationNights: 2, holdExpiresAt: null }],
    });
    const row = await blockStateRow();
    expect(row.exception_held_night_count).toBe(2);
    expect(row.exception_hold_expires_at_utc).toBeNull();
    expect(blockers(row)).toContain("exception_request_open");
    // No deadline to report, so no expiring-hold blocker — the beds are held
    // indefinitely, which is a different problem from a hold about to lapse.
    expect(blockers(row)).not.toContain("exception_hold_expiring");
  });

  it("does NOT treat a deadline with zero reservation nights as beds held", async () => {
    // The exact inverse inference, and the reason `exception_held_night_count` is
    // the only reliable test: a request can carry a hold deadline and reserve
    // nothing. Reporting it as holding beds would have an officer chasing a
    // reservation that does not exist.
    seedBooking({
      requests: [
        {
          id: "deadline-only",
          reservationNights: 0,
          holdExpiresAt: new Date("2026-07-03T00:00:00.000Z"),
        },
      ],
    });
    const row = await blockStateRow();
    expect(row.exception_held_night_count).toBe(0);
    expect(row.exception_hold_expires_at_utc).toBeNull();
    expect(blockers(row)).not.toContain("exception_hold_expiring");
  });

  it("takes the earliest deadline among the requests that ACTUALLY hold beds", async () => {
    // Two open requests. The EARLIER deadline belongs to a request holding
    // nothing; the later one is holding the member's beds. A naive `min` over
    // every `holdExpiresAt` reports the earlier date and sends an officer to
    // rescue beds three days before they are at risk — or, worse, tells them the
    // deadline has already passed.
    seedBooking({
      requests: [
        {
          id: "empty-early",
          reservationNights: 0,
          holdExpiresAt: new Date("2026-07-02T00:00:00.000Z"),
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
        {
          id: "holding-late",
          reservationNights: 3,
          holdExpiresAt: new Date("2026-07-08T00:00:00.000Z"),
          createdAt: new Date("2026-06-02T00:00:00.000Z"),
        },
      ],
    });
    const row = await blockStateRow();
    expect(row.open_exception_request_count).toBe(2);
    expect(row.exception_held_night_count).toBe(3);
    expect(row.exception_hold_expires_at_utc).toBe("2026-07-08T00:00:00.000Z");
  });

  it("answers the edit window for the BOOKING OWNER, not for the administrator", async () => {
    // `member_can_modify` answers "can the member fix this themselves, or does it
    // need an officer" — one of the two next-step questions #2376 asks for. The
    // admin answer is always yes-with-an-override, which would tell an operator
    // nothing, so the classifier is called with `role: "USER"`.
    seedBooking({ status: "CONFIRMED" });
    const future = await blockStateRow();
    expect(future.member_can_modify).toBe(true);
    expect(future.edit_window_mode).toBe("future");

    // WAITLISTED is admin-editable and member-locked, so it is the status that
    // distinguishes the two roles. An implementation passing `"ADMIN"` here would
    // report `canModify: true` and this assertion is what catches it.
    store = emptyStore();
    seedDecoys();
    seedBooking({ status: "WAITLISTED" });
    const waitlisted = await blockStateRow();
    expect(waitlisted.member_can_modify).toBe(false);
    expect(waitlisted.edit_window_mode).toBeNull();
  });

  it("classifies an in-progress stay as in-progress rather than locked", async () => {
    // `checkIn <= today <= checkOut` with a PAID booking: the party is at the
    // lodge and may still extend. Reporting it as locked would send an officer to
    // make a change the member can make themselves.
    seedBooking({ status: "PAID", checkIn: TODAY, checkOut: "2026-07-03" });
    const row = await blockStateRow();
    expect(row.edit_window_mode).toBe("in-progress");
    expect(row.member_can_modify).toBe(true);
    expect(blockers(row)).not.toContain("edit_window_locked");
  });
});

// ---------------------------------------------------------------------------
// 4. booking_block_state — the review gate, the party footprint, and privacy.
// ---------------------------------------------------------------------------

describe("booking block state: reviews and the party footprint (#2376)", () => {
  it("does not call an APPROVED admin review pending", async () => {
    // `requiresAdminReview === true` with `adminReviewStatus === "APPROVED"` is a
    // booking an officer has already cleared. Reporting it as blocked is AID-6C's
    // "predicate reading the wrong one of two columns that usually agree" in its
    // exact shape, and the platform's own `isCheckinBlockedByPendingReview` is the
    // conjunction — so this pins the delegation as well as the answer.
    seedBooking({ requiresAdminReview: true, adminReviewStatus: "APPROVED" });
    const row = await blockStateRow();
    expect(row.admin_review_pending).toBe(false);
    expect(blockers(row)).not.toContain("admin_review_pending");
    // The REASON codes are a different question and still report the supervision
    // hazard: the booking required review, it just is not blocked by it.
    expect(row.review_reason_codes).toBe("ADULT_SUPERVISION");
  });

  it("keeps the hosting review OUT of the check-in gate", async () => {
    // A pending ADULT-MEMBER HOSTING review deliberately does not turn a party
    // away at the door — the fix is an adult member joining the booking, which
    // nobody at the door can do. The two review states are reported separately for
    // that reason, and collapsing them would refuse arrival for a membership rule.
    seedBooking({ adultMemberHostingReviewStatus: "PENDING" });
    const row = await blockStateRow();
    expect(row.hosting_review_pending).toBe(true);
    expect(row.admin_review_pending).toBe(false);
    expect(row.review_reason_codes).toBe("ADULT_MEMBER_HOSTING_REQUIRED");
    expect(blockers(row)).toEqual(["hosting_review_pending"]);
  });

  it("uses each guest's EXPLICIT nights and never expands their envelope over them", async () => {
    // A guest may occupy NON-CONTIGUOUS nights inside one booking, in which case
    // `stayStart`/`stayEnd` are only the derived min/max envelope. Expanding them
    // would invent a night the guest is not staying, which is then reported as
    // capacity demand that does not exist — and on a tight night that manufactures
    // a shortfall out of nothing.
    seedBooking({
      checkIn: "2026-07-10",
      checkOut: "2026-07-13",
      guests: [
        {
          id: "guest-1",
          nights: ["2026-07-10", "2026-07-12"],
          stayStart: "2026-07-10",
          stayEnd: "2026-07-13",
        },
      ],
      capacityNights: [
        { night: "2026-07-10", available: 1 },
        { night: "2026-07-11", available: 0 },
        { night: "2026-07-12", available: 1 },
      ],
    });
    const row = await blockStateRow();
    // The middle night has zero beds free and the guest is not on it, so nothing
    // is short. An envelope expansion would report one bed short on 07-11.
    expect(row.shortfall_night_count).toBe(0);
    expect(row.tightest_spare_beds).toBe(0);
    expect(blockers(row)).not.toContain("capacity_exceeded");
  });

  it("falls back to the envelope for a guest with NO night rows at all", async () => {
    // A booking written before the per-guest night rows existed has an envelope
    // and nothing else. Refusing to expand it would report a party of zero nights
    // — a booking that demands no beds, fits everywhere, and blocks nothing.
    seedBooking({
      guests: [{ id: "legacy-guest", stayStart: CHECK_IN, stayEnd: CHECK_OUT }],
      capacityNights: [
        { night: NIGHT_ONE, available: 0 },
        { night: NIGHT_TWO, available: 0 },
      ],
    });
    const row = await blockStateRow();
    expect(row.guest_count).toBe(1);
    expect(row.shortfall_night_count).toBe(2);
    expect(blockers(row)).toContain("capacity_exceeded");
  });

  it.each([
    ["block state", readBookingBlockStateEvidence],
    ["capacity", readBookingCapacityEvidence],
  ])("refuses a zero-night guest envelope in %s", async (_label, read) => {
    // [start,end) with equal endpoints contains no lodge night. Fabricating an
    // occupied night here would contradict every canonical stay-boundary rule.
    seedBooking({
      guests: [{ id: "zero-night", stayStart: NIGHT_ONE, stayEnd: NIGHT_ONE }],
    });
    await expect(read({ bookingId: BOOKING_ID })).rejects.toThrow(/zero nights/);
    expect(checkCapacityMock).not.toHaveBeenCalled();
    expect(evaluatePersistedNonHostingViolationsMock).not.toHaveBeenCalled();
    expect(evaluatePersistedHostingMock).not.toHaveBeenCalled();
  });

  it("calls the capacity engine with a guest count of ZERO and this booking excluded", async () => {
    // `nightDetails` is what the tool reports, and with the booking excluded each
    // night's figures are the room the REST of the lodge leaves for it. Passing the
    // party's headcount instead would double-count the booking against itself and
    // report a shortfall on a booking that fits perfectly; passing no exclusion
    // would count its own beds as somebody else's occupancy.
    seedBooking();
    await blockStateRow();
    // And with the TRANSACTION CLIENT as its sixth argument, so the widest read in
    // the entry runs inside the entry's own snapshot and under its statement
    // timeout. The engine's own `tx ?? prisma` fallback is exactly the silent
    // escape this argument exists to close.
    expect(checkCapacityMock).toHaveBeenCalledWith(
      LODGE_ID,
      day(CHECK_IN),
      day(CHECK_OUT),
      0,
      BOOKING_ID,
      txMock,
    );
  });
});

// ---------------------------------------------------------------------------
// 2c. Every server-owned read is bounded AT THE DATABASE (#2376).
// ---------------------------------------------------------------------------

describe("server-owned evidence is bounded at the database, not only in JS (#2376)", () => {
  /**
   * WHY THIS SUITE EXISTS. The entry-level deadline is a `Promise.race`: it stops
   * this process waiting and cancels nothing. Nothing in Prisma propagates a
   * cancellation into an in-flight statement, so the hosting sibling fan-out, the
   * conflict scan and the capacity engine all used to keep running against the
   * database after the operator had already been told the evidence was unavailable.
   * The bound therefore has to be PostgreSQL's own, and these assertions are about
   * the statements that establish it.
   */
  const READERS = [
    ["block state", () => readBookingBlockStateEvidence({ bookingId: BOOKING_ID })],
    ["capacity", () => readBookingCapacityEvidence({ bookingId: BOOKING_ID })],
    [
      "member eligibility",
      () => readMemberEligibilityEvidence({ memberId: MEMBER_ID }),
    ],
  ] as const;

  it.each(READERS)(
    "%s opens ONE read-only transaction with a statement timeout",
    async (_label, read) => {
      seedBooking();
      seedMember({});
      await read();
      // ONE. A nested interactive transaction would be a second pool connection,
      // a second snapshot and a second timeout — the pool-starvation shape
      // CONCURRENCY_AND_LOCKING.md forbids — which is why the bed-allocation
      // sub-read now joins its caller's transaction instead of opening its own.
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      expect(prismaMock.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          // REPEATABLE READ, and the point is that being inside a transaction is
          // NOT what makes one snapshot. PostgreSQL's default READ COMMITTED takes
          // a fresh snapshot per STATEMENT, and `SET TRANSACTION READ ONLY` is
          // orthogonal to isolation — so without this option the row could still
          // pair a party read at instant A with occupancy read at instant B, which
          // is exactly what the entry's own copy promises it cannot.
          isolationLevel: "RepeatableRead",
          // Asked of the code, never a literal (#2804): the owner raised the wait,
          // and it is then CLAMPED to whatever pg's own pool ceiling allows, so the
          // right answer depends on the connection string this test runs against. A
          // hardcoded 2_000 would have gone on passing against a bound that moved.
          maxWait: resolveReadOnlyMaxWaitMs(),
          timeout: DIAGNOSTICS_READ_ONLY_TRANSACTION_TIMEOUT_MS,
        }),
      );
      // READ ONLY first, then the timeout: PostgreSQL refuses a write in this
      // transaction even where a grant would permit one, which is what makes
      // "completely read-only" a property the database enforces rather than a
      // property of this code being careful. These entries run on the
      // application's own full-privilege connection, so nothing else does.
      expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);
      expect(prismaMock.$executeRaw.mock.calls[0]?.[0]?.[0]).toBe(
        "SET TRANSACTION READ ONLY",
      );
      // The timeout arrives as a BOUND PARAMETER through `set_config`, not built
      // into the SQL: `SET LOCAL` takes no placeholders, and the literal it forced
      // is the one that used to be able to diverge from the constant.
      expect(prismaMock.$executeRaw.mock.calls[1]?.[0]?.[0]).toBe(
        "SELECT pg_catalog.set_config('statement_timeout', ",
      );
      expect(prismaMock.$executeRaw.mock.calls[1]?.[0]?.[1]).toBe(", true)");
      expect(prismaMock.$executeRaw.mock.calls[1]?.[1]).toBe(
        String(DIAGNOSTICS_READ_ONLY_STATEMENT_TIMEOUT_MS),
      );
    },
  );

  it("orders the three bounds statement < transaction < JS deadline", async () => {
    // ONE ordering assertion instead of three literals, which is the whole reason
    // the constants are exported. The bound used to exist in three unlinked
    // representations — the constant, a `'5s'` literal in the statement, and
    // hardcoded 7_000/10_000 numbers here — so narrowing the constant would have
    // left PostgreSQL cancelling at five seconds with the transaction ceiling BELOW
    // it: the operator gets a generic Prisma transaction timeout instead of the
    // specific 57014 refusal, and every assertion still passes.
    seedBooking();
    await blockStateRow();
    const options = prismaMock.$transaction.mock.calls[0]?.[1] as {
      timeout: number;
    };
    expect(DIAGNOSTICS_READ_ONLY_STATEMENT_TIMEOUT_MS).toBeLessThan(
      DIAGNOSTICS_READ_ONLY_TRANSACTION_TIMEOUT_MS,
    );
    expect(DIAGNOSTICS_READ_ONLY_TRANSACTION_TIMEOUT_MS).toBeLessThan(AID6B_EVIDENCE_DEADLINE_MS);
    expect(options.timeout).toBe(DIAGNOSTICS_READ_ONLY_TRANSACTION_TIMEOUT_MS);
    // And the statement's own value is the same constant, not a parallel literal.
    expect(prismaMock.$executeRaw.mock.calls[1]?.[1]).toBe(
      String(DIAGNOSTICS_READ_ONLY_STATEMENT_TIMEOUT_MS),
    );
  });

  it("hands the transaction client to EVERY collaborator on the block-state graph", async () => {
    // The finding this closes: each of these helpers takes a client and falls back
    // to the global one when it is not given it. A helper that fell back would run
    // outside both the snapshot and the timeout — which is the whole boundary the
    // transaction exists to create — while looking perfectly correct at the call
    // site.
    seedBooking();
    await blockStateRow();
    // `txMock` is a DISTINCT object from `prismaMock` holding the same doubled
    // functions, so each pair of assertions really discriminates: passing the global
    // client would satisfy every behavioural expectation in this file and fail here.
    for (const received of [
      evaluatePersistedNonHostingViolationsMock.mock.calls[0]?.[0],
      evaluatePersistedHostingMock.mock.calls[0]?.[1],
      findBookingMemberNightConflictsMock.mock.calls[0]?.[0],
      checkCapacityMock.mock.calls[0]?.[5],
    ]) {
      expect(received).toBe(txMock);
      expect(received).not.toBe(prismaMock);
    }
  });

  it("hands it to every collaborator on the member-eligibility graph too", async () => {
    seedMember({});
    await eligibilityRow();
    expect(resolveMembershipTypePolicyForMemberMock.mock.calls[0]?.[0]).toBe(
      txMock,
    );
    expect(resolveMembershipTypePolicyForMemberMock.mock.calls[0]?.[0]).not.toBe(
      prismaMock,
    );
    // The strict settings readers and the induction read take a client for the same
    // reason; they are doubled here, so what is asserted is that the pack asks for
    // them at all inside the transaction rather than which client they received.
    expect(getAgeTierSettingsMock).toHaveBeenCalled();
    expect(peekSubscriptionLockoutModeMock).toHaveBeenCalled();
  });

  it("gives the hosting sibling fan-out a deterministic ceiling", async () => {
    // The widest read in either pack: each sibling arrives with its guests and
    // their night rows. Unbounded is right for a WRITER — its answer must see every
    // booking that could cover a night — and wrong for a diagnostic, which must
    // either answer or say it could not.
    seedBooking();
    await blockStateRow();
    const options = evaluatePersistedHostingMock.mock.calls[0]?.[2] as {
      siblingCeiling?: number;
      sameOwnerSourceCeiling?: number;
    };
    expect(options.siblingCeiling).toBe(AID6B_HOSTING_SIBLING_CEILING);
    // BOTH host populations, because the sibling ceiling covered only one of them.
    // `loadSameBookingOwnerHosts` runs whenever the lodge has the
    // same-booking-owner scope on, and its writer bound TRUNCATES with no order —
    // which for a diagnostic means dropping the booking that carries the covering
    // adult and reporting `policy_adult_member_hosting` on a covered booking.
    expect(options.sameOwnerSourceCeiling).toBe(
      AID6B_HOSTING_SAME_OWNER_SOURCE_CEILING,
    );
  });
});

describe("booking block state: the person-night guard is called least-privileged (#2376)", () => {
  it("acts as the booking's OWN owner with actorRole USER, never as an administrator", async () => {
    // LOAD-BEARING, and the reason this caller is classified EXEMPT from the
    // cross-family marking contract in `review-findings-contracts.test.ts`. The
    // guard's privileged fields — the counterpart booking id, its owner's name,
    // its status and dates — are gated on the ACTOR's role. Passing the
    // administrator running the diagnostic would have the guard attach another
    // member's booking to a refusal payload this tool then projects. `"USER"` is
    // the least-privileged answer that still returns a conflict, and the exemption
    // reason is written against exactly this call shape, so a change here has to
    // fail somewhere: this is that somewhere.
    seedBooking({ conflicts: [{ memberId: MEMBER_ID }] });
    await blockStateRow();
    const call = findBookingMemberNightConflictsMock.mock.calls[0]?.[1] as Row;
    expect(call.actorMemberId).toBe(MEMBER_ID);
    expect(call.actorRole).toBe("USER");
    expect(call.excludeBookingId).toBe(BOOKING_ID);
    expect(call.checkIn).toEqual(day(CHECK_IN));
    expect(call.checkOut).toEqual(day(CHECK_OUT));
  });

  it("projects a COUNT and no conflict detail whatsoever", async () => {
    // The third leg of the exemption: nothing the cross-family marker protects is
    // projected. The guard's row carries `memberName`, `conflictingNights` and the
    // counterpart booking; this source reads `conflicts.length` and nothing else.
    // The fixture below stuffs every one of those into the guard's answer and the
    // assertion sweeps the whole emitted row for them, so a future edit that
    // "helpfully" surfaced the clash detail fails here rather than in an audit.
    seedBooking({
      conflicts: [
        {
          memberId: DECOY_MEMBER_ID,
          memberName: "Nosy Neighbour",
          conflictingNights: ["2099-01-05"],
          bookingId: "clzsecret000000000000000009",
          bookingOwnerName: "Someone Else Entirely",
          bookingCheckIn: "2099-01-05",
        },
        { memberId: MEMBER_ID, memberName: "Ordinary Member" },
      ],
    });
    const row = await blockStateRow();
    expect(row.member_night_conflict_count).toBe(2);
    expect(blockers(row)).toContain("member_night_conflict");
    for (const value of Object.values(row)) {
      if (typeof value !== "string") continue;
      expect(value).not.toContain("Nosy Neighbour");
      expect(value).not.toContain("Someone Else Entirely");
      expect(value).not.toContain("2099-01-05");
      expect(value).not.toContain("clzsecret");
    }
  });

  it("never projects a private booking column even though the rows carry one", async () => {
    // The pack doc names `notes`, `adminReviewNotes` and `deletedReason` as
    // columns that sit one `select` away from a projected row. The fixtures carry
    // recognisable values in all three; the double would happily return them if
    // the source asked, so this asserts on the OUTPUT that it never does.
    seedBooking({
      requests: [{ id: "open-1", reservationNights: 1 }],
    });
    const row = await blockStateRow();
    for (const value of Object.values(row)) {
      if (typeof value !== "string") continue;
      expect(value).not.toContain("PRIVATE");
      expect(value).not.toContain("Jane Tramper");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. booking_capacity_by_night.
// ---------------------------------------------------------------------------

describe("booking capacity by night (#2376)", () => {
  it("returns NO rows for a booking that does not exist", async () => {
    seedBooking({ missing: true });
    await expect(
      readBookingCapacityEvidence({ bookingId: BOOKING_ID }),
    ).resolves.toEqual([]);
  });

  it("WITHHOLDS the occupancy count on a whole-lodge-held night", async () => {
    // `checkCapacity` deliberately PINS `occupiedBeds` to the lodge's full
    // capacity on a held night (ADR-001 decision 6, #118) so a member reading the
    // public availability payload cannot tell a held night from a genuinely full
    // one. That is right for a member and WRONG for a diagnostic: an operator
    // handed "occupied 20 of 20" concludes the lodge is full when in fact one
    // booking has reserved sole occupancy and the beds are empty — and both of
    // their next steps (chase the other bookings, or over-capacity confirm) are
    // wrong, because an admin override cannot punch into a held night at all.
    //
    // So the count is ABSENT. Not zero — which would read as an empty lodge with
    // no beds available, a contradiction — and not the pin, which would be a
    // presentation artefact passed off as a measurement.
    seedBooking({
      capacityNights: [
        { night: NIGHT_ONE, occupied: 20, available: 0, held: true },
        { night: NIGHT_TWO, occupied: 6, available: 14 },
      ],
    });
    const rows = (await readBookingCapacityEvidence({
      bookingId: BOOKING_ID,
    })) as unknown as Row[];
    expect(rows).toHaveLength(2);

    const held = rows[0];
    expect(held.night).toBe(NIGHT_ONE);
    expect(held.occupied_beds_excluding_this_booking).toBeNull();
    expect(held.occupied_beds_excluding_this_booking).not.toBe(0);
    expect(held.occupied_beds_excluding_this_booking).not.toBe(20);
    // `availableBeds` is NOT pinned in the same way — it is honestly 0 on a held
    // night, and 0 is the true answer to "how much room is there" — so it is
    // reported as it stands, beside the fact that explains it.
    expect(held.available_beds_excluding_this_booking).toBe(0);
    expect(held.spare_beds_after_this_booking).toBeNull();
    expect(held.whole_lodge_held_by_another_booking).toBe(true);
    expect(held.fits_this_night).toBe(false);

    // And on an ordinary night the count is reported in full: the withholding is
    // narrow, not a blanket refusal to answer.
    const ordinary = rows[1];
    expect(ordinary.occupied_beds_excluding_this_booking).toBe(6);
    expect(ordinary.whole_lodge_held_by_another_booking).toBe(false);
    expect(ordinary.fits_this_night).toBe(true);
  });

  it.each([
    ["non-zero", {}, 2],
    ["zero", { guests: [] }, 0],
  ] satisfies [string, BookingScenario, number][])(
    "withholds held-night spare arithmetic and refuses fit with %s demand",
    async (_demandLabel, scenario, expectedDemand) => {
      seedBooking({
        ...scenario,
        checkIn: NIGHT_ONE,
        checkOut: NIGHT_TWO,
        capacityNights: [
          { night: NIGHT_ONE, occupied: 20, available: 0, held: true },
        ],
      });

      const rows = (await readBookingCapacityEvidence({
        bookingId: BOOKING_ID,
      })) as unknown as Row[];
      expect(rows).toHaveLength(1);
      expect(rows[0].party_beds_this_night).toBe(expectedDemand);
      expect(rows[0].available_beds_excluding_this_booking).toBe(0);
      expect(rows[0].spare_beds_after_this_booking).toBeNull();
      expect(rows[0].fits_this_night).toBe(false);
      expect(rows[0].whole_lodge_held_by_another_booking).toBe(true);
    },
  );

  it("keeps 'another booking holds the lodge' apart from 'this booking holds it'", async () => {
    // Two different facts about the same night, and merging them would tell an
    // officer somebody else has the lodge when in fact this very booking does.
    seedBooking({
      wholeLodgeHold: true,
      capacityNights: [{ night: NIGHT_ONE }, { night: NIGHT_TWO }],
    });
    const rows = (await readBookingCapacityEvidence({
      bookingId: BOOKING_ID,
    })) as unknown as Row[];
    expect(rows[0].this_booking_effectively_holds_whole_lodge).toBe(true);
    expect(rows[0].this_booking_has_whole_lodge_hold_flag).toBe(true);
    expect(rows[0].whole_lodge_held_by_another_booking).toBe(false);
    expect(rows[0].occupied_beds_excluding_this_booking).toBe(4);
    expect(rows[0].spare_beds_after_this_booking).toBe(6);
    expect(rows[0].fits_this_night).toBe(true);
  });

  it.each([
    ["generic pending", { status: "PENDING" }, false],
    ["converted pending", { status: "PENDING", isRequestConverted: true }, true],
    ["cancelled", { status: "CANCELLED" }, false],
    [
      // The shape the product actually produces: deletion is only reachable from
      // CANCELLED.
      "deleted and cancelled",
      {
        status: "CANCELLED",
        deletedAt: new Date("2026-06-20T00:00:00.000Z"),
      },
      false,
    ],
    [
      // DELIBERATELY AN UNREACHABLE ROW, and the label says so. `deleteBooking`
      // cannot produce a CONFIRMED deleted booking, so this arm is not a product
      // state — it isolates the `deletedAt === null` clause of the effective-hold
      // predicate from `bookingHoldsCapacity`, which is a capacity predicate and
      // knows nothing about deletion. Drop the clause and the row above still
      // passes on the status alone; this arm is what fails.
      "deleted while still CONFIRMED (unreachable; isolates the deletion clause)",
      { deletedAt: new Date("2026-06-20T00:00:00.000Z") },
      false,
    ],
  ] satisfies [string, BookingScenario, boolean][])(
    "reports a stored hold flag honestly for %s while effective is %s",
    async (_label, scenario, effective) => {
      seedBooking({ ...scenario, wholeLodgeHold: true });
      const rows = (await readBookingCapacityEvidence({
        bookingId: BOOKING_ID,
      })) as unknown as Row[];
      expect(rows[0].this_booking_has_whole_lodge_hold_flag).toBe(true);
      expect(rows[0].this_booking_effectively_holds_whole_lodge).toBe(effective);
    },
  );

  it("REFUSES a stay longer than the night ceiling rather than clipping it", async () => {
    // A per-night capacity answer that stops in the middle of a stay invites "the
    // lodge has room" about the half that was shown. Truncation would be reported
    // honestly by the substrate and would still be the wrong shape of answer here,
    // so this is a refusal and the entry's scope line names the bed-allocation
    // board as the surface that can answer it.
    const nights = nightsBetween("2026-07-10", "2026-08-12");
    expect(nights.length).toBe(AID6B_CAPACITY_NIGHT_CEILING + 2);
    seedBooking({
      checkIn: "2026-07-10",
      checkOut: "2026-08-12",
      guests: [{ id: "guest-1", nights: [NIGHT_ONE] }],
      capacityNights: nights.map((night) => ({ night })),
    });
    await expect(
      readBookingCapacityEvidence({ bookingId: BOOKING_ID }),
    ).rejects.toThrow(/ceiling/);
    expect(prismaMock.bookingGuest.findMany).not.toHaveBeenCalled();
    expect(checkCapacityMock).not.toHaveBeenCalled();
  });

  it("refuses an oversized block-state span before guest or capacity expansion", async () => {
    seedBooking({
      checkIn: "2026-07-10",
      checkOut: "2026-08-12",
      guests: [],
      capacityNights: [],
    });
    await expect(
      readBookingBlockStateEvidence({ bookingId: BOOKING_ID }),
    ).rejects.toThrow(/ceiling/);
    expect(prismaMock.bookingGuest.findMany).not.toHaveBeenCalled();
    expect(checkCapacityMock).not.toHaveBeenCalled();
    expect(evaluatePersistedNonHostingViolationsMock).not.toHaveBeenCalled();
    expect(evaluatePersistedHostingMock).not.toHaveBeenCalled();
  });

  it.each([
    ["terminal", { status: "CANCELLED" }],
    [
      "deleted",
      {
        status: "CANCELLED",
        deletedAt: new Date("2026-06-20T00:00:00.000Z"),
      },
    ],
    ["waitlisted", { status: "WAITLISTED" }],
  ])("refuses an oversized %s block-state span before any population read", async (_label, state) => {
    seedBooking({
      ...state,
      checkIn: "2026-07-10",
      checkOut: "2026-08-12",
      guests: [],
    });
    await expect(
      readBookingBlockStateEvidence({ bookingId: BOOKING_ID }),
    ).rejects.toThrow(/ceiling/);
    expect(prismaMock.bookingGuest.findMany).not.toHaveBeenCalled();
    expect(prismaMock.bookingChangeRequest.findMany).not.toHaveBeenCalled();
    expect(checkCapacityMock).not.toHaveBeenCalled();
    expect(evaluatePersistedNonHostingViolationsMock).not.toHaveBeenCalled();
    expect(evaluatePersistedHostingMock).not.toHaveBeenCalled();
    expect(findBookingMemberNightConflictsMock).not.toHaveBeenCalled();
  });

  it.each([
    ["block state", readBookingBlockStateEvidence],
    ["capacity", readBookingCapacityEvidence],
  ])("refuses excessive guests before authoritative helpers in %s", async (_label, read) => {
    seedBooking({
      guests: Array.from(
        { length: AID6B_BOOKING_GUEST_CEILING + 1 },
        (_, index) => ({ id: `guest-${index}`, nights: [NIGHT_ONE] }),
      ),
    });
    await expect(read({ bookingId: BOOKING_ID })).rejects.toThrow(
      /booking guests exceeds/,
    );
    expect(checkCapacityMock).not.toHaveBeenCalled();
    expect(evaluatePersistedNonHostingViolationsMock).not.toHaveBeenCalled();
    expect(evaluatePersistedHostingMock).not.toHaveBeenCalled();
    expect(findBookingMemberNightConflictsMock).not.toHaveBeenCalled();
  });

  it.each([
    ["block state", readBookingBlockStateEvidence],
    ["capacity", readBookingCapacityEvidence],
  ])("refuses excessive explicit guest-night rows before helpers in %s", async (_label, read) => {
    seedBooking({
      guests: [
        {
          id: "guest-corrupt-nights",
          nights: Array.from(
            { length: AID6B_CAPACITY_NIGHT_CEILING + 1 },
            () => NIGHT_ONE,
          ),
        },
      ],
    });
    await expect(read({ bookingId: BOOKING_ID })).rejects.toThrow(
      /guest-night rows exceeds/,
    );
    expect(checkCapacityMock).not.toHaveBeenCalled();
    expect(evaluatePersistedNonHostingViolationsMock).not.toHaveBeenCalled();
    expect(evaluatePersistedHostingMock).not.toHaveBeenCalled();
    expect(findBookingMemberNightConflictsMock).not.toHaveBeenCalled();
  });

  it.each([
    ["block state", readBookingBlockStateEvidence],
    ["capacity", readBookingCapacityEvidence],
  ])("refuses a huge guest fallback envelope on a one-night booking in %s", async (_label, read) => {
    seedBooking({
      checkIn: NIGHT_ONE,
      checkOut: NIGHT_TWO,
      guests: [
        {
          id: "guest-corrupt-envelope",
          stayStart: NIGHT_ONE,
          stayEnd: "2026-09-30",
        },
      ],
    });
    await expect(read({ bookingId: BOOKING_ID })).rejects.toThrow(
      /guest fallback envelope covers/,
    );
    expect(checkCapacityMock).not.toHaveBeenCalled();
    expect(evaluatePersistedNonHostingViolationsMock).not.toHaveBeenCalled();
    expect(evaluatePersistedHostingMock).not.toHaveBeenCalled();
    expect(findBookingMemberNightConflictsMock).not.toHaveBeenCalled();
  });

  it("refuses excessive open requests before block-state helpers", async () => {
    seedBooking({
      guests: [],
      requests: Array.from(
        { length: AID6B_OPEN_REQUEST_CEILING + 1 },
        (_, index) => ({ id: `request-${index}` }),
      ),
    });
    await expect(
      readBookingBlockStateEvidence({ bookingId: BOOKING_ID }),
    ).rejects.toThrow(/open booking requests exceeds/);
    expect(checkCapacityMock).not.toHaveBeenCalled();
    expect(evaluatePersistedNonHostingViolationsMock).not.toHaveBeenCalled();
    expect(evaluatePersistedHostingMock).not.toHaveBeenCalled();
    expect(findBookingMemberNightConflictsMock).not.toHaveBeenCalled();
  });

  it("accepts a stay EXACTLY at the ceiling", async () => {
    // The off-by-one that would silently halve an answer: `>` versus `>=` on the
    // ceiling comparison. A 31-night stay is inside the limit and must return all
    // 31 rows, so both sides of the boundary are pinned.
    const nights = nightsBetween("2026-07-10", "2026-08-10");
    expect(nights.length).toBe(AID6B_CAPACITY_NIGHT_CEILING);
    seedBooking({
      checkIn: "2026-07-10",
      checkOut: "2026-08-10",
      guests: [{ id: "guest-1", nights: [NIGHT_ONE] }],
      capacityNights: nights.map((night) => ({ night })),
    });
    const rows = await readBookingCapacityEvidence({ bookingId: BOOKING_ID });
    expect(rows).toHaveLength(AID6B_CAPACITY_NIGHT_CEILING);
  });

  it("reports allocation and capacity as SEPARATE facts", async () => {
    // `allocated_bed_nights` is what the bed-allocation board has assigned, not
    // what the lodge can hold. A booking that fits with zero allocations is
    // completely ordinary — beds are assigned later — and reading a zero here as
    // "no room" would invert the answer. The first night has two allocations, the
    // second none, and both nights fit.
    seedBooking({
      allocatedNights: [NIGHT_ONE, NIGHT_ONE],
      capacityNights: [{ night: NIGHT_ONE }, { night: NIGHT_TWO }],
    });
    const rows = (await readBookingCapacityEvidence({
      bookingId: BOOKING_ID,
    })) as unknown as Row[];
    expect(rows[0].allocated_bed_nights).toBe(2);
    expect(rows[1].allocated_bed_nights).toBe(0);
    for (const row of rows) {
      expect(row.fits_this_night).toBe(true);
      expect(row.available_beds_excluding_this_booking).toBe(8);
      expect(row.party_beds_this_night).toBe(2);
      expect(row.spare_beds_after_this_booking).toBe(6);
    }
    // And the decoy booking's four allocations, on these same two nights, are not
    // in either figure.
    expect(store.bedAllocation.filter((row) => row.bookingId === DECOY_BOOKING_ID))
      .toHaveLength(4);
  });

  it("bounds allocation rows to this booking, its stay and its own guests", async () => {
    seedBooking({ allocatedNights: [NIGHT_ONE] });
    store.bedAllocation.push(
      {
        id: "outside-stay",
        bookingId: BOOKING_ID,
        bookingGuestId: "guest-1",
        stayDate: day("2026-07-20"),
      },
      {
        id: "foreign-guest",
        bookingId: BOOKING_ID,
        bookingGuestId: "decoy-guest-0",
        stayDate: day(NIGHT_ONE),
      },
    );

    const rows = (await readBookingCapacityEvidence({
      bookingId: BOOKING_ID,
    })) as unknown as Row[];
    expect(rows[0].allocated_bed_nights).toBe(1);
    expect(rows[1].allocated_bed_nights).toBe(0);
    expect(prismaMock.bedAllocation.findMany).toHaveBeenCalledWith({
      where: {
        bookingId: BOOKING_ID,
        stayDate: { gte: day(CHECK_IN), lt: day(CHECK_OUT) },
        bookingGuest: { is: { bookingId: BOOKING_ID } },
      },
      select: { stayDate: true },
      orderBy: [{ stayDate: "asc" }, { id: "asc" }],
      take:
        AID6B_BOOKING_GUEST_CEILING * AID6B_CAPACITY_NIGHT_CEILING + 1,
    });
    expect(prismaMock.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        isolationLevel: "RepeatableRead",
        timeout: DIAGNOSTICS_READ_ONLY_TRANSACTION_TIMEOUT_MS,
      }),
    );
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);
    expect(prismaMock.$executeRaw.mock.calls[0]?.[0]?.[0]).toBe(
      "SET TRANSACTION READ ONLY",
    );
    expect(prismaMock.$executeRaw.mock.calls[1]?.[1]).toBe(
      String(DIAGNOSTICS_READ_ONLY_STATEMENT_TIMEOUT_MS),
    );
  });

  it("refuses a corrupt in-envelope allocation population above the ceiling", async () => {
    seedBooking();
    const ceiling =
      AID6B_BOOKING_GUEST_CEILING * AID6B_CAPACITY_NIGHT_CEILING;
    store.bedAllocation.push(
      ...Array.from({ length: ceiling + 1 }, (_, index) => ({
        id: `corrupt-allocation-${index}`,
        bookingId: BOOKING_ID,
        bookingGuestId: "guest-1",
        stayDate: day(NIGHT_ONE),
      })),
    );

    await expect(
      readBookingCapacityEvidence({ bookingId: BOOKING_ID }),
    ).rejects.toThrow(/in-envelope booking bed allocations exceeds/);
  });

  it("reports the admin over-capacity override as its own fact", async () => {
    seedBooking({ capacityOverriddenAt: new Date("2026-06-30T00:00:00.000Z") });
    const rows = (await readBookingCapacityEvidence({
      bookingId: BOOKING_ID,
    })) as unknown as Row[];
    expect(rows[0].capacity_overridden).toBe(true);
  });

  it("passes a NEGATIVE bed count through on an over-capacity night", async () => {
    // THE FIXTURE THIS SUITE DID NOT HAVE. Every capacity fixture in this file
    // used `spec.available ?? 8` and none of them was negative, so the one case
    // where `availableBeds` is signed was never produced at all.
    //
    // `checkCapacity` computes `lodgeCapacity - occupiedBeds` and does NOT clamp
    // it, deliberately: a negative value is what puts a night into the
    // over-capacity confirm set (`capacity.ts`, ADR-001 decision 5). It happens on
    // an admin over-capacity confirmation (#1668) and on a custodian bed hold
    // taken against a night already full — which is why this entry projects
    // `capacityOverridden` on every row. Three beds over with a party of four is
    // seven beds short after this booking, and every figure on the row has to say
    // so consistently: the clamped version handed the model "0 available, 4
    // needed, -7 spare", where the subtraction the scope line asks for gives -4.
    seedBooking({
      capacityOverriddenAt: new Date("2026-06-30T00:00:00.000Z"),
      capacityNights: [
        { night: NIGHT_ONE, occupied: 23, available: -3 },
        { night: NIGHT_TWO, occupied: 12, available: 8 },
      ],
    });
    const rows = (await readBookingCapacityEvidence({
      bookingId: BOOKING_ID,
    })) as unknown as Row[];

    const over = rows[0];
    expect(over.available_beds_excluding_this_booking).toBe(-3);
    expect(over.party_beds_this_night).toBe(2);
    expect(over.spare_beds_after_this_booking).toBe(-5);
    // The identity the entry's scope line asks the model to compute, on the row.
    expect(
      Number(over.available_beds_excluding_this_booking) -
        Number(over.party_beds_this_night),
    ).toBe(over.spare_beds_after_this_booking);
    expect(over.fits_this_night).toBe(false);
    // Not a held night: the lodge is genuinely over, which is a different fact
    // from the pinned zero of an exclusive hold and must not be reported as one.
    expect(over.whole_lodge_held_by_another_booking).toBe(false);
    expect(over.occupied_beds_excluding_this_booking).toBe(23);
    expect(over.capacity_overridden).toBe(true);

    // …and the ordinary night beside it is unaffected.
    expect(rows[1].available_beds_excluding_this_booking).toBe(8);
    expect(rows[1].spare_beds_after_this_booking).toBe(6);
    expect(rows[1].fits_this_night).toBe(true);
  });

  it("carries the same negative night into booking_block_state's shortfall", async () => {
    // The two entries answer the same question about the same night and must
    // agree. `tightestSpareBeds` was signed from the start, so an over-capacity
    // night that read "exactly full" on the per-night entry and "-5" here was the
    // shape of the contradiction: one tool said the lodge was full, the other said
    // it was five beds short, and neither reader could tell which to believe.
    seedBooking({
      capacityNights: [
        { night: NIGHT_ONE, occupied: 23, available: -3 },
        { night: NIGHT_TWO, occupied: 12, available: 8 },
      ],
    });
    const row = await blockStateRow();
    expect(row.tightest_spare_beds).toBe(-5);
    expect(row.shortfall_night_count).toBe(1);
    expect(blockers(row)).toContain("capacity_exceeded");
  });

  it("emits nights as NZ date-only lodge nights, never as instants", async () => {
    seedBooking();
    const rows = (await readBookingCapacityEvidence({
      bookingId: BOOKING_ID,
    })) as unknown as Row[];
    expect(rows.map((row) => row.night)).toEqual([NIGHT_ONE, NIGHT_TWO]);
    for (const row of rows) {
      expect(String(row.night)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. member_eligibility_state — the erasure test.
// ---------------------------------------------------------------------------

describe("member eligibility: the erasure disjunction (#2376)", () => {
  it("detects a member matching ONLY the anonymised-email half", async () => {
    // An approved deletion anonymises the member IN PLACE: `active` goes false and
    // NEITHER `cancelledAt` NOR `archivedAt` is stamped. A three-column lifecycle
    // read therefore reports an ERASED member as merely "Inactive" — and an
    // officer told a member is inactive will try to reactivate them, handing the
    // erased person their session and their retained roles back.
    seedMember({
      email: "deleted-12ab34cd@deleted.invalid",
      passwordHash: "$2b$12$aStillOrdinaryHash",
      active: false,
    });
    const row = await eligibilityRow();
    expect(row.member_erased).toBe(true);
    expect(row.lifecycle_label).toBe("Deleted");
    // `member_inactive` is deliberately NOT also raised: it fires only when
    // nothing more specific explains the inactivity, so the list reads as one
    // problem rather than two.
    expect(eligibilityCodes(row)).toEqual(["member_erased"]);
  });

  it("detects a member matching ONLY the sentinel-password-hash half", async () => {
    // The other arm, and the one that cannot be reached by reading columns into
    // JavaScript. An account erased BEFORE the address rewrite carries the
    // sentinel hash and an ordinary-looking address; an email-only test is
    // silently incomplete for it and reports the account as a live member.
    seedMember({
      email: "ordinary.member@example.test",
      passwordHash: DELETED_ACCOUNT_PASSWORD_HASH,
      active: false,
    });
    const row = await eligibilityRow();
    expect(row.member_erased).toBe(true);
    expect(row.lifecycle_label).toBe("Deleted");
    expect(eligibilityCodes(row)).toEqual(["member_erased"]);
  });

  it("does not call an ORDINARY member erased", async () => {
    // The decoy member carries BOTH markers. If the `count` predicate lost its
    // `id` — a one-word edit — this ordinary member would be reported as erased,
    // and an officer would be told a live member's account had been deleted.
    seedMember({});
    const row = await eligibilityRow();
    expect(row.member_erased).toBe(false);
    expect(row.lifecycle_label).toBe("Active");
    expect(eligibilityCodes(row)).toEqual([]);
  });

  it("runs the hash comparison INSIDE Postgres and never selects passwordHash", async () => {
    // The one place in either tool pack where a credential column is used as a
    // PREDICATE rather than a projection. Only a boolean crosses the boundary: no
    // member's real hash is loaded, logged, hashed into an audit row or projected.
    // Asserted on the arguments the double was handed, because that is the only
    // place the distinction is visible — a `select` that named `passwordHash`
    // would produce an identical-looking row.
    seedMember({ passwordHash: DELETED_ACCOUNT_PASSWORD_HASH, active: false });
    const row = await eligibilityRow();

    const select = prismaMock.member.findUnique.mock.calls[0]?.[0]?.select as Row;
    expect(select).toBeDefined();
    expect(Object.keys(select)).not.toContain("passwordHash");
    expect(Object.keys(select)).not.toContain("totpSecret");
    expect(Object.keys(select)).not.toContain("dateOfBirth");
    expect(Object.keys(select)).not.toContain("comments");

    // The count is scoped to THIS member and compares against the sentinel the
    // server itself writes — not against anything read out of a row.
    const countArgs = prismaMock.member.count.mock.calls[0]?.[0] as {
      where?: Row;
      select?: Row;
    };
    expect(countArgs.where).toEqual({
      id: MEMBER_ID,
      passwordHash: DELETED_ACCOUNT_PASSWORD_HASH,
    });
    expect(countArgs.select).toBeUndefined();

    // And nothing resembling a credential, or the email that was read as an
    // input, reaches the emitted row.
    for (const value of Object.values(row)) {
      if (typeof value !== "string") continue;
      expect(value).not.toContain(DELETED_ACCOUNT_PASSWORD_HASH);
      expect(value).not.toContain("@");
    }
  });

  it("returns NO rows for a member that does not exist", async () => {
    seedMember({ missing: true });
    await expect(
      readMemberEligibilityEvidence({ memberId: MEMBER_ID }),
    ).resolves.toEqual([]);
  });

  it("REJECTS rather than returning a partial row when the lockout mode read fails", async () => {
    seedMember({});
    peekSubscriptionLockoutModeMock.mockRejectedValueOnce(
      new Error("settings unavailable"),
    );
    await expect(
      readMemberEligibilityEvidence({ memberId: MEMBER_ID }),
    ).rejects.toThrow();
  });

  it("REJECTS rather than returning a partial row when the erasure count fails", async () => {
    seedMember({});
    prismaMock.member.count.mockRejectedValueOnce(new Error("database unreachable"));
    await expect(
      readMemberEligibilityEvidence({ memberId: MEMBER_ID }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. member_eligibility_state — the code catalogue.
// ---------------------------------------------------------------------------

/**
 * ONE FIXTURE PER ELIGIBILITY CODE, same discipline as the blocker table.
 *
 * The lifecycle fixtures are written the way anonymisation and archival really
 * write them — `active: false` alongside the outer marker — which is also what
 * makes them a test of the `member_inactive` carve-out: it fires only when
 * nothing more specific explains the inactivity, so the list reads as one problem
 * rather than two.
 */
const ELIGIBILITY_FIXTURES: [string, MemberScenario, string[]][] = [
  [
    "member_erased",
    { email: "deleted-99887766@deleted.invalid", active: false },
    ["member_erased"],
  ],
  ["member_archived", { archivedAt: day("2026-03-01"), active: false }, ["member_archived"]],
  ["member_cancelled", { cancelledAt: day("2026-04-01"), active: false }, ["member_cancelled"]],
  ["member_inactive", { active: false }, ["member_inactive"]],
  [
    "membership_type_blocks_booking",
    { bookingBehavior: "BLOCK_BOOKING" },
    ["membership_type_blocks_booking"],
  ],
  [
    "subscription_unpaid",
    { subscriptionBehavior: "REQUIRED", subscription: { status: "UNPAID" } },
    ["subscription_unpaid"],
  ],
  ["not_adult_age_tier", { ageTier: "YOUTH" }, ["not_adult_age_tier"]],
  ["cannot_log_in", { canLogin: false }, ["cannot_log_in"]],
  [
    "induction_outstanding",
    { requiresInduction: true, inductionStatus: "IN_PROGRESS" },
    ["induction_outstanding"],
  ],
];

describe("member eligibility: every code, ranked (#2376)", () => {
  it("has a fixture for every code in the catalogue", () => {
    expect(ELIGIBILITY_FIXTURES.map(([code]) => code)).toEqual([
      ...MEMBER_ELIGIBILITY_CODES,
    ]);
  });

  it.each(ELIGIBILITY_FIXTURES)(
    "raises %s as the PRIMARY code, and emits exactly the expected list",
    async (code, scenario, expected) => {
      seedMember(scenario);
      const row = await eligibilityRow();
      expect(eligibilityCodes(row)).toEqual(expected);
      expect(eligibilityCodes(row)[0]).toBe(expected[0]);
      expect(eligibilityCodes(row)).toContain(code);
      expect(row.eligibility_code_count).toBe(expected.length);
    },
  );

  it("ranks archived ABOVE cancelled, matching the lifecycle badge an officer sees", async () => {
    // The order matches `getLifecycleStatusConfig`'s own precedence exactly,
    // because a diagnostic that ranked them differently from the badge on the
    // screen would be describing a different member.
    seedMember({
      archivedAt: day("2026-03-01"),
      cancelledAt: day("2026-04-01"),
      active: false,
    });
    const row = await eligibilityRow();
    expect(eligibilityCodes(row)).toEqual(["member_archived", "member_cancelled"]);
    expect(row.lifecycle_label).toBe("Archived");
  });

  it("emits eight simultaneous codes in the declared priority order", async () => {
    // Every code except `member_inactive`, which is structurally excluded here:
    // it fires only when nothing more specific explains the inactivity, and this
    // member is erased, archived and cancelled at once. The exclusion is the
    // point — a list reading "erased, archived, cancelled, inactive" would present
    // four problems where there is one account.
    seedMember({
      email: "deleted-55443322@deleted.invalid",
      archivedAt: day("2026-03-01"),
      cancelledAt: day("2026-04-01"),
      active: false,
      canLogin: false,
      ageTier: "YOUTH",
      bookingBehavior: "BLOCK_BOOKING",
      subscriptionBehavior: "REQUIRED",
      subscription: { status: "UNPAID" },
      requiresInduction: true,
      inductionStatus: "IN_PROGRESS",
    });
    const row = await eligibilityRow();
    expect(eligibilityCodes(row)).toEqual([
      "member_erased",
      "member_archived",
      "member_cancelled",
      "membership_type_blocks_booking",
      "subscription_unpaid",
      "not_adult_age_tier",
      "cannot_log_in",
      "induction_outstanding",
    ]);
    expect(row.eligibility_code_count).toBe(8);
  });

  it("emits the inactive variant in order when nothing outranks it", async () => {
    // The complement of the fixture above: the same six trailing codes with
    // `member_inactive` in fourth place, which is where the catalogue puts it.
    seedMember({
      active: false,
      canLogin: false,
      ageTier: "YOUTH",
      bookingBehavior: "BLOCK_BOOKING",
      subscriptionBehavior: "REQUIRED",
      subscription: { status: "UNPAID" },
      requiresInduction: true,
    });
    const row = await eligibilityRow();
    expect(eligibilityCodes(row)).toEqual([
      "member_inactive",
      "membership_type_blocks_booking",
      "subscription_unpaid",
      "not_adult_age_tier",
      "cannot_log_in",
      "induction_outstanding",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 8. member_eligibility_state — subscriptions, induction and the host predicate.
// ---------------------------------------------------------------------------

describe("member eligibility: three different subscription facts (#2376)", () => {
  it("distinguishes NO season row from a row nobody billed from a row that is owed", async () => {
    // `null`, `NOT_INVOICED` and `UNPAID` are three different states and the
    // operator's next step differs for each: raise the invoice, chase the invoice,
    // or take the payment. Collapsing "no row" into `NOT_INVOICED` — the natural
    // shortcut, since both mean nobody has been billed — would hide the club's own
    // failure to issue the invoice behind a stored state that says it decided not
    // to. The CONSEQUENCE is the same for all three, which is exactly why the
    // fact has to be reported separately from it.
    const seen: (string | null)[] = [];
    for (const subscription of [
      null,
      { status: "NOT_INVOICED" },
      { status: "UNPAID" },
    ] as const) {
      store = emptyStore();
      seedDecoys();
      seedMember({ subscriptionBehavior: "REQUIRED", subscription });
      const row = await eligibilityRow();
      seen.push(row.subscription_status as string | null);
      expect(row.subscription_required, String(subscription?.status)).toBe(true);
      expect(row.subscription_paid, String(subscription?.status)).toBe(false);
      expect(row.subscription_unpaid, String(subscription?.status)).toBe(true);
    }
    expect(seen).toEqual([null, "NOT_INVOICED", "UNPAID"]);
    // The decoy member's own UNPAID 2026 row is never one of these — the compound
    // `memberId_seasonYear` unique is applied, not just the season.
    expect(seen[0]).toBeNull();
  });

  it("reads the settlement from the membership TYPE, not from the season row", async () => {
    // `subscription_required` comes from the membership type's subscription
    // behaviour and the age-tier rule; the row only ever answers "was it paid".
    // A `NOT_REQUIRED` type owes nothing even with an UNPAID row sitting there —
    // and reading the row instead would dun a life member for a subscription the
    // club has already decided they do not pay.
    seedMember({
      subscriptionBehavior: "NOT_REQUIRED",
      subscription: { status: "UNPAID" },
    });
    const row = await eligibilityRow();
    expect(row.membership_subscription_behavior).toBe("NOT_REQUIRED");
    expect(row.subscription_status).toBe("UNPAID");
    expect(row.subscription_required).toBe(false);
    expect(row.subscription_unpaid).toBe(false);
    expect(eligibilityCodes(row)).toEqual([]);
  });

  it("honours the age-tier rule for a BASED_ON_AGE_TIER type", async () => {
    // The age-tier settings say ADULT owes and CHILD does not, so the same
    // membership type produces two different answers for two members. This is the
    // half of the rule that is NOT on the type row, and reading only the type
    // would charge a child member a subscription they are exempt from.
    seedMember({
      subscriptionBehavior: "BASED_ON_AGE_TIER",
      ageTier: "ADULT",
      subscription: { status: "UNPAID" },
    });
    const adult = await eligibilityRow();
    expect(adult.subscription_required).toBe(true);
    expect(adult.subscription_unpaid).toBe(true);

    store = emptyStore();
    seedDecoys();
    seedMember({
      subscriptionBehavior: "BASED_ON_AGE_TIER",
      ageTier: "CHILD",
      subscription: { status: "UNPAID" },
    });
    const child = await eligibilityRow();
    expect(child.subscription_required).toBe(false);
    expect(child.subscription_unpaid).toBe(false);
    expect(eligibilityCodes(child)).toEqual(["not_adult_age_tier"]);
  });

  it("lets a NOT_REQUIRED season row dominate a mid-season age promotion", async () => {
    // #2041 decision Q4, scoped to BASED_ON_AGE_TIER: the row is authoritative for
    // a tier-exempt member and survives their promotion to ADULT mid-season.
    // Re-deriving this from the age tier alone would invoice a member the club has
    // already decided is exempt for the year.
    seedMember({
      subscriptionBehavior: "BASED_ON_AGE_TIER",
      ageTier: "ADULT",
      subscription: { status: "NOT_REQUIRED" },
    });
    const row = await eligibilityRow();
    expect(row.subscription_status).toBe("NOT_REQUIRED");
    expect(row.subscription_required).toBe(false);
    expect(row.subscription_unpaid).toBe(false);
    expect(eligibilityCodes(row)).toEqual([]);
  });

  it("reports a PAID row as paid, with the payment facts beside it", async () => {
    seedMember({
      subscriptionBehavior: "REQUIRED",
      subscription: {
        status: "PAID",
        paidAt: new Date("2026-02-14T03:04:05.000Z"),
        manuallyMarkedPaidAt: new Date("2026-02-14T03:04:05.000Z"),
      },
    });
    const row = await eligibilityRow();
    expect(row.subscription_required).toBe(true);
    expect(row.subscription_paid).toBe(true);
    expect(row.subscription_unpaid).toBe(false);
    expect(row.subscription_paid_at_utc).toBe("2026-02-14T03:04:05.000Z");
    expect(row.subscription_manually_marked_paid).toBe(true);
    expect(eligibilityCodes(row)).toEqual([]);
  });

  it("reports the club's LOCKOUT MODE beside the unpaid fact, never instead of it", async () => {
    // The fact and the policy are deliberately separate: the same unpaid row
    // hard-blocks at one club and merely reprices at the next. A diagnostic that
    // reported only the consequence would be unusable at the other club.
    for (const mode of ["HARD_BLOCK", "NON_MEMBER_PRICING", "NO_BLOCK"] as const) {
      store = emptyStore();
      seedDecoys();
      seedMember({
        subscriptionBehavior: "REQUIRED",
        subscription: { status: "UNPAID" },
        lockoutMode: mode,
      });
      const row = await eligibilityRow();
      expect(row.subscription_lockout_mode, mode).toBe(mode);
      expect(row.subscription_unpaid, mode).toBe(true);
      expect(eligibilityCodes(row), mode).toEqual(["subscription_unpaid"]);
    }
  });

  it("treats an unresolved membership type as null rather than guessing one", async () => {
    seedMember({ noTypePolicy: true });
    const row = await eligibilityRow();
    expect(row.membership_type_key).toBeNull();
    expect(row.membership_type_source).toBeNull();
    expect(row.membership_booking_behavior).toBeNull();
    expect(row.membership_subscription_behavior).toBeNull();
    // With no behaviour resolved the age-tier rule decides, and this ADULT owes.
    expect(row.subscription_required).toBe(true);
    expect(eligibilityCodes(row)).toEqual(["subscription_unpaid"]);
  });

  it("resolves the membership type for the CURRENT season year", async () => {
    // Pinned explicitly rather than leaning on the file's default instant, so the
    // assertion says which July it means and the rollover canary cannot turn a
    // correct implementation red by winding the machine clock forward a year.
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    seedMember({});
    const row = await eligibilityRow();
    expect(row.season_year).toBe(2026);
    expect(resolveMembershipTypePolicyForMemberMock).toHaveBeenCalledWith(
      expect.anything(),
      { memberId: MEMBER_ID, seasonYear: 2026 },
    );
    const subscriptionArgs = prismaMock.memberSubscription.findUnique.mock
      .calls[0]?.[0] as { where?: Row };
    expect(subscriptionArgs.where).toEqual({
      memberId_seasonYear: { memberId: MEMBER_ID, seasonYear: 2026 },
    });
  });
});

// ---------------------------------------------------------------------------
// 8a. member_eligibility_state — the SEASON year is not the calendar year.
// ---------------------------------------------------------------------------

describe("member eligibility: the season year is the SEASON's, not the calendar's (#2376)", () => {
  // Every test here pins its own instant. The root re-freeze only ever converts a
  // REAL clock back to the frozen one, so a pin made here would outlive the
  // describe if it were not undone; this hands the file's default instant back.
  afterEach(() => {
    __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
    vi.setSystemTime(frozenTestNow());
  });

  it("reports a paid-up member as PAID in January, when the calendar year has moved on and the season has not", async () => {
    // THE FIXTURE THE SUITE DID NOT HAVE, and the reason a blocker survived it.
    // This entry derived the season year as `new Date().getUTCFullYear()`, which
    // is right for nine months of every year. The season starts on the first of
    // the month AFTER the club's financial year-end — April, for the NZ 31-March
    // convention — so through January, February and March the season year is the
    // PREVIOUS calendar year, and the whole suite ran at 1 July, where the two
    // agree.
    //
    // Everything below is one member: an ADULT whose type REQUIRES a subscription
    // and who has PAID it for the 2026 season. On 15 January 2027 the wrong
    // derivation asks for season 2027 — `resolveMembershipTypePolicyForMember`
    // finds no assignment, the `memberId_seasonYear` lookup misses the row, and
    // the settlement rule concludes an unpaid subscription. That is a false and
    // directly actionable finding about a fully paid-up member, delivered to a
    // Finance or Membership officer through a language model, and it is what these
    // assertions now fail on.
    vi.setSystemTime(new Date("2027-01-15T00:00:00.000Z"));
    seedMember({
      subscriptionBehavior: "REQUIRED",
      subscription: {
        status: "PAID",
        paidAt: new Date("2026-05-02T03:04:05.000Z"),
      },
    });

    const row = await eligibilityRow();

    // The season year itself, projected to the model.
    expect(row.season_year).toBe(2026);
    // …and the two reads it keys, which is where the damage happened.
    expect(resolveMembershipTypePolicyForMemberMock).toHaveBeenCalledWith(
      expect.anything(),
      { memberId: MEMBER_ID, seasonYear: 2026 },
    );
    const subscriptionArgs = prismaMock.memberSubscription.findUnique.mock
      .calls[0]?.[0] as { where?: Row };
    expect(subscriptionArgs.where).toEqual({
      memberId_seasonYear: { memberId: MEMBER_ID, seasonYear: 2026 },
    });

    // The member's actual standing: paid, settled, no finding.
    expect(row.subscription_status).toBe("PAID");
    expect(row.subscription_required).toBe(true);
    expect(row.subscription_paid).toBe(true);
    expect(row.subscription_unpaid).toBe(false);
    expect(row.subscription_paid_at_utc).toBe("2026-05-02T03:04:05.000Z");
    expect(eligibilityCodes(row)).toEqual([]);
    // The knock-on the wrong year also caused: `participantQualifiesAsHost` is
    // called with `subscriptionSettled: !unpaid`, so a phantom unpaid subscription
    // disqualified the member as an adult-member host too.
    expect(row.qualifies_as_adult_member_host).toBe(true);
    // And the membership type resolved from a real assignment rather than falling
    // back — the scope line tells the model that a fallback source means NO
    // assignment exists for this season.
    expect(row.membership_type_key).toBe("FULL");
    expect(row.membership_type_source).toBe("assignment");
  });

  it.each([
    ["the last night of the calendar year, 2026-12-31, in season 2026", "2026-12-31T11:00:00.000Z", 2026],
    ["New Year's Day 2027 in season 2026", "2027-01-01T00:00:00.000Z", 2026],
    ["the eve of the new season, 2027-03-31, in season 2026", "2027-03-31T00:00:00.000Z", 2026],
    ["the first day of the new season, 2027-04-01, in season 2027", "2027-04-01T00:00:00.000Z", 2027],
  ] as const)(
    "puts %s",
    async (_label, instant, expected) => {
      // The boundary, both sides of it, with the season year written out rather
      // than derived — a test that computed the expectation with the same helper
      // the source uses would pass for any helper at all.
      vi.setSystemTime(new Date(instant));
      seedMember({});
      const row = await eligibilityRow();
      expect(row.season_year).toBe(expected);
    },
  );

  it("answers from the CLUB's calendar day, not the UTC one", async () => {
    /*
      THE ZONE AXIS, WHICH THIS SUITE WAS BLIND TO (#2870, review round 2).

      Every other instant this file pins puts the club's day and the UTC day on the
      SAME side of a season edge, so an implementation that ignored its `zone`
      argument and read the encoding in UTC answered identically — measured, 0 of
      184 tests failed under exactly that mutation. Worse, UTC is what the CI runner
      resolves, so no host pin closes it either. It is the mirror of the host-axis
      blindness this lane found on the billing path, and it needs the same remedy:
      an instant where the two genuinely differ.

      At 13:00Z on 31 March, a club at UTC+13 is already on 1 April — the first day
      of season 2027 — while UTC is still on 31 March, the last day of season 2026.
      A UTC read answers 2026 and fails here.
    */
    vi.setSystemTime(new Date("2027-03-31T13:00:00.000Z"));
    seedMember({});
    const row = await eligibilityRow();
    expect(row.season_year).toBe(2027);
  });

  it("refuses rather than guessing when the club's timezone is not stored", async () => {
    // The same discipline `requireStoredYearEndMonth` applies to the other half of
    // this derivation. Guessing a zone would report a member's subscription state
    // for a season that is not the club's, with an observed-at stamp that makes it
    // look freshly measured; the executor renders this rejection as
    // `evidence_unavailable` (#2870).
    prismaMock.clubTimeSettings.findUnique.mockResolvedValue(null);
    seedMember({});
    await expect(eligibilityRow()).rejects.toThrow(
      /club's timezone is not stored locally/,
    );
  });

  it("moves the boundary with the CLUB's financial year-end rather than assuming April", async () => {
    // The assertion that separates "calls the platform's helper" from "hard-codes
    // the NZ default". The season derivation reads `getSeasonStartMonth()`, which is the
    // month after the club's configured `financialYearEndMonth`; a club on a
    // December year-end starts its season in January, so the same January instant
    // belongs to the NEW season year there. A local re-derivation would have to
    // reach for the same configuration to agree, and the point of using the shared
    // helper is that it cannot fail to.
    __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
    prismaMock.membershipLockoutSettings.findUnique.mockResolvedValue({
      financialYearEndMonthOverride: 12,
    });
    vi.setSystemTime(new Date("2027-01-15T00:00:00.000Z"));
    seedMember({});
    const row = await eligibilityRow();
    expect(row.season_year).toBe(2027);
  });

  it("uses March only when stored state proves there is no connected Xero tenant", async () => {
    vi.setSystemTime(new Date("2027-01-15T00:00:00.000Z"));
    prismaMock.membershipLockoutSettings.findUnique.mockResolvedValue({
      financialYearEndMonthOverride: null,
    });
    prismaMock.xeroToken.findFirst.mockResolvedValue(null);
    seedMember({});
    await expect(eligibilityRow()).resolves.toMatchObject({ season_year: 2026 });
  });

  it("propagates a rejected persisted-settings read instead of inventing defaults", async () => {
    vi.setSystemTime(new Date("2027-01-15T00:00:00.000Z"));
    prismaMock.membershipLockoutSettings.findUnique.mockRejectedValueOnce(
      new Error("settings database unavailable"),
    );
    seedMember({});

    await expect(
      readMemberEligibilityEvidence({ memberId: MEMBER_ID }),
    ).rejects.toThrow("settings database unavailable");
    expect(prismaMock.xeroToken.findFirst).not.toHaveBeenCalled();
    expect(resolveMembershipTypePolicyForMemberMock).not.toHaveBeenCalled();
  });

  it("refuses to guess the season from a cold cache when Xero is connected", async () => {
    vi.setSystemTime(new Date("2027-01-15T00:00:00.000Z"));
    prismaMock.membershipLockoutSettings.findUnique.mockResolvedValue({
      financialYearEndMonthOverride: null,
    });
    prismaMock.xeroToken.findFirst.mockResolvedValue({ id: "xero-token" });
    seedMember({});
    await expect(
      readMemberEligibilityEvidence({ memberId: MEMBER_ID }),
    ).rejects.toThrow(/not stored locally/);
    expect(resolveMembershipTypePolicyForMemberMock).not.toHaveBeenCalled();
  });

  it("canonicalises an invalid stored override to absent and refuses when Xero is connected", async () => {
    vi.setSystemTime(new Date("2027-01-15T00:00:00.000Z"));
    prismaMock.membershipLockoutSettings.findUnique.mockResolvedValue({
      financialYearEndMonthOverride: 13,
    });
    prismaMock.xeroToken.findFirst.mockResolvedValue({ id: "xero-token" });
    seedMember({});
    await expect(
      readMemberEligibilityEvidence({ memberId: MEMBER_ID }),
    ).rejects.toThrow(/not stored locally/);
    expect(resolveMembershipTypePolicyForMemberMock).not.toHaveBeenCalled();
  });

  it("uses the canonical default for an invalid stored override with no Xero tenant", async () => {
    vi.setSystemTime(new Date("2027-01-15T00:00:00.000Z"));
    prismaMock.membershipLockoutSettings.findUnique.mockResolvedValue({
      financialYearEndMonthOverride: 13,
    });
    prismaMock.xeroToken.findFirst.mockResolvedValue(null);
    seedMember({});
    await expect(eligibilityRow()).resolves.toMatchObject({ season_year: 2026 });
  });
});

// ---------------------------------------------------------------------------
// 8b. booking_block_state — the season the subscription rules are judged in.
// ---------------------------------------------------------------------------

describe("booking block state: the season comes from STORED state, not the process cache (#2376)", () => {
  /**
   * A CHECK-IN INSIDE THE THREE MONTHS WHERE THE ANSWER DEPENDS ON THE CLUB.
   *
   * February 2027. On the NZ 31-March convention the season starts in April, so
   * these nights belong to season 2026. On a December year-end the season starts in
   * January, so the SAME nights belong to season 2027. One fixture, two correct
   * answers, and which one is right is a stored setting — which is exactly why the
   * two rules that read `MemberSubscription` by `(memberId, seasonYear)` may not
   * take it from whatever this process happens to have cached.
   */
  const SEASON_BOUNDARY_CHECK_IN = "2027-02-10";
  const SEASON_BOUNDARY_CHECK_OUT = "2027-02-12";

  function seedSeasonBoundaryBooking(scenario: BookingScenario = {}): void {
    seedBooking({
      checkIn: SEASON_BOUNDARY_CHECK_IN,
      checkOut: SEASON_BOUNDARY_CHECK_OUT,
      ...scenario,
    });
  }

  /** The options each evaluator was actually handed. */
  function optionsPassed(): {
    nonHosting: { seasonYear?: number; subscriptionLockoutMode?: string } | undefined;
    hosting: { seasonYear?: number; subscriptionLockoutMode?: string } | undefined;
  } {
    const nonHostingArgs = evaluatePersistedNonHostingViolationsMock.mock
      .calls[0] as [
      unknown,
      unknown,
      unknown,
      unknown,
      { seasonYear?: number; subscriptionLockoutMode?: string }?,
    ];
    const hostingArgs = evaluatePersistedHostingMock.mock.calls[0] as [
      unknown,
      unknown,
      { seasonYear?: number; subscriptionLockoutMode?: string }?,
    ];
    return { nonHosting: nonHostingArgs?.[4], hosting: hostingArgs?.[2] };
  }

  /** The season each evaluator was actually handed. */
  function seasonsPassed(): { nonHosting: unknown; hosting: unknown } {
    const passed = optionsPassed();
    return {
      nonHosting: passed.nonHosting?.seasonYear,
      hosting: passed.hosting?.seasonYear,
    };
  }

  afterEach(() => {
    __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
  });

  it("hands both subscription-sensitive rules the season of the CHECK-IN night", async () => {
    // Not the season the diagnostic runs in. The suite's frozen instant is July
    // 2026 (season 2026 under the default year-end) and these nights are in
    // February 2027 (also season 2026 under it) — so this arm alone cannot tell the
    // two apart. The next one can, which is why both exist.
    seedSeasonBoundaryBooking();
    await blockStateRow();
    expect(seasonsPassed()).toEqual({ nonHosting: 2026, hosting: 2026 });
  });

  it("moves the season with the club's STORED year-end month", async () => {
    // THE MUTATION THIS FIX EXISTS FOR. A December year-end starts the season in
    // January, so the same February nights are season 2027 — and if the season came
    // from the process-level cache (still March here, deliberately left at the
    // default) both rules would look up the wrong year's `MemberSubscription` row
    // and report a paid-up member as unfinancial, or the reverse.
    __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
    prismaMock.membershipLockoutSettings.findUnique.mockResolvedValue({
      financialYearEndMonthOverride: 12,
    });
    seedSeasonBoundaryBooking();
    await blockStateRow();
    expect(seasonsPassed()).toEqual({ nonHosting: 2027, hosting: 2027 });
  });

  it("refuses rather than guessing March when the club follows Xero", async () => {
    // The month lives in Xero and nowhere local, and this pack does not call
    // providers. `evidence_unavailable` is the honest outcome; the alternative is a
    // confident answer computed in a season that may not be this club's.
    prismaMock.membershipLockoutSettings.findUnique.mockResolvedValue({
      financialYearEndMonthOverride: null,
    });
    prismaMock.xeroToken.findFirst.mockResolvedValue({ id: "xero-token" });
    seedSeasonBoundaryBooking();
    await expect(
      readBookingBlockStateEvidence({ bookingId: BOOKING_ID }),
    ).rejects.toThrow(/not stored locally/);
    // AND NEITHER RULE RAN. A refusal that still evaluated the party would have
    // done the wrong-season lookup on the way to reporting itself unavailable.
    expect(evaluatePersistedNonHostingViolationsMock).not.toHaveBeenCalled();
    expect(evaluatePersistedHostingMock).not.toHaveBeenCalled();
  });

  it("propagates a rejected settings read instead of falling back to a default", async () => {
    prismaMock.membershipLockoutSettings.findUnique.mockRejectedValueOnce(
      new Error("settings database unavailable"),
    );
    seedSeasonBoundaryBooking();
    await expect(
      readBookingBlockStateEvidence({ bookingId: BOOKING_ID }),
    ).rejects.toThrow("settings database unavailable");
    expect(evaluatePersistedNonHostingViolationsMock).not.toHaveBeenCalled();
    expect(evaluatePersistedHostingMock).not.toHaveBeenCalled();
  });

  it("uses March only once stored state proves no Xero tenant is connected", async () => {
    prismaMock.membershipLockoutSettings.findUnique.mockResolvedValue({
      financialYearEndMonthOverride: null,
    });
    prismaMock.xeroToken.findFirst.mockResolvedValue(null);
    seedSeasonBoundaryBooking();
    await blockStateRow();
    expect(seasonsPassed()).toEqual({ nonHosting: 2026, hosting: 2026 });
  });

  it.each([
    ["terminal", { status: "CANCELLED" }],
    [
      "deleted",
      {
        status: "CANCELLED",
        deletedAt: new Date("2026-12-20T00:00:00.000Z"),
      },
    ],
  ] satisfies [string, BookingScenario][])(
    "asks for no season at all on a %s booking, so a Xero-following club keeps that evidence",
    async (_label, scenario) => {
      // The reason the resolution is conditional rather than unconditional. A
      // suppressed booking runs neither subscription rule, so demanding a season
      // there would cost a club that follows Xero ALL its block-state evidence
      // about cancelled and deleted bookings — over a question those bookings never
      // ask. The Xero tenant is connected here, which is the arm that refuses on a
      // live booking two tests above.
      prismaMock.membershipLockoutSettings.findUnique.mockResolvedValue({
        financialYearEndMonthOverride: null,
      });
      prismaMock.xeroToken.findFirst.mockResolvedValue({ id: "xero-token" });
      seedSeasonBoundaryBooking(scenario);
      const row = await blockStateRow();
      expect(row.booking_id).toBe(BOOKING_ID);
      expect(prismaMock.membershipLockoutSettings.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.xeroToken.findFirst).not.toHaveBeenCalled();
    },
  );

  // -------------------------------------------------------------------------
  // The club's lockout MODE, on the same terms as the season.
  // -------------------------------------------------------------------------

  it("hands both rules the ONE strictly-read lockout mode", async () => {
    // ONE read, handed to both. Two independent peeks in one invocation can
    // disagree if an administrator saves the settings panel between them, and this
    // row would then report a policy violation judged under one regime beside a
    // hosting answer judged under another.
    seedSeasonBoundaryBooking({ lockoutMode: "NON_MEMBER_PRICING" });
    await blockStateRow();
    expect(peekSubscriptionLockoutModeMock).toHaveBeenCalledTimes(1);
    const passed = optionsPassed();
    expect(passed.nonHosting?.subscriptionLockoutMode).toBe("NON_MEMBER_PRICING");
    expect(passed.hosting?.subscriptionLockoutMode).toBe("NON_MEMBER_PRICING");
  });

  it("REFUSES when the strict mode read fails, rather than judging the party under NO_BLOCK", async () => {
    // The swallowing readers would have answered `NO_BLOCK` here — "this club does
    // not block unfinancial members" — which is a confident statement about the
    // club's own policy that nobody observed, and the qualifier on every
    // subscription finding this row makes.
    peekSubscriptionLockoutModeMock.mockRejectedValueOnce(
      new Error("module settings unavailable"),
    );
    seedSeasonBoundaryBooking();
    await expect(
      readBookingBlockStateEvidence({ bookingId: BOOKING_ID }),
    ).rejects.toThrow("module settings unavailable");
    expect(evaluatePersistedNonHostingViolationsMock).not.toHaveBeenCalled();
    expect(evaluatePersistedHostingMock).not.toHaveBeenCalled();
  });

  it.each([
    ["terminal", { status: "CANCELLED" }],
    [
      "deleted",
      {
        status: "CANCELLED",
        deletedAt: new Date("2026-12-20T00:00:00.000Z"),
      },
    ],
  ] satisfies [string, BookingScenario][])(
    "reads no lockout mode at all on a %s booking",
    async (_label, scenario) => {
      seedSeasonBoundaryBooking(scenario);
      await blockStateRow();
      expect(peekSubscriptionLockoutModeMock).not.toHaveBeenCalled();
    },
  );
});

describe("member eligibility: induction does NOT gate a booking (#2376)", () => {
  it("says so on the row itself, even when the induction is the only finding", async () => {
    // THE MOST USEFUL SENTENCE THIS TOOL CARRIES. #2376 lists induction among the
    // conditions that block a booking. It does not: `MemberInduction` is read by
    // the nomination gate, the member dashboard card and the sign-off surfaces,
    // and no booking-create, booking-modify or capacity path reads it at all.
    // `Member."requiresInduction"` is an administrator's flag, not an enforcement.
    //
    // The code raises `induction_outstanding` and it can be the ONLY code raised,
    // which is precisely why the constant field matters: it is the only thing
    // standing between "the one thing wrong with this member" and a model
    // reporting it as why a booking failed. Reported as it is rather than as one
    // might wish it were — a suppression would hide a real membership warning.
    seedMember({ requiresInduction: true, inductionStatus: "IN_PROGRESS" });
    const row = await eligibilityRow();
    expect(eligibilityCodes(row)).toEqual(["induction_outstanding"]);
    expect(row.induction_gates_booking).toBe(false);
    expect(row.requires_induction).toBe(true);
    expect(row.induction_status).toBe("IN_PROGRESS");
    expect(row.induction_complete).toBe(false);
  });

  it("keeps it LAST in the catalogue, behind every real membership problem", async () => {
    // Ranked ninth of nine. Even where it is raised beside a genuine blocker it
    // can never be the primary one, so the first code an operator reads is always
    // something that actually stops the member.
    seedMember({
      requiresInduction: true,
      inductionStatus: "DRAFT",
      canLogin: false,
      bookingBehavior: "BLOCK_BOOKING",
    });
    const row = await eligibilityRow();
    const codes = eligibilityCodes(row);
    expect(codes[codes.length - 1]).toBe("induction_outstanding");
    expect(codes[0]).toBe("membership_type_blocks_booking");
    expect(row.induction_gates_booking).toBe(false);
  });

  it("says induction_gates_booking is false even for a member with no induction at all", async () => {
    seedMember({});
    const row = await eligibilityRow();
    expect(row.induction_gates_booking).toBe(false);
    expect(row.induction_status).toBeNull();
    expect(row.induction_complete).toBe(false);
    expect(eligibilityCodes(row)).toEqual([]);
  });

  it("reads THIS member's induction and not the decoy's", async () => {
    // `getInductionStatusForMember` runs for real over the store, so its
    // `where: { memberId }` is under test here too. The decoy member has an
    // IN_PROGRESS induction; if the filter were dropped, this member would be
    // reported as mid-induction and — with `requiresInduction` true — as having an
    // outstanding one.
    seedMember({ requiresInduction: true, inductionStatus: "COMPLETED" });
    const row = await eligibilityRow();
    expect(row.induction_status).toBe("COMPLETED");
    expect(row.induction_complete).toBe(true);
    expect(eligibilityCodes(row)).toEqual([]);
  });

  it("reads the induction with a NAMED select and never the whole record", async () => {
    // THE MOST SENSITIVE DATA CLASS THIS PACK TOUCHES, and the one read in this
    // module that did not honour the claim its own header makes. This entry needs
    // exactly one field — the status — and it used to get it from
    // `getInductionForMember`, whose `include` materialises the induction's
    // `finalComments` and `voidedReason`, every sign-off's `comments` and
    // `signerName`, the template's `competencyPrompt`, `notesPrompt` and
    // `legacySourceText`, the assigned signers' names and the inductee's own name
    // — health, safety and competency text, pulled into the diagnostics process on
    // the application's FULL-PRIVILEGE connection.
    //
    // Nothing ever leaked: the projection consumed `.status` and has no field for
    // any of the rest. But that is the argument the nine dropped columns on
    // `BLOCK_STATE_BOOKING_SELECT` already refused — an unused wide read is the
    // same defect as a wide `select`, one field name away from a projected row, in
    // the file whose header calls the named `select` clauses its only boundary.
    seedMember({ requiresInduction: true, inductionStatus: "IN_PROGRESS" });
    await eligibilityRow();
    const args = prismaMock.memberInduction.findFirst.mock.calls[0]?.[0] as {
      select?: Row;
      include?: Row;
      where?: Row;
      orderBy?: Row;
    };
    expect(args).toBeDefined();
    expect(args.include).toBeUndefined();
    expect(Object.keys(args.select ?? {})).toEqual(["status"]);
    // The narrow read is still the SAME record the wide one returned — newest by
    // `createdAt` across every induction kind — so the answer did not change with
    // the projection.
    expect(args.where).toEqual({ memberId: MEMBER_ID });
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });
});

describe("member eligibility: the adult-member-host predicate (#2376)", () => {
  it("applies unpaid settlement to host qualification in NON_MEMBER_PRICING", async () => {
    // `operationallyPresent` and `subscriptionSettled` are both `!== false` tests
    // inside the predicate, so leaving them undefined silently answers "present
    // and settled" for a member whose subscription is unpaid — the false-positive
    // shape this pack exists to avoid. Supplying them explicitly is what makes
    // this assertion able to fail.
    seedMember({
      subscriptionBehavior: "REQUIRED",
      subscription: { status: "UNPAID" },
      lockoutMode: "NON_MEMBER_PRICING",
    });
    const unpaid = await eligibilityRow();
    expect(unpaid.subscription_unpaid).toBe(true);
    expect(unpaid.qualifies_as_adult_member_host).toBe(false);

    store = emptyStore();
    seedDecoys();
    seedMember({
      subscriptionBehavior: "REQUIRED",
      subscription: { status: "PAID" },
    });
    const paid = await eligibilityRow();
    expect(paid.subscription_unpaid).toBe(false);
    expect(paid.qualifies_as_adult_member_host).toBe(true);
  });

  it.each(["NO_BLOCK", "HARD_BLOCK"] as const)(
    "preserves host qualification for an unpaid adult member in %s",
    async (lockoutMode) => {
      seedMember({
        subscriptionBehavior: "REQUIRED",
        subscription: { status: "UNPAID" },
        lockoutMode,
      });
      const row = await eligibilityRow();
      expect(row.subscription_unpaid).toBe(true);
      expect(row.qualifies_as_adult_member_host).toBe(true);
    },
  );

  it.each(["NO_BLOCK", "HARD_BLOCK", "NON_MEMBER_PRICING"] as const)(
    "keeps a paid adult member eligible in %s",
    async (lockoutMode) => {
      seedMember({
        subscriptionBehavior: "REQUIRED",
        subscription: { status: "PAID" },
        lockoutMode,
      });
      expect((await eligibilityRow()).qualifies_as_adult_member_host).toBe(true);
    },
  );

  it.each([
    ["a YOUTH", { ageTier: "YOUTH" }],
    ["an organisation account", { ageTier: "NOT_APPLICABLE" }],
    ["a cancelled member", { cancelledAt: day("2026-04-01"), active: false }],
    ["an archived member", { archivedAt: day("2026-03-01"), active: false }],
    ["an inactive member", { active: false }],
  ])("does not let %s qualify as an adult member host", async (_label, scenario) => {
    seedMember(scenario);
    const row = await eligibilityRow();
    expect(row.qualifies_as_adult_member_host).toBe(false);
  });

  it("emits the member's joined date as an NZ date-only value", async () => {
    seedMember({ joinedDate: day("2020-01-15") });
    const row = await eligibilityRow();
    expect(row.joined_date).toBe("2020-01-15");
    expect(String(row.joined_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("reports a null joined date rather than inventing one", async () => {
    seedMember({ joinedDate: null });
    const row = await eligibilityRow();
    expect(row.joined_date).toBeNull();
  });
});
