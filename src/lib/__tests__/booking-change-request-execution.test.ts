import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireCalendarDate } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #3750: the approve-and-execute engine for a LOCKED_PERIOD change request on a
 * finished stay — its lock order, fresh-role check, guarded claim, drift gate
 * and hand-off to the canonical batch service. The service itself is a double
 * here (its finished-stay behaviour is pinned in its own suites and against
 * PostgreSQL in `booking-change-request-execution.realdb.test.ts`); what this
 * suite proves is what the ENGINE does around it.
 */

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  reauthorize: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  modifyBookingBatch: vi.fn(),
  requestFindUnique: vi.fn(),
  bookingFindUnique: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  executeRaw: vi.fn(),
  deferred: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: (...args: unknown[]) => {
    mocks.calls.push("lodge-lock");
    return mocks.acquireLodgeCapacityLock(...args);
  },
}));
vi.mock("@/lib/booking-exception-approval", () => ({
  reauthorizeBookingOfficerFromDb: (...args: unknown[]) => {
    mocks.calls.push("reauthorize");
    return mocks.reauthorize(...args);
  },
}));
vi.mock("@/lib/booking-batch-modification-service", () => ({
  modifyBookingBatch: (...args: unknown[]) => {
    mocks.calls.push("modify");
    return mocks.modifyBookingBatch(...args);
  },
}));

import {
  approveAndExecuteLockedPeriodChangeRequest,
  LOCKED_PERIOD_REQUEST_DRIFT_MESSAGE,
  LOCKED_PERIOD_REQUEST_NOTHING_TO_APPLY_MESSAGE,
  LOCKED_PERIOD_REQUEST_UNREADABLE_MESSAGE,
  lockedPeriodRequestToBatchInput,
} from "@/lib/booking-change-request-execution";
import type { BatchModificationPreTransaction } from "@/lib/booking-batch-modification-service";

const TODAY = requireCalendarDate("2026-07-01");
const PRE_TRANSACTION = { marker: "pre" } as unknown as BatchModificationPreTransaction;

const tx = {
  $executeRaw: (...args: unknown[]) => {
    mocks.calls.push("global-lock");
    return mocks.executeRaw(...args);
  },
  bookingChangeRequest: {
    findUnique: (...args: unknown[]) => mocks.requestFindUnique(...args),
    updateMany: (...args: unknown[]) => {
      mocks.calls.push("claim");
      return mocks.updateMany(...args);
    },
    update: (...args: unknown[]) => {
      mocks.calls.push("link");
      return mocks.update(...args);
    },
  },
  booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
};

const db = {
  $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
    const result = await fn(tx);
    mocks.calls.push("commit");
    return result;
  },
} as never;

function storedRequest(requested: Record<string, unknown> = {}) {
  return {
    original: {
      checkIn: "2026-06-10",
      checkOut: "2026-06-14",
      guests: [{ id: "g1" }, { id: "g2" }],
    },
    requested: {
      checkIn: null,
      checkOut: null,
      addGuests: [
        { firstName: "Late", lastName: "Guest", ageTier: "CHILD", isMember: false },
      ],
      removeGuests: [],
      guestStayRanges: [],
      requestedEffectiveDate: null,
      summary: "add Late Guest",
      ...requested,
    },
  };
}

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cr-1",
    kind: "LOCKED_PERIOD",
    status: "REQUESTED",
    version: 3,
    bookingId: "booking-1",
    requestedByMemberId: "member-1",
    requestedChanges: storedRequest(),
    ...overrides,
  };
}

const finishedBooking = {
  checkIn: new Date("2026-06-10T00:00:00.000Z"),
  checkOut: new Date("2026-06-14T00:00:00.000Z"),
  status: "COMPLETED",
  guests: [{ id: "g2" }, { id: "g1" }],
};

