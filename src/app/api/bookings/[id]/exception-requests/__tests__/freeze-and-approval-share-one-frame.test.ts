import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * CT-4 (#2870): the FREEZE and the APPROVAL REPLAY read the same stored days the
 * same way — a cross-file frame pair, pinned end to end.
 *
 * ## The workflow this protects, in plain English
 *
 * A member asks for a change their booking's rules would normally refuse. The
 * request route freezes the exact party that change would produce and hashes it;
 * an officer reviews that frozen party; and at approval time the engine REPLAYS
 * the stored delta against the live booking and re-hashes the result. The two
 * hashes must match. That equality is the whole integrity story: it proves both
 * that the booking has not moved under the officer and that the delta still
 * produces the party they approved.
 *
 * ## Why it needs a test of its own
 *
 * Both sides read `Booking.checkIn`/`checkOut`, `BookingGuest.stayStart`/`stayEnd`
 * and `BookingGuestNight.stayDate` — all `@db.Date`, all a calendar day encoded
 * at UTC midnight (`INV-DATE-010`, `INV-DATE-026`). They live in different files,
 * one under `src/app/api` and one under `src/lib`, and nothing but this test
 * requires them to agree.
 *
 * When CT-4 corrected the route and left `booking-exception-approval.ts`
 * projecting through `APP_TIME_ZONE`, every replay for a club BEHIND Greenwich
 * came back a day early, the hashes differed, and `verifyLiveProposalIntegrity`
 * reported `drift` — refusing every replay for a booking nobody had touched, and,
 * in the wording of the time, telling the officer "the live booking has changed
 * since this request was made, please resubmit". #3089 reworded that refusal so
 * it no longer names a cause the engine cannot see (`INV-EXCEPT-035`); the
 * refusal itself is what this test exists to prevent.
 * Resubmitting reproduced it exactly, so no modification policy exception could
 * ever be approved (`INV-EXCEPT`). Both sides had been wrong in the SAME
 * direction before, which is why the equality held while both were wrong.
 *
 * The zone is pinned in the mock rather than read from the host, so this says the
 * same thing on any machine and on CI, where `TZ` is unset.
 */

// Inlined literals: `vi.mock` factories hoist above every const in this file.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn(),
  logAudit: vi.fn(),
  sendAlert: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  authzRole: vi.fn(),
  editPolicy: vi.fn(),
  bookingFindUnique: vi.fn(),
  createMod: vi.fn(),
  checkCapacity: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => mocks.checkRateLimit(...a),
  getClientIp: (...a: unknown[]) => mocks.getClientIp(...a),
  rateLimiters: {
    bookingChangeRequest: { id: "bcr", limit: 5, windowSeconds: 86400 },
  },
}));
vi.mock("@/lib/audit", () => ({ logAudit: (...a: unknown[]) => mocks.logAudit(...a) }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email", () => ({
  sendAdminBookingChangeRequestAlert: (...a: unknown[]) => mocks.sendAlert(...a),
  // The approval module imports this at module scope; it is never called here.
  sendBookingPolicyExceptionApprovedEmail: vi.fn(),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: (...a: unknown[]) => mocks.getDefaultLodgeId(...a),
}));
vi.mock("@/lib/admin-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-permissions")>();
  return {
    ...actual,
    bookingManagementAuthorizationRole: (...a: unknown[]) => mocks.authzRole(...a),
  };
});
vi.mock("@/lib/booking-edit-policy", () => ({
  getBookingEditPolicy: (...a: unknown[]) => mocks.editPolicy(...a),
}));
vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return {
    ...actual,
    checkCapacityForGuestRanges: (...a: unknown[]) => mocks.checkCapacity(...a),
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: (...a: unknown[]) => mocks.bookingFindUnique(...a) },
  },
}));
/*
  Partial, and deliberately so: `buildModificationProposalParties` must be the
  REAL one on BOTH sides of the pair, or the test proves nothing about them
  agreeing. Only the write is replaced, so the frozen party can be captured
  instead of persisted.
*/
vi.mock("@/lib/booking-exception-request-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/booking-exception-request-service")>();
  return {
    ...actual,
    createModificationExceptionRequest: (...a: unknown[]) => mocks.createMod(...a),
  };
});

