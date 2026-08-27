import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * A DATE OF BIRTH THAT NAMES NO REAL DAY IS REFUSED, ATTRIBUTABLY (#3082).
 *
 * ## WHY THIS SUITE EXISTS
 *
 * `MemberApplication.familyMembers` is a `Json` column, so PostgreSQL validates
 * nothing inside it, and the UNAUTHENTICATED `POST /api/applications` used to
 * validate each dependent's date of birth with `/^\d{4}-\d{2}-\d{2}$/` and
 * nothing else. `1990-13-01`, `1990-06-32`, `1990-00-15` and `0000-05-05` were
 * all stored verbatim, and `1990-02-31` was stored and then silently rolled to
 * 3 March by `new Date`.
 *
 * The consequence changed shape twice, and both shapes are bad:
 *
 * - **Before #3082**, `new Date("1990-13-01")` was an Invalid Date, `computeAge`
 *   returned `NaN`, no configured tier matched `NaN`, and
 *   `computeAgeTierWithSettings` fell through to its ADULT default. A wrong price
 *   band, silently, from a value nobody could read as a birthday.
 * - **After #3082**, the same input reaches `requireStoredCalendarDay` and throws
 *   a `RangeError` — inside `approveMemberApplication`'s `prisma.$transaction`.
 *   The admin route only special-cases `MembershipApplicationError`, so the
 *   committee got a bare 500 with no cause, on every retry, and no admin screen
 *   edits a dependent's date on a pending application. A NEW liveness failure,
 *   not a newly surfaced one.
 *
 * ## WHAT IS ASSERTED, AND WHY THE WRITE SIDE IS SEPARATE FROM THE READ SIDE
 *
 * Both halves, because closing one alone leaves the other reachable:
 *
 * - the WRITE paths refuse the value where it arrives, so nothing new can be
 *   stored that later wedges its own approval;
 * - the READ paths refuse to answer for a value already in the database, with a
 *   message naming WHO it belongs to, so an application submitted before this
 *   landed can be rejected deliberately rather than failing mysteriously.
 *
 * `isoDateSchema` in `nomination.ts` — the schema
 * `parseApplicationFamilyMembers` runs over already-stored JSON — is deliberately
 * NOT tightened, and that is asserted here too. Four surfaces run it, including
 * the admin application list and the nominating member's own landing page, and
 * `nominations/[token]/page.tsx`'s docblock states the rule: reading a value must
 * not be able to take a page down whatever was written. Tightening that schema
 * would trade one liveness failure for a worse one.
 *
 * NO ASSERTION ECHOES A DATE OF BIRTH BACK, and one of them checks that the
 * production code does not either: a date of birth is personal information and an
 * error string travels further than the request that produced it.
 */

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    memberApplication: { findUnique: vi.fn() },
    member: { findMany: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/email", () => ({}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroEntranceFeeInvoiceOperation: vi.fn(),
  processQueuedXeroOutboxOperations: vi.fn(),
}));
vi.mock("@/lib/membership-subscription-billing", () => ({
  queueApprovedMembershipSubscriptionCharges: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/induction", () => ({ createMemberInduction: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("bcryptjs", () => ({ hash: vi.fn().mockResolvedValue("hashed") }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
  rateLimiters: { membershipApplication: {} },
}));

import { parseApplicationFamilyMembers } from "@/lib/nomination";
import {
  applicationDateOfBirthDay,
  dependentSubject,
  unreadableDateOfBirthRefusal,
} from "@/lib/member-application-date-of-birth";
import {
  computeApprovalMappingOutcomes,
  type MappingApplicationInput,
} from "@/lib/member-application-mapping";
import type { NormalizedPersonDecision } from "@/lib/member-application-decisions";
import { normalizeAgeTierSettings } from "@/lib/policies/age-tier";
import { POST as submitApplication } from "@/app/api/applications/route";

/**
 * Every spelling that passes `/^\d{4}-\d{2}-\d{2}$/` and names no real day.
 *
 * The last two are the ones a shape check is least likely to be suspected of
 * letting through. `1990-02-31` is the dangerous one: `new Date` answers 3 March
 * rather than refusing, so it becomes a real, plausible, WRONG birthday with
 * nothing to notice. `0000-05-05` is the one that got past the #3082 guard as
 * well — its time is exactly UTC midnight, so the stored-calendar-day
 * precondition accepts it and `requireCalendarDate` throws one call later,
 * because a club calendar date starts at year 1.
 */
