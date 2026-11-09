import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireCalendarDate } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #4030 Part B: on a finished stay, the officer enters the guests a free-text
 * request described. The entry is written into the request — officer-entered,
 * on the member's behalf, naming the officer — by the approval's own guarded
 * claim, then applied through #3750's unchanged path. The batch service is a
 * double here, as in `booking-change-request-execution.test.ts`; the same path
 * runs against PostgreSQL in `booking-change-request-execution.realdb.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  reauthorize: vi.fn(),
  modifyBookingBatch: vi.fn(),
  requestFindUnique: vi.fn(),
  bookingFindUnique: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  memberFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: async () => {
    mocks.calls.push("lodge-lock");
  },
}));
vi.mock("@/lib/booking-exception-approval", () => ({
  reauthorizeBookingOfficerFromDb: (...args: unknown[]) => mocks.reauthorize(...args),
}));
vi.mock("@/lib/booking-batch-modification-service", () => ({
  modifyBookingBatch: (...args: unknown[]) => {
    mocks.calls.push("modify");
    return mocks.modifyBookingBatch(...args);
  },
}));

import {
  approveAndExecuteLockedPeriodChangeRequest,
  OFFICER_ENTRY_ON_STRUCTURED_REQUEST_MESSAGE,
} from "@/lib/booking-change-request-execution";
import { OFFICER_ENTRY_DEPENDANT_TYPED_MESSAGE } from "@/lib/booking-change-request-guests";
import {
  lockedPeriodRequestToBatchInput,
  storedLockedPeriodRequestSchema,
  storedRequestNamesNoChange,
} from "@/lib/booking-change-request-stored";
import {
  OFFICER_ENTERED_SUMMARY_SUFFIX,
  withOfficerEnteredGuests,
} from "@/lib/booking-change-request-guests";
import type { BatchModificationPreTransaction } from "@/lib/booking-batch-modification-service";

const TODAY = requireCalendarDate("2026-07-01");

const tx = {
  $executeRaw: async (strings: TemplateStringsArray) => {
    // #4845: the booking-row lock runs through this same client, between the lodge key and the claim.
    mocks.calls.push(strings.join("?").includes('FROM "Booking"') ? "booking-row" : "global-lock");
  },
  bookingChangeRequest: {
    findUnique: (...args: unknown[]) => mocks.requestFindUnique(...args),
    updateMany: (...args: unknown[]) => {
      mocks.calls.push("claim");
      return mocks.updateMany(...args);
    },
    update: (...args: unknown[]) => mocks.update(...args),
  },
  booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
  member: { findMany: (...args: unknown[]) => mocks.memberFindMany(...args) },
};
const db = {
  $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
} as never;

/** What the old free-text card stored: an effective date and nothing else. */
function freeTextRequest(requested: Record<string, unknown> = {}) {
  return {
    original: {
      checkIn: "2026-06-10",
      checkOut: "2026-06-14",
      guests: [{ id: "g1" }],
    },
    requested: {
      checkIn: null,
      checkOut: null,
      addGuests: [],
      removeGuests: [],
      guestStayRanges: [],
      requestedEffectiveDate: "2026-06-10",
      summary: "effective 2026-06-10",
      ...requested,
    },
    payment: { id: "pay-1", amountCents: 12_000 },
  };
}

const finishedBooking = {
  memberId: "member-1",
  checkIn: new Date("2026-06-10T00:00:00.000Z"),
  checkOut: new Date("2026-06-14T00:00:00.000Z"),
  status: "COMPLETED",
  guests: [{ id: "g1" }],
  payment: { amountCents: 12_000, creditAppliedCents: 0 },
};

const GRANDCHILDREN = [
  { firstName: "Ari", lastName: "Example", ageTier: "CHILD" as const, isMember: false, stayStart: "2026-06-10", stayEnd: "2026-06-14" },
  { firstName: "Bo", lastName: "Example", ageTier: "CHILD" as const, isMember: false, stayStart: "2026-06-11", stayEnd: "2026-06-13" },
];

function primeRequest(requestedChanges: unknown) {
  mocks.requestFindUnique.mockReset();
  mocks.requestFindUnique
    .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", bookingId: "booking-1", booking: { lodgeId: "lodge-1" } })
    .mockResolvedValueOnce({
      id: "cr-1",
      kind: "LOCKED_PERIOD",
      status: "REQUESTED",
      version: 2,
      bookingId: "booking-1",
      requestedByMemberId: "member-1",
      requestedChanges,
      reason: "Can we add these three grandchildren to our booking",
    });
}

type RunParams = Parameters<typeof approveAndExecuteLockedPeriodChangeRequest>[0];
/** The figures the mocked edit produces: what the officer's check would have shown. */
const CHECKED_FIGURES = { additionalAmountCents: 10_000, refundAmountCents: 0, accountCreditAmountCents: 0 };

/**
 * An approval carries the figures it was shown (#4030 re-review of 72c933ffc:
 * the executor's type requires them), so `run()` defaults them to the mocked
 * edit's own; `run({ dryRun: true })` sends none.
 */
function run(
  overrides: Partial<Omit<RunParams, "dryRun" | "expectedFigures">> & {
    dryRun?: true;
    expectedFigures?: RunParams["expectedFigures"];
  } = {},
) {
  const { dryRun, expectedFigures, ...rest } = overrides;
  return approveAndExecuteLockedPeriodChangeRequest({
    ...(dryRun ? { dryRun } : { expectedFigures: expectedFigures ?? CHECKED_FIGURES }),
    requestId: "cr-1",
    expectedVersion: 2,
    actorMemberId: "officer-1",
    adminNotes: "Added your grandchildren as you asked.",
    internalNotes: null,
    confirmOverCapacity: false,
    todayAtClub: TODAY,
    format: CLUB_FORMAT_TEST,
    preTransaction: {} as BatchModificationPreTransaction,
    ipAddress: "127.0.0.1",
    officerEnteredGuests: GRANDCHILDREN,
    db,
    ...rest,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.reauthorize.mockResolvedValue(true);
  primeRequest(freeTextRequest());
  mocks.bookingFindUnique.mockResolvedValue(finishedBooking);
  mocks.memberFindMany.mockResolvedValue([]);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.update.mockResolvedValue({});
  mocks.modifyBookingBatch.mockResolvedValue({
    bookingModificationId: "mod-1",
    priceDiffCents: 10_000,
    changeFeeCents: 0,
    additionalAmountCents: 10_000,
    refundAmountCents: 0,
    accountCreditAmountCents: 0,
    capacityOverridden: false,
  });
});

describe("officer-entered guests on a free-text request (#4030 Part B)", () => {
  it("applies a gapped guest's repeated range as the nights they hold, beside the officer's entry (#4157)", async () => {
    // The member's request names no change of its own: it only repeats g1's
    // dates, which in range mode is all a gapped guest's row can send. The
    // officer enters the guests; the repeated range rides through the same
    // mapping and must keep g1's nights (10, 11 and 13 June), not fill the 12th.
    const held = ["2026-06-10", "2026-06-11", "2026-06-13"];
    const request = freeTextRequest({
      guestStayRanges: [{ guestId: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-14" }],
    });
    // The snapshot holds g1's own dates (and, sent before #4088, no nights), so
    // the range is recognised as a repeat: the request names no change.
    primeRequest({
      ...request,
      original: { ...request.original, guests: [{ id: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-14" }] },
    });
    mocks.bookingFindUnique.mockResolvedValue({
      ...finishedBooking,
      guests: [
        {
          id: "g1",
          stayStart: new Date("2026-06-10T00:00:00.000Z"),
          stayEnd: new Date("2026-06-14T00:00:00.000Z"),
          nights: held.map((night) => ({ stayDate: new Date(`${night}T00:00:00.000Z`) })),
        },
      ],
    });
    const result = await run();
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "executed", officerEnteredGuests: GRANDCHILDREN });
    const { input } = mocks.modifyBookingBatch.mock.calls[0][0] as {
      input: { guestStayRanges: unknown; addGuests: unknown };
    };
    expect(input.guestStayRanges, "INV-REQ-012: a repeated range keeps the guest's nights").toEqual([
      { guestId: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-14", nights: held },
    ]);
    expect(input.addGuests).toEqual(GRANDCHILDREN.map((guest) => expect.objectContaining(guest)));
    // One claim writes both the officer's entry and the record of kept nights.
    const claim = mocks.updateMany.mock.calls[0][0] as {
      data: { requestedChanges: { keptNights: unknown; requested: Record<string, unknown> } };
    };
    expect(claim.data.requestedChanges.keptNights).toEqual([{ guestId: "g1", nights: held }]);
    expect(claim.data.requestedChanges.requested.officerEntry).toMatchObject({ officerMemberId: "officer-1" });
  });

  it("writes the entry into the request BY THE CLAIM, naming the officer, then applies it", async () => {
    const result = await run();
    expect(result).toMatchObject({
      outcome: "executed",
      addedGuestCount: 2,
      additionalAmountCents: 10_000,
      officerEnteredGuests: GRANDCHILDREN,
    });
    // One statement: the guarded claim carries the entry.
    expect(mocks.calls).toEqual(["global-lock", "lodge-lock", "booking-row", "claim", "modify"]);
    const claim = mocks.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: { requestedChanges: Record<string, Record<string, unknown>>; status: string };
    };
    expect(claim.where).toEqual({ id: "cr-1", status: "REQUESTED", kind: "LOCKED_PERIOD", version: 2 });
    expect(claim.data.status).toBe("APPROVED");
    expect(claim.data.requestedChanges.requested).toMatchObject({
      addGuests: GRANDCHILDREN,
      summary: `add Ari Example, Bo Example ${OFFICER_ENTERED_SUMMARY_SUFFIX}`,
      officerEntry: {
        onMemberBehalf: true,
        officerMemberId: "officer-1",
        enteredAt: expect.any(String),
        memberSummary: "effective 2026-06-10",
      },
      // The member's own fields are kept.
      requestedEffectiveDate: "2026-06-10",
    });
    // Everything outside `requested` is untouched.
    expect(claim.data.requestedChanges.original).toEqual(freeTextRequest().original);
    expect(claim.data.requestedChanges.payment).toEqual(freeTextRequest().payment);
  });

  it("applies exactly the officer's guests and nights, under the member's own rules and no fee waiver", async () => {
    await run();
    const [args] = mocks.modifyBookingBatch.mock.calls[0] as [Record<string, unknown>];
    expect(args).toMatchObject({
      actor: { id: "officer-1", role: "ADMIN" },
      finishedStayCorrection: { changeRequestId: "cr-1" },
      input: {
        addGuests: [
          expect.objectContaining({ firstName: "Ari", stayStart: "2026-06-10", stayEnd: "2026-06-14" }),
          expect.objectContaining({ firstName: "Bo", stayStart: "2026-06-11", stayEnd: "2026-06-13" }),
        ],
        reviewedMemberProposal: true,
        notifyMember: true,
        memberReviewJustification: "Can we add these three grandchildren to our booking",
      },
    });
    expect(args).not.toHaveProperty("waiveChangeFee");
    const input = args.input as Record<string, unknown>;
    expect(input).not.toHaveProperty("removeGuestIds");
    expect(input).not.toHaveProperty("checkIn");
  });

  it("refuses an entry on a request that already names a change, before claiming", async () => {
    primeRequest(
      freeTextRequest({
        addGuests: [{ firstName: "Late", lastName: "Guest", ageTier: "CHILD", isMember: false }],
      }),
    );
    expect(await run()).toEqual({
      outcome: "keptPending",
      message: OFFICER_ENTRY_ON_STRUCTURED_REQUEST_MESSAGE,
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.modifyBookingBatch).not.toHaveBeenCalled();
  });

  it("refuses nights outside the stay as it stands under the locks, before claiming", async () => {
    const result = await run({
      officerEnteredGuests: [{ ...GRANDCHILDREN[0], stayEnd: "2026-06-15" }],
    });
    expect(result).toMatchObject({
      outcome: "keptPending",
      message: expect.stringMatching(/must fall within the stay \(2026-06-10 to 2026-06-14\).*still pending/),
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("a refusal from the canonical service throws through the claim, so the entry is rolled back with it", async () => {
    mocks.modifyBookingBatch.mockRejectedValue(new Error("over capacity"));
    await expect(run()).rejects.toThrow("over capacity");
    // The claim (and the entry it carried) ran inside the transaction that threw.
    expect(mocks.calls).toEqual(["global-lock", "lodge-lock", "booking-row", "claim", "modify"]);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("applies when the edit produces exactly the figures the officer was shown (review C4)", async () => {
    const result = await run({
      expectedFigures: { additionalAmountCents: 10_000, refundAmountCents: 0, accountCreditAmountCents: 0 },
    });
    expect(result).toMatchObject({ outcome: "executed" });
    expect(mocks.update).toHaveBeenCalled();
  });

  it("refuses, rolling everything back, when the figures moved since the officer checked (review C4)", async () => {
    const { FinishedStayFiguresChangedError } = await import("@/lib/booking-change-request-execution");
    await expect(
      run({ expectedFigures: { additionalAmountCents: 9_000, refundAmountCents: 0, accountCreditAmountCents: 0 } }),
    ).rejects.toBeInstanceOf(FinishedStayFiguresChangedError);
    // Thrown inside the transaction, after the claim and the edit: nothing is linked.
    expect(mocks.calls).toEqual(["global-lock", "lodge-lock", "booking-row", "claim", "modify"]);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("a dry run computes the figures for the entry and answers `quoted`", async () => {
    const result = await run({ dryRun: true });
    expect(result).toMatchObject({ outcome: "quoted", additionalAmountCents: 10_000 });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses a typed guest named like one of the member's dependants, pointing at the finder (review M4)", async () => {
    mocks.memberFindMany.mockResolvedValue([{ id: "dep-1", firstName: "Bo", lastName: "Example" }]);
    expect(await run()).toEqual({ outcome: "keptPending", message: OFFICER_ENTRY_DEPENDANT_TYPED_MESSAGE });
    // Both readings of the name are answered (re-review of 72c933ffc).
    expect(OFFICER_ENTRY_DEPENDANT_TYPED_MESSAGE).toMatch(/If it is that dependant, add them with \+ Add a member/);
    expect(OFFICER_ENTRY_DEPENDANT_TYPED_MESSAGE).toMatch(
      /If it is a different person who shares the name, this entry can't add them/,
    );
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.modifyBookingBatch).not.toHaveBeenCalled();
    // The OWNER's dependants were read, never the officer's.
    expect(mocks.memberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ NOT: { id: "member-1" } }) }),
    );
  });

  it("lets the same dependant through when entered as the member they are", async () => {
    mocks.memberFindMany.mockResolvedValue([{ id: "dep-1", firstName: "Bo", lastName: "Example" }]);
    const result = await run({
      officerEnteredGuests: [{ ...GRANDCHILDREN[1], isMember: true, memberId: "dep-1" }],
    });
    expect(result).toMatchObject({ outcome: "executed" });
  });

  it("without an entry, a free-text request is still not applied", async () => {
    const result = await run({ officerEnteredGuests: undefined });
    expect(result).toMatchObject({ outcome: "keptPending", message: expect.stringMatching(/Enter the guests/) });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

describe("storedRequestNamesNoChange (#4030)", () => {
  const booking = { checkIn: finishedBooking.checkIn, checkOut: finishedBooking.checkOut };

  it("is true for a free-text request", () => {
    expect(storedRequestNamesNoChange(freeTextRequest(), booking)).toBe(true);
  });

  it("is false for a request naming guests, dates or ranges", () => {
    expect(
      storedRequestNamesNoChange(
        freeTextRequest({ addGuests: [{ firstName: "A", lastName: "B", ageTier: "ADULT", isMember: false }] }),
        booking,
      ),
    ).toBe(false);
    expect(storedRequestNamesNoChange(freeTextRequest({ checkOut: "2026-06-13" }), booking)).toBe(false);
  });

  it("treats a request whose dates equal the booking's own as naming nothing", () => {
    expect(storedRequestNamesNoChange(freeTextRequest({ checkOut: "2026-06-14" }), booking)).toBe(true);
  });

  it("does not count a stay range that repeats the guest's stored nights (review M2)", () => {
    const withOriginal = (range: Record<string, unknown>) => ({
      ...freeTextRequest({ guestStayRanges: [{ guestId: "g1", ...range }] }),
      original: {
        ...freeTextRequest().original,
        guests: [{ id: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-14" }],
      },
    });
    expect(storedRequestNamesNoChange(withOriginal({ stayStart: "2026-06-10", stayEnd: "2026-06-14" }), booking)).toBe(true);
    expect(storedRequestNamesNoChange(withOriginal({ stayEnd: "2026-06-12" }), booking)).toBe(true);
    expect(storedRequestNamesNoChange(withOriginal({ stayStart: "2026-06-10", stayEnd: "2026-06-12" }), booking)).toBe(false);
  });

  it("applies every two-bound range of a request that names a change, unchanged ones included (re-review of 72c933ffc)", () => {
    // A shorter stay plus a removal, with each remaining guest's stored range
    // repeated. Dropping the repeated ranges would leave range mode and stretch
    // the part-stay guest to the new envelope; they must all reach the planner.
    const stored = storedLockedPeriodRequestSchema.parse({
      ...freeTextRequest({
        checkOut: "2026-06-13",
        removeGuests: [{ id: "g1" }],
        guestStayRanges: [
          { guestId: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-14" },
          { guestId: "g2", stayStart: "2026-06-10", stayEnd: "2026-06-13" },
          { guestId: "g3", stayStart: "2026-06-11", stayEnd: "2026-06-12" },
          { guestId: "g4", stayEnd: "2026-06-12" },
        ],
      }),
      original: {
        ...freeTextRequest().original,
        guests: [
          { id: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-14" },
          { id: "g2", stayStart: "2026-06-10", stayEnd: "2026-06-13" },
          { id: "g3", stayStart: "2026-06-11", stayEnd: "2026-06-12" },
          { id: "g4", stayStart: "2026-06-10", stayEnd: "2026-06-14" },
        ],
      },
    });
    expect(lockedPeriodRequestToBatchInput(stored, booking)).toEqual({
      checkOut: "2026-06-13",
      removeGuestIds: ["g1"],
      // g1 is removed and g4's range has one bound, so neither is applied.
      guestStayRanges: [
        { guestId: "g2", stayStart: "2026-06-10", stayEnd: "2026-06-13" },
        { guestId: "g3", stayStart: "2026-06-11", stayEnd: "2026-06-12" },
      ],
    });
  });

  it("is false for an unreadable row", () => {
    expect(storedRequestNamesNoChange({ requested: {} }, booking)).toBe(false);
  });

  it("is false once the officer's entry is written in", () => {
    const written = withOfficerEnteredGuests(freeTextRequest(), GRANDCHILDREN, {
      officerMemberId: "officer-1",
      enteredAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(storedRequestNamesNoChange(written, booking)).toBe(false);
  });
});