import { APP_TIME_ZONE } from "@/config/operational";
import type { PrismaTransactionClient } from "@/lib/db-transaction";
import { formatDateOnly, formatDateOnlyForTimeZone } from "@/lib/date-only";
import {
  buildPolicyExceptionApprovalHooks,
  proposalGuestToCreateInput,
} from "@/lib/booking-exception-approval";
import type {
  ModificationProposalSnapshot,
  ProposalParty,
} from "@/lib/booking-exception-requests";
import { POST } from "@/app/api/bookings/[id]/exception-requests/route";
import { requireCalendarDate } from "@/lib/club-time";

// #3123 (`INV-LOCK-004`) — the CLUB's day, resolved by the caller BEFORE it opens
// its transaction and threaded in. Pinned to the frozen clock's club day, so
// these fixtures answer exactly as they did while the guard read the club's zone
// for itself.
const FIXTURE_CLUB_DAY = requireCalendarDate("2026-07-01");

/** The stored `@db.Date` days on the fixture booking. */
const STORED_CHECK_IN = "2026-07-04";
const STORED_CHECK_OUT = "2026-07-06";
const REQUESTED_CHECK_OUT = "2026-07-07";

function day(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function makeBooking() {
  return {
    id: "booking-1",
    memberId: "m1",
    status: "CONFIRMED",
    checkIn: day(STORED_CHECK_IN),
    checkOut: day(STORED_CHECK_OUT),
    lodgeId: "lodge_1",
    member: { firstName: "Ada", lastName: "Lovelace", email: "a@x.nz" },
    guests: [
      {
        id: "g1",
        firstName: "Ada",
        lastName: "Lovelace",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        stayStart: day(STORED_CHECK_IN),
        stayEnd: day(STORED_CHECK_OUT),
        nights: [{ stayDate: day("2026-07-04") }, { stayDate: day("2026-07-05") }],
      },
    ],
  };
}

const params = { params: Promise.resolve({ id: "booking-1" }) };

function postReq(body: Record<string, unknown>) {
  return new NextRequest(
    "http://localhost/api/bookings/booking-1/exception-requests",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

/** The transaction client the approval engine hands its hooks. */
function replayTx(
  delta: unknown,
  booking: ReturnType<typeof makeBooking> = makeBooking(),
): PrismaTransactionClient {
  return {
    bookingChangeRequest: {
      findUnique: async () => ({ requestedChanges: { delta } }),
    },
    booking: { findUnique: async () => booking },
  } as unknown as PrismaTransactionClient;
}

function snapshotOf(base: ProposalParty, proposed: ProposalParty) {
  return {
    kind: "MODIFICATION",
    lodgeId: "lodge_1",
    bookingId: "booking-1",
    base,
    proposed,
  } satisfies ModificationProposalSnapshot;
}

function approvalHooks() {
  return buildPolicyExceptionApprovalHooks({
    todayAtClub: FIXTURE_CLUB_DAY,
    requestId: "bcr-1",
    actorMemberId: "officer-1",
    ipAddress: "0.0.0.0",
  }).hooks;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    user: { id: "m1", email: "a@x.nz", name: "Ada", role: "member" },
  });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.checkRateLimit.mockResolvedValue({ success: true, resetAt: Date.now() + 1000 });
  mocks.getClientIp.mockReturnValue("0.0.0.0");
  mocks.getDefaultLodgeId.mockResolvedValue("lodge_1");
  mocks.authzRole.mockReturnValue("USER");
  mocks.editPolicy.mockReturnValue({
    canModify: true,
    today: day("2026-07-01"),
    editableFrom: null,
    mode: "future",
  });
  mocks.bookingFindUnique.mockResolvedValue(makeBooking());
  mocks.createMod.mockResolvedValue({
    id: "bcr-1",
    status: "REQUESTED",
    proposalHash: "b".repeat(64),
    reasonCodes: ["MINIMUM_STAY"],
    aggregateCapacityMode: "HOLD",
  });
  mocks.sendAlert.mockResolvedValue(undefined);
  mocks.checkCapacity.mockResolvedValue({ available: true });
});