const NOT_REAL_DAYS = [
  "1990-13-01",
  "1990-06-32",
  "1990-00-15",
  "1990-02-31",
  "0000-05-05",
];

const DEFAULT_SETTINGS = normalizeAgeTierSettings([]);
const FULL_ADMIN = { id: "admin-1", isFullAdmin: true };

function makeApplication(
  overrides: Partial<MappingApplicationInput> = {},
): MappingApplicationInput {
  return {
    id: "app-1",
    updatedAt: new Date("2026-04-12T00:00:00.000Z"),
    applicantEmail: "jane@test.com",
    applicantFirstName: "Jane",
    applicantLastName: "Doe",
    applicantDateOfBirth: new Date("1990-05-01T00:00:00.000Z"),
    applicantPhone: null,
    applicantAddress: null,
    familyMembers: [],
    nominator1Id: "nom-1",
    nominator2Id: "nom-2",
    ...overrides,
  };
}

const createEveryone = (count: number): NormalizedPersonDecision[] => [
  { ref: { kind: "applicant" }, decision: { mode: "CREATE" } },
  ...Array.from({ length: count }, (_unused, index) => ({
    ref: { kind: "family" as const, index },
    decision: { mode: "CREATE" as const },
  })),
];

function submitBody(overrides: Record<string, unknown> = {}) {
  return {
    applicantFirstName: "Jane",
    applicantLastName: "Doe",
    applicantEmail: "jane@test.com",
    applicantDateOfBirth: "1990-05-01",
    streetAddressLine1: "1 Test St",
    familyMembers: [],
    nominator1Email: "a@test.com",
    nominator2Email: "b@test.com",
    ...overrides,
  };
}