function run(overrides: Partial<Parameters<typeof approveAndExecuteLockedPeriodChangeRequest>[0]> = {}) {
  return approveAndExecuteLockedPeriodChangeRequest({
    requestId: "cr-1",
    expectedVersion: 3,
    actorMemberId: "officer-1",
    adminNotes: "Added the guest who stayed.",
    internalNotes: null,
    confirmOverCapacity: false,
    todayAtClub: TODAY,
    format: CLUB_FORMAT_TEST,
    preTransaction: PRE_TRANSACTION,
    ipAddress: "127.0.0.1",
    db,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.reauthorize.mockResolvedValue(true);
  mocks.requestFindUnique
    .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", booking: { lodgeId: "lodge-1" } })
    .mockResolvedValueOnce(requestRow());
  mocks.bookingFindUnique.mockResolvedValue(finishedBooking);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.update.mockResolvedValue({});
  mocks.deferred.mockImplementation(async () => {
    mocks.calls.push("post-commit");
  });
  mocks.modifyBookingBatch.mockResolvedValue({
    bookingModificationId: "mod-9",
    priceDiffCents: 4_500,
    changeFeeCents: 0,
    additionalAmountCents: 4_500,
    refundAmountCents: 0,
    accountCreditAmountCents: 0,
    capacityOverridden: false,
    deferredPostCommit: mocks.deferred,
  });
});

describe("approveAndExecuteLockedPeriodChangeRequest (#3750)", () => {
  it("locks global -> lodge, reauthorises, claims, modifies on the same tx, links, commits, THEN runs provider work", async () => {
    const result = await run();

    expect(result).toMatchObject({
      outcome: "executed",
      modificationId: "mod-9",
      addedGuestCount: 1,
      removedGuestCount: 0,
      additionalAmountCents: 4_500,
    });
    expect(mocks.calls).toEqual([
      "global-lock",
      "lodge-lock",
      "reauthorize",
      "claim",
      "modify",
      "link",
      "commit",
      "post-commit",
    ]);
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(tx, "lodge-1");
  });

  it("claims with the version CAS and bumps it, recording both notes and the reviewer", async () => {
    await run({ internalNotes: "Confirmed with the hut warden." });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "cr-1", status: "REQUESTED", kind: "LOCKED_PERIOD", version: 3 },
      data: expect.objectContaining({
        status: "APPROVED",
        version: { increment: 1 },
        adminNotes: "Added the guest who stayed.",
        internalNotes: "Confirmed with the hut warden.",
        reviewedByMemberId: "officer-1",
      }),
    });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "cr-1" },
      data: { linkedModificationId: "mod-9" },
    });
  });

  it("hands the canonical service the request's change, as an officer, under the finished-stay flag", async () => {
    await run({ confirmOverCapacity: true });
    expect(mocks.modifyBookingBatch).toHaveBeenCalledTimes(1);
    const [args] = mocks.modifyBookingBatch.mock.calls[0] as [Record<string, unknown>];
    expect(args).toMatchObject({
      bookingId: "booking-1",
      actor: { id: "officer-1", role: "ADMIN" },
      tx,
      preTransaction: PRE_TRANSACTION,
      todayAtClub: TODAY,
      finishedStayCorrection: { changeRequestId: "cr-1" },
      input: {
        addGuests: [
          {
            firstName: "Late",
            lastName: "Guest",
            ageTier: "CHILD",
            isMember: false,
            stayStart: null,
            stayEnd: null,
          },
        ],
        confirmOverCapacity: true,
        // Back the way it was paid, unless the officer chose credit.
        settlementMethod: "card",
        // The member is always told, with the amount due.
        notifyMember: true,
      },
    });
    expect(args).not.toHaveProperty("waiveChangeFee");
    expect(args).not.toHaveProperty("input.adminOverride");
  });

  it("executes every part of a mixed request: dates, removals, ranges and adds (decision 4)", async () => {
    mocks.requestFindUnique.mockReset();
    mocks.requestFindUnique
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", booking: { lodgeId: "lodge-1" } })
      .mockResolvedValueOnce(
        requestRow({
          requestedChanges: storedRequest({
            checkOut: "2026-06-13",
            removeGuests: [{ id: "g2" }],
            guestStayRanges: [
              { guestId: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-13" },
              { guestId: "g2", stayStart: "2026-06-10", stayEnd: "2026-06-14" },
            ],
          }),
        }),
      );
    await run({ settlementMethod: "credit" });
    const [args] = mocks.modifyBookingBatch.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(args.input).toMatchObject({
      checkOut: "2026-06-13",
      removeGuestIds: ["g2"],
      // The removed guest's range is moot and is dropped.
      guestStayRanges: [{ guestId: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-13" }],
      addGuests: [expect.objectContaining({ firstName: "Late" })],
      settlementMethod: "credit",
    });
    expect(args.input).not.toHaveProperty("checkIn");
  });

  it("a second approval that lost the race does nothing at all", async () => {
    mocks.requestFindUnique.mockReset();
    mocks.requestFindUnique
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", booking: { lodgeId: "lodge-1" } })
      .mockResolvedValueOnce(requestRow({ status: "APPROVED", version: 4 }));
    expect(await run()).toEqual({ outcome: "claimLost" });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.modifyBookingBatch).not.toHaveBeenCalled();
    expect(mocks.deferred).not.toHaveBeenCalled();
  });

  it("a stale version is a lost claim, not an execution", async () => {
    mocks.requestFindUnique.mockReset();
    mocks.requestFindUnique
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", booking: { lodgeId: "lodge-1" } })
      .mockResolvedValueOnce(requestRow({ version: 4 }));
    expect(await run()).toEqual({ outcome: "claimLost" });
    expect(mocks.modifyBookingBatch).not.toHaveBeenCalled();
  });

  it("a CAS that loses between the read and the write runs no side effect", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    expect(await run()).toEqual({ outcome: "claimLost" });
    expect(mocks.modifyBookingBatch).not.toHaveBeenCalled();
  });

  it("refuses an officer whose access went since the session began, before writing anything", async () => {
    mocks.reauthorize.mockResolvedValue(false);
    expect(await run()).toEqual({ outcome: "notAuthorized" });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.modifyBookingBatch).not.toHaveBeenCalled();
  });

  it("never decides a POLICY_EXCEPTION row", async () => {
    mocks.requestFindUnique.mockReset();
    mocks.requestFindUnique.mockResolvedValueOnce({
      kind: "POLICY_EXCEPTION",
      booking: { lodgeId: "lodge-1" },
    });
    expect(await run()).toEqual({ outcome: "notFound" });
    expect(mocks.calls).not.toContain("global-lock");
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("keeps the request pending when the booking has moved since the request (drift)", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      ...finishedBooking,
      guests: [{ id: "g1" }],
    });
    expect(await run()).toEqual({
      outcome: "keptPending",
      message: LOCKED_PERIOD_REQUEST_DRIFT_MESSAGE,
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();

    mocks.requestFindUnique
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", booking: { lodgeId: "lodge-1" } })
      .mockResolvedValueOnce(requestRow());
    mocks.bookingFindUnique.mockResolvedValue({
      ...finishedBooking,
      checkOut: new Date("2026-06-13T00:00:00.000Z"),
    });
    expect(await run()).toMatchObject({ outcome: "keptPending" });
    expect(mocks.modifyBookingBatch).not.toHaveBeenCalled();
  });

  it("keeps a cancelled booking's request pending without claiming it", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ ...finishedBooking, status: "CANCELLED" });
    const result = await run();
    expect(result).toMatchObject({ outcome: "keptPending" });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("keeps an unreadable stored request pending", async () => {
    mocks.requestFindUnique.mockReset();
    mocks.requestFindUnique
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", booking: { lodgeId: "lodge-1" } })
      .mockResolvedValueOnce(requestRow({ requestedChanges: { requested: "nonsense" } }));
    expect(await run()).toEqual({
      outcome: "keptPending",
      message: LOCKED_PERIOD_REQUEST_UNREADABLE_MESSAGE,
    });
  });

  it("refuses a request with nothing structural to apply", async () => {
    mocks.requestFindUnique.mockReset();
    mocks.requestFindUnique
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", booking: { lodgeId: "lodge-1" } })
      .mockResolvedValueOnce(
        requestRow({
          requestedChanges: storedRequest({
            addGuests: [],
            checkIn: "2026-06-10",
            requestedEffectiveDate: "2026-06-12",
          }),
        }),
      );
    expect(await run()).toEqual({
      outcome: "keptPending",
      message: LOCKED_PERIOD_REQUEST_NOTHING_TO_APPLY_MESSAGE,
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("a canonical-service refusal propagates, so the transaction rolls the claim back", async () => {
    mocks.modifyBookingBatch.mockRejectedValue(new Error("member-night clash"));
    await expect(run()).rejects.toThrow("member-night clash");
    expect(mocks.calls).not.toContain("commit");
    expect(mocks.calls).not.toContain("link");
    expect(mocks.deferred).not.toHaveBeenCalled();
  });

  it("a post-commit failure is reported as follow-up, never as a failed approval", async () => {
    mocks.deferred.mockRejectedValue(new Error("Stripe down"));
    expect(await run()).toMatchObject({ outcome: "executed", followUpFailed: true });
  });
});

describe("lockedPeriodRequestToBatchInput (#3750)", () => {
  const booking = {
    checkIn: new Date("2026-06-10T00:00:00.000Z"),
    checkOut: new Date("2026-06-14T00:00:00.000Z"),
  };

  it("drops dates that equal the booking's own", () => {
    const input = lockedPeriodRequestToBatchInput(
      storedRequest({ checkIn: "2026-06-10", checkOut: "2026-06-14" }) as never,
      booking,
    );
    expect(input).not.toHaveProperty("checkIn");
    expect(input).not.toHaveProperty("checkOut");
    expect(input?.addGuests).toHaveLength(1);
  });

  it("carries a member guest's member id", () => {
    const input = lockedPeriodRequestToBatchInput(
      storedRequest({
        addGuests: [
          {
            firstName: "Sam",
            lastName: "Member",
            ageTier: "ADULT",
            isMember: true,
            memberId: "m-2",
            stayStart: "2026-06-11",
            stayEnd: "2026-06-13",
          },
        ],
      }) as never,
      booking,
    );
    expect(input?.addGuests?.[0]).toEqual({
      firstName: "Sam",
      lastName: "Member",
      ageTier: "ADULT",
      isMember: true,
      memberId: "m-2",
      stayStart: "2026-06-11",
      stayEnd: "2026-06-13",
    });
  });
});
