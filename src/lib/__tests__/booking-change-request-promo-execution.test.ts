import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireCalendarDate } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #4533: the executor's half of a finished-stay promo correction — the
 * officer's promo entry written by the approval's own claim, the request's
 * promo change mapped onto the batch edit, the credit default, the email choice
 * and the drift and refusal rules. The batch service is a double here, as in
 * `booking-change-request-officer-entry.test.ts`; the same path runs against
 * PostgreSQL in `booking-change-request-promo-correction.realdb.test.ts`.
 */

const mocks = vi.hoisted(() => ({
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
vi.mock("@/lib/capacity", () => ({ acquireLodgeCapacityLock: async () => {} }));
vi.mock("@/lib/booking-exception-approval", () => ({
  reauthorizeBookingOfficerFromDb: (...args: unknown[]) => mocks.reauthorize(...args),
}));
vi.mock("@/lib/booking-batch-modification-service", () => ({
  modifyBookingBatch: (...args: unknown[]) => mocks.modifyBookingBatch(...args),
}));

import {
  approveAndExecuteLockedPeriodChangeRequest,
  LOCKED_PERIOD_REQUEST_DRIFT_MESSAGE,
} from "@/lib/booking-change-request-execution";
import {
  NOTIFY_CHOICE_PROMO_ONLY_MESSAGE,
  OFFICER_PROMO_ON_PROMO_REQUEST_MESSAGE,
  PROMO_CHANGE_ALREADY_APPLIED_MESSAGE,
  withPromoChange,
} from "@/lib/booking-change-request-promo";
import type { BatchModificationPreTransaction } from "@/lib/booking-batch-modification-service";

const TODAY = requireCalendarDate("2026-07-01");

const tx = {
  $executeRaw: async () => {},
  bookingChangeRequest: {
    findUnique: (...args: unknown[]) => mocks.requestFindUnique(...args),
    updateMany: (...args: unknown[]) => mocks.updateMany(...args),
    update: (...args: unknown[]) => mocks.update(...args),
  },
  booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
  member: { findMany: (...args: unknown[]) => mocks.memberFindMany(...args) },
};
const db = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as never;

function freeTextRequest(requested: Record<string, unknown> = {}) {
  return {
    original: { checkIn: "2026-06-10", checkOut: "2026-06-14", guests: [{ id: "g1" }] },
    requested: {
      checkIn: null,
      checkOut: null,
      addGuests: [],
      removeGuests: [],
      guestStayRanges: [],
      requestedEffectiveDate: null,
      summary: "Locked-period booking change",
      ...requested,
    },
    payment: null,
  };
}

/** A request Edit Booking's correction card raised: a promo change and nothing else. */
function promoRequest(codesWhenEntered: string[] = []) {
  return withPromoChange(
    freeTextRequest(),
    { promoCode: "FREENIGHT" },
    { officerMemberId: "officer-1", enteredAt: new Date("2026-07-01T00:00:00.000Z"), enteredOn: "request" },
    codesWhenEntered,
  );
}

function booking(codes: string[] = []) {
  return {
    memberId: "member-1",
    checkIn: new Date("2026-06-10T00:00:00.000Z"),
    checkOut: new Date("2026-06-14T00:00:00.000Z"),
    status: "COMPLETED",
    guests: [{ id: "g1", stayStart: new Date("2026-06-10T00:00:00.000Z"), stayEnd: new Date("2026-06-14T00:00:00.000Z"), nights: [] }],
    // Paid by card: the ordinary default would refund it to the card.
    payment: { amountCents: 24_000, creditAppliedCents: 0 },
    promoRedemptions: codes.map((code) => ({ promoCode: { code } })),
  };
}

function primeRequest(requestedChanges: unknown) {
  mocks.requestFindUnique.mockReset();
  mocks.requestFindUnique
    .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", booking: { lodgeId: "lodge-1" } })
    .mockResolvedValueOnce({
      id: "cr-1",
      kind: "LOCKED_PERIOD",
      status: "REQUESTED",
      version: 2,
      bookingId: "booking-1",
      requestedByMemberId: "member-1",
      requestedChanges,
      reason: null,
    });
}

const FIGURES = { additionalAmountCents: 0, refundAmountCents: 0, accountCreditAmountCents: 4_000 };
type RunParams = Parameters<typeof approveAndExecuteLockedPeriodChangeRequest>[0];

function run(overrides: Partial<Omit<RunParams, "dryRun" | "expectedFigures">> = {}) {
  return approveAndExecuteLockedPeriodChangeRequest({
    expectedFigures: FIGURES,
    requestId: "cr-1",
    expectedVersion: 2,
    actorMemberId: "officer-1",
    adminNotes: "Your free night is now applied.",
    internalNotes: null,
    confirmOverCapacity: false,
    todayAtClub: TODAY,
    format: CLUB_FORMAT_TEST,
    preTransaction: {} as BatchModificationPreTransaction,
    ipAddress: "127.0.0.1",
    db,
    ...overrides,
  });
}

/** The batch input the executor handed the canonical service. */
function batchInput(): Record<string, unknown> {
  return (mocks.modifyBookingBatch.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reauthorize.mockResolvedValue(true);
  primeRequest(freeTextRequest());
  mocks.bookingFindUnique.mockResolvedValue(booking());
  mocks.memberFindMany.mockResolvedValue([]);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.update.mockResolvedValue({});
  mocks.modifyBookingBatch.mockResolvedValue({
    bookingModificationId: "mod-1",
    priceDiffCents: -4_000,
    changeFeeCents: 0,
    ...FIGURES,
    capacityOverridden: false,
  });
});

describe("the officer's promo entry on approval (#4533)", () => {
  it("is written by the claim, stamped, and applied with account credit by default", async () => {
    const result = await run({ officerPromoChange: { promoCode: "FREENIGHT" } });
    expect(result.outcome).toBe("executed");
    const claimed = mocks.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: { requestedChanges: { original: { promoCodes: string[] }; requested: Record<string, unknown> } };
    };
    expect(claimed.where).toMatchObject({ status: "REQUESTED", version: 2 });
    expect(claimed.data.requestedChanges.original.promoCodes).toEqual([]);
    expect(claimed.data.requestedChanges.requested.promoChange).toMatchObject({
      promoCode: "FREENIGHT",
      enteredBy: { onMemberBehalf: true, officerMemberId: "officer-1", enteredOn: "approval" },
    });
    expect(batchInput()).toMatchObject({ promoCode: "FREENIGHT", settlementMethod: "credit", notifyMember: true });
    expect(mocks.modifyBookingBatch.mock.calls[0]![0]).toMatchObject({
      finishedStayCorrection: { changeRequestId: "cr-1" },
    });
    expect(result).toMatchObject({
      settlementMethod: "credit",
      notifyMember: true,
      promoChange: { codes: ["FREENIGHT"], enteredBy: { enteredOn: "approval" } },
    });
  });

  it("keeps the officer's own refund choice", async () => {
    await run({ officerPromoChange: { promoCode: "FREENIGHT" }, settlementMethod: "card" });
    expect(batchInput()).toMatchObject({ settlementMethod: "card" });
  });

  it("withholds the email on a promo-only correction when the officer says so", async () => {
    const result = await run({ officerPromoChange: { promoCode: "FREENIGHT" }, notifyMember: false });
    expect(batchInput()).toMatchObject({ notifyMember: false });
    expect(result).toMatchObject({ notifyMember: false });
  });

  it("never withholds it beside a guest change, and writes nothing", async () => {
    const result = await run({
      officerPromoChange: { promoCode: "FREENIGHT" },
      officerEnteredGuests: [
        { firstName: "Late", lastName: "Friend", ageTier: "ADULT", isMember: false, stayStart: "2026-06-10", stayEnd: "2026-06-12" },
      ],
      notifyMember: false,
    });
    expect(result).toEqual({ outcome: "keptPending", message: NOTIFY_CHOICE_PROMO_ONLY_MESSAGE });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.modifyBookingBatch).not.toHaveBeenCalled();
  });

  it("refuses an entry naming the code the booking already carries", async () => {
    mocks.bookingFindUnique.mockResolvedValue(booking(["FREENIGHT"]));
    const result = await run({ officerPromoChange: { promoCode: "freenight" } });
    expect(result.outcome).toBe("keptPending");
    expect((result as { message: string }).message).toContain(PROMO_CHANGE_ALREADY_APPLIED_MESSAGE);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an entry on a request that already names a promo code", async () => {
    primeRequest(promoRequest());
    const result = await run({ officerPromoChange: { promoCode: "OTHER" } });
    expect(result).toEqual({ outcome: "keptPending", message: OFFICER_PROMO_ON_PROMO_REQUEST_MESSAGE });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

describe("a request raised from Edit Booking with a promo change (#4533)", () => {
  it("is applied through the one mapping, in the batch edit's own fields", async () => {
    primeRequest(promoRequest());
    const result = await run();
    expect(result.outcome).toBe("executed");
    expect(batchInput()).toMatchObject({ promoCode: "FREENIGHT", settlementMethod: "credit" });
    expect(batchInput()).not.toHaveProperty("addGuests");
    expect(result).toMatchObject({ promoChange: { codes: ["FREENIGHT"], enteredBy: { enteredOn: "request" } } });
  });

  it("is drift once a code was applied since it was raised, and is not applied", async () => {
    primeRequest(promoRequest([]));
    mocks.bookingFindUnique.mockResolvedValue(booking(["FREENIGHT"]));
    const result = await run();
    expect(result).toEqual({ outcome: "keptPending", message: LOCKED_PERIOD_REQUEST_DRIFT_MESSAGE });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.modifyBookingBatch).not.toHaveBeenCalled();
  });
});