async function submit(body: Record<string, unknown>) {
  const response = await submitApplication(
    new NextRequest("http://localhost/api/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, json: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the shared decode refuses a value that names no real day", () => {
  it("answers null for every spelling a shape check lets through", () => {
    for (const value of NOT_REAL_DAYS) {
      expect(applicationDateOfBirthDay(value), value).toBeNull();
    }
    // And for the shapes that are not dates at all, including the absent value a
    // nullable column can hold.
    expect(applicationDateOfBirthDay("")).toBeNull();
    expect(applicationDateOfBirthDay("01/02/1990")).toBeNull();
    expect(applicationDateOfBirthDay(null)).toBeNull();
    expect(applicationDateOfBirthDay(undefined)).toBeNull();
  });

  it("answers the day itself for a real one, unchanged", () => {
    // NOT a `Date`: the whole point is that the value never becomes one until a
    // caller encodes it deliberately, so nothing here can roll or shift.
    expect(applicationDateOfBirthDay("2008-04-02")).toBe("2008-04-02");
    expect(applicationDateOfBirthDay("2008-02-29")).toBe("2008-02-29");
  });

  it("does NOT tighten the read schema, because a reader must not blank a page", () => {
    // THE DELIBERATE ASYMMETRY, pinned so a future tidy-up has to argue with it.
    // `parseApplicationFamilyMembers` runs over already-stored JSON on four
    // surfaces, one of them the nominating member's own landing page, which is an
    // async server component with no `error.tsx` under `(authenticated)`. A throw
    // there replaces the whole page and the member can no longer confirm OR
    // decline, with no admin action that clears it.
    const stored = parseApplicationFamilyMembers([
      { firstName: "Sam", lastName: "Smith", dateOfBirth: "1990-13-01" },
    ]);

    expect(stored).toEqual([
      { firstName: "Sam", lastName: "Smith", dateOfBirth: "1990-13-01" },
    ]);
  });
});

describe("the refusal names the person and never the value", () => {
  it("names a dependent by position and, when known, by name", () => {
    expect(dependentSubject({ firstName: "Sam", lastName: "Smith" }, 0)).toBe(
      "Dependent 1 (Sam Smith)",
    );
    expect(dependentSubject({ firstName: "", lastName: "" }, 2)).toBe(
      "Dependent 3",
    );
  });

  it("never carries a date of birth into the message", () => {
    const message = unreadableDateOfBirthRefusal(
      dependentSubject({ firstName: "Sam", lastName: "Smith" }, 0),
    );

    expect(message).toContain("Dependent 1 (Sam Smith)");
    expect(message).toContain("date of birth");
    // The FIELD is named, the VALUE is not — and nothing date-shaped leaks in
    // either, which is the assertion a future edit to the wording has to keep.
    for (const value of NOT_REAL_DAYS) {
      expect(message, value).not.toContain(value);
    }
    expect(message).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("the approval preview reports it, rather than throwing (#3082)", () => {
  it("blocks on a dependent whose stored date names no real day", async () => {
    // The preview IS the surface an admin uses to decide MAP versus CREATE, and it
    // is also the approval's own recompute. Throwing here would blank it with no
    // cause; `blockingErrors` is the channel this module already has, and
    // `approveMemberApplication` turns the first one into a 409 carrying the same
    // sentence.
    const { persons, blockingErrors } = await computeApprovalMappingOutcomes({
      application: makeApplication({
        familyMembers: [
          { firstName: "Sam", lastName: "Smith", dateOfBirth: "1990-13-01" },
        ],
      }),
      decisions: createEveryone(1),
      targetsById: new Map(),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });

    expect(blockingErrors).toHaveLength(1);
    expect(blockingErrors[0]).toContain("Dependent 1 (Sam Smith)");
    expect(blockingErrors[0]).toBe(
      unreadableDateOfBirthRefusal("Dependent 1 (Sam Smith)"),
    );
    // And it got that far: the person outcomes were still computed, so the admin
    // sees the whole preview with one stated reason it cannot proceed.
    expect(persons).toHaveLength(2);
  });

  it("blocks on an applicant date outside the calendar range", async () => {
    // `applicantDateOfBirth` IS a `@db.Date` column, so this is not the JSON
    // hole — it is the year-0 value `createMemberApplication` could once write
    // from `new Date("0000-05-05")`. It passes the stored-calendar-day
    // precondition (its UTC time is exactly midnight) and throws one call later.
    const { blockingErrors } = await computeApprovalMappingOutcomes({
      application: makeApplication({
        applicantDateOfBirth: new Date("0000-05-05T00:00:00.000Z"),
      }),
      decisions: createEveryone(0),
      targetsById: new Map(),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });

    expect(blockingErrors).toEqual([
      unreadableDateOfBirthRefusal("The applicant"),
    ]);
  });

  it("does not block, and does not throw, for real dates", async () => {
    const { blockingErrors } = await computeApprovalMappingOutcomes({
      application: makeApplication({
        familyMembers: [
          { firstName: "Sam", lastName: "Smith", dateOfBirth: "2016-02-29" },
        ],
      }),
      decisions: createEveryone(1),
      targetsById: new Map(),
      loginHolderId: null,
      seasonYear: 2026,
      actor: FULL_ADMIN,
      ageTierSettings: DEFAULT_SETTINGS,
    });

    expect(blockingErrors).toEqual([]);
  });
});

describe("the unauthenticated application POST refuses it on the way in", () => {
  it("refuses every spelling for the applicant, with the field named", async () => {
    for (const value of NOT_REAL_DAYS) {
      const { status, json } = await submit(
        submitBody({ applicantDateOfBirth: value }),
      );

      expect(status, value).toBe(422);
      expect(json.details.applicantDateOfBirth, value).toEqual([
        "Date of birth must be a real date",
      ]);
    }
  });

  it("refuses every spelling for a dependent", async () => {
    for (const value of NOT_REAL_DAYS) {
      const { status, json } = await submit(
        submitBody({
          familyMembers: [
            { firstName: "Sam", lastName: "Smith", dateOfBirth: value },
          ],
        }),
      );

      expect(status, value).toBe(422);
      expect(JSON.stringify(json.details), value).toContain(
        "Dependent date of birth must be a real date",
      );
    }
  });

  it("still refuses a value that is not date-shaped at all, as it always did", async () => {
    const { status, json } = await submit(
      submitBody({ applicantDateOfBirth: "01/02/1990" }),
    );

    expect(status).toBe(422);
    expect(json.details.applicantDateOfBirth).toEqual([
      "Date of birth must be YYYY-MM-DD",
    ]);
  });
});