/** Drive the real route and hand back exactly what it froze. */
async function freezeProposal(): Promise<{
  base: ProposalParty;
  proposed: ProposalParty;
  delta: unknown;
}> {
  const res = await POST(
    postReq({ checkOut: REQUESTED_CHECK_OUT, memberMessage: "one more night" }),
    params,
  );
  expect(res.status).toBe(201);
  const [frozen] = mocks.createMod.mock.calls.at(-1) as [
    { base: ProposalParty; proposed: ProposalParty; delta: unknown },
  ];
  return frozen;
}

describe("exception freeze and approval replay share one date frame (CT-4, #2870)", () => {
  it("PREMISE: this zone really does move a stored day, so the pair can disagree", () => {
    // The LEGACY answer, measured rather than assumed. If `America/Denver` ever
    // stopped shifting a UTC-midnight day, every assertion below would hold for
    // the wrong reason.
    expect(formatDateOnlyForTimeZone(day(STORED_CHECK_IN), APP_TIME_ZONE)).toBe(
      "2026-07-03",
    );
  });

  it("freezes a base whose stay days are exactly the stored calendar days", async () => {
    const { base } = await freezeProposal();
    expect(base.checkIn).toBe(STORED_CHECK_IN);
    expect(base.checkOut).toBe(STORED_CHECK_OUT);
    expect(base.guests[0].nights).toEqual(["2026-07-04", "2026-07-05"]);
  });

  it("proposes the envelope the delta asks for, on that same frame", async () => {
    // The PROPOSED party comes back through `resolveModificationStayRanges`,
    // which decodes the same columns a second time. That second decode is
    // another place the frame can slip, and it would slip WITHIN the frozen
    // snapshot — a proposal a day off its own base, reviewed by an officer as if
    // the member had asked to move the whole stay.
    const { proposed } = await freezeProposal();
    expect(proposed.checkIn).toBe(STORED_CHECK_IN);
    expect(proposed.checkOut).toBe(REQUESTED_CHECK_OUT);
  });

  it("expands the per-night footprint on that same frame, all the way down", async () => {
    /*
      THE DEFECT THIS ASSERTION USED TO PIN, AND WHAT CLOSED IT.

      Group B left this `it` asserting `["2026-07-03", "2026-07-04",
      "2026-07-05"]` — a party starting a night EARLIER than the stay — under a
      long comment saying "a red here is the fix arriving, not a regression".
      This is that red, resolved.

      A guest whose range the delta reset has no explicit night set, so the
      proposal expands their envelope with `envelopeNights` -> `getStayNights` ->
      `normalizeBookingDate` in `src/lib/policies/pricing.ts`, which projected
      every date through `APP_TIME_ZONE` (mocked to `America/Denver` at the top of
      this file). For a club behind Greenwich that is one day early, so the
      officer reviewed — and `recheckCapacity` asserted beds for, and
      `proposalGuestToCreateInput` executed — a party starting the night before
      the stay did. It did not deadlock approval only because the freeze and the
      replay both reached it and therefore stayed wrong together, which is the
      one reason group B could leave it.

      `normalizeBookingDate` now decodes the stored day in UTC, which
      `INV-DATE-019`'s first exact boundary blesses by name — "truncating an
      existing `@db.Date` value the same way is fine … it is not fine for a
      `DateTime` column" — over the columns `INV-DATE-026` establishes as calendar
      days. `INV-DATE-010` is why the value is an ENCODING rather than a moment,
      and is NOT the citation for the decode: its closing clause names those two
      ids as that authority, and what it forbids is deriving a rule from one of
      these values read as a MOMENT. This comment used to attribute the inverse
      of that to it (#3080). Either way
      the nights are the stored days: 4, 5 and 6 July for the requested
      `[04, 07)` envelope.

      This assertion is what keeps that closed. With the old projection restored
      it goes back to naming 3 July, on any host, because the zone is mocked
      rather than read from the machine.

      CLOSED IN GROUP F4b, and the sentence that used to sit here was WRONG in a
      way worth recording. It said the MODIFICATION path "resolves guest ranges
      through `resolveModificationStayRanges`, which never reaches
      `normalizeGuestStayRange`". It reaches it at four sites, one of which
      normalises every ADDED guest against the final envelope — including a
      range-less one. So both paths carried the same night-early default, and the
      claim that only the new-booking path did travelled from this comment into
      #2870's residual list, where it was recorded as fact for two groups.

      F4b read those two calls as the stored calendar days they are. Group B's pin
      lives on as a POSITIVE assertion at
      `src/lib/__tests__/booking-exception-new-booking-guest-frame.test.ts`, and
      the modification half is pinned at
      `src/lib/__tests__/booking-range-less-guest-frame.test.ts`.
    */
    const { proposed } = await freezeProposal();
    expect(proposed.guests[0].nights).toEqual([
      "2026-07-04",
      "2026-07-05",
      "2026-07-06",
    ]);
  });

  /*
    THE THREE SURFACES THE OLD PROJECTION MOVED TOGETHER (CT-4, #2870, group F2).

    Naming the frozen nights correctly is only a third of the job. The party the
    officer reviewed is also the party `recheckCapacity` asserts beds for
    (`INV-EXCEPT-016`, `INV-EXCEPT-017`) and the one
    `proposalGuestToCreateInput` executes (`INV-EXCEPT-003`). All three read the
    frozen night strings, so a projected freeze moved all three a night early at
    once — and no hash comparison could see it, because they moved together.

    These two assertions pin the other two surfaces to the SAME stored days, so
    the agreement is proved rather than assumed. The club zone here is
    `America/Denver`, mocked at the top of this file, so this says the same thing
    on any developer machine and on CI.
  */
  it("asserts capacity over exactly the nights it froze", async () => {
    const { base, proposed } = await freezeProposal();

    const outcome = await approvalHooks().recheckCapacity?.(
      snapshotOf(base, proposed),
      {} as PrismaTransactionClient,
    );
    expect(outcome).toEqual({ ok: true });

    const [lodgeId, checkIn, checkOut, ranges] = mocks.checkCapacity.mock.calls.at(
      -1,
    ) as [string, Date, Date, { nights: string[] }[]];

    expect(lodgeId).toBe("lodge_1");
    // Read in UTC, which is the correct reading of a UTC-midnight column
    // (INV-DATE-013, INV-DATE-019's first boundary). The window is half-open, so
    // it ends the morning after the last night (INV-DATE-003).
    expect(formatDateOnly(checkIn)).toBe(STORED_CHECK_IN);
    expect(formatDateOnly(checkOut)).toBe(REQUESTED_CHECK_OUT);
    expect(ranges).toEqual([
      { nights: ["2026-07-04", "2026-07-05", "2026-07-06"] },
    ]);
  });

  it("executes exactly the nights it froze", async () => {
    const { proposed } = await freezeProposal();

    const created = proposalGuestToCreateInput(proposed.guests[0]);

    expect(created.nights).toEqual([
      "2026-07-04",
      "2026-07-05",
      "2026-07-06",
    ]);
    expect(formatDateOnly(created.stayStart)).toBe(STORED_CHECK_IN);
    expect(formatDateOnly(created.stayEnd)).toBe(REQUESTED_CHECK_OUT);
  });

  it("replays to the SAME hash, so the approval is not refused as drift", async () => {
    // MUTANT KILLED: `normalizeDateOnlyForTimeZone` restored on either side of
    // the pair — in `loadLiveBookingForIntegrity`, or in the route's
    // `storedDateOnly`, or in the resolver's `storedRange`.
    const { base, proposed, delta } = await freezeProposal();
    const integrity = await approvalHooks().verifyLiveProposalIntegrity?.(
      snapshotOf(base, proposed),
      replayTx(delta),
    );

    expect(integrity).toEqual({ intact: true });
  });

  it("still reports drift when the live booking really did move", async () => {
    // The gate is not vacuous: it still refuses a booking that changed under the
    // officer. Without this, deleting the hash comparison altogether would pass
    // the case above.
    const { base, proposed, delta } = await freezeProposal();

    const moved = makeBooking();
    moved.checkOut = day("2026-07-05");
    moved.guests[0].stayEnd = day("2026-07-05");
    moved.guests[0].nights = [{ stayDate: day("2026-07-04") }];

    expect(
      await approvalHooks().verifyLiveProposalIntegrity?.(
        snapshotOf(base, proposed),
        replayTx(delta, moved),
      ),
    ).toEqual({ intact: false, reason: "drift" });
  });
});
