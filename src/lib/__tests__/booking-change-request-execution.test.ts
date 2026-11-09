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
} from "@/lib/booking-change-request-execution";
import { lockedPeriodRequestToBatchInput } from "@/lib/booking-change-request-stored";
import type { BatchModificationPreTransaction } from "@/lib/booking-batch-modification-service";

const TODAY = requireCalendarDate("2026-07-01");
const PRE_TRANSACTION = { marker: "pre" } as unknown as BatchModificationPreTransaction;

const tx = {
  $executeRaw: (...args: unknown[]) => {
    const sql = (args[0] as TemplateStringsArray).join("?");
    // #4845: the booking-row lock (`lockBookingRowForOwnerRead`) runs through this same client.
    mocks.calls.push(sql.includes('FROM "Booking"') && sql.includes("FOR NO KEY UPDATE") ? "booking-row" : "global-lock");
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
    reason: "Our niece stayed both nights.",
    ...overrides,
  };
}

const finishedBooking = {
  checkIn: new Date("2026-06-10T00:00:00.000Z"),
  checkOut: new Date("2026-06-14T00:00:00.000Z"),
  status: "COMPLETED",
  // As the executor reads them under its locks: every live guest row has its
  // range, and its night rows (#4157 reads them for a repeated range).
  guests: ["g2", "g1"].map((id) => ({
    id,
    stayStart: new Date("2026-06-10T00:00:00.000Z"),
    stayEnd: new Date("2026-06-14T00:00:00.000Z"),
    nights: ["2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13"].map((night) => ({
      stayDate: new Date(`${night}T00:00:00.000Z`),
    })),
  })),
  payment: { amountCents: 12_000, creditAppliedCents: 0 },
};

type RunParams = Parameters<typeof approveAndExecuteLockedPeriodChangeRequest>[0];
/** The figures the mocked edit produces: what the officer's check would have shown. */
const CHECKED_FIGURES = { additionalAmountCents: 4_500, refundAmountCents: 0, accountCreditAmountCents: 0 };

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
    ...rest,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.reauthorize.mockResolvedValue(true);
  mocks.requestFindUnique
    .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", bookingId: "booking-1", booking: { lodgeId: "lodge-1" } })
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
  it("locks global -> lodge -> booking row, reauthorises, claims, modifies on the same tx, links, commits, THEN runs provider work", async () => {
    const result = await run();

    expect(result).toMatchObject({
      outcome: "executed",
      modificationId: "mod-9",
      addedGuestCount: 1,
      removedGuestCount: 0,
      additionalAmountCents: 4_500,
    });
    // #4845: the booking row before the claim, whose reviewer FK takes KEY SHARE on the officer's Member row
    // and which holds the request row member merge re-points: booking row first, as merge orders them.
    expect(mocks.calls).toEqual([
      "global-lock",
      "lodge-lock",
      "booking-row",
      "reauthorize",
      "claim",
      "modify",
      "link",
      "commit",
      "post-commit",
    ]);
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(tx, "lodge-1");
    // Keyed from the pre-lock read (the request's booking id, written once), not from a post-lock read.
    expect(mocks.requestFindUnique.mock.calls[0]![0]).toMatchObject({ select: { bookingId: true } });
    const bookingRow = mocks.executeRaw.mock.calls.find(([strings]) => (strings as TemplateStringsArray).join("?").includes('FROM "Booking"'));
    expect(bookingRow?.slice(1)).toEqual(["booking-1"]);
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
        // #4157: the request as the member sent it, plus the applying
        // approval's record of kept nights — empty, but present, so the card
        // reads this as an approval made under that rule.
        requestedChanges: { ...storedRequest(), keptNights: [] },
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
        // Owner D1: added member guests face the member's own rules (#2526).
        reviewedMemberProposal: true,
        memberReviewJustification: "Our niece stayed both nights.",
      },
    });
    expect(args).not.toHaveProperty("waiveChangeFee");
    expect(args).not.toHaveProperty("input.adminOverride");
  });

  it("executes every part of a mixed request: dates, removals, ranges and adds (decision 4)", async () => {
    mocks.requestFindUnique.mockReset();
    mocks.requestFindUnique
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", bookingId: "booking-1", booking: { lodgeId: "lodge-1" } })
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
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", bookingId: "booking-1", booking: { lodgeId: "lodge-1" } })
      .mockResolvedValueOnce(requestRow({ status: "APPROVED", version: 4 }));
    expect(await run()).toEqual({ outcome: "claimLost" });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.modifyBookingBatch).not.toHaveBeenCalled();
    expect(mocks.deferred).not.toHaveBeenCalled();
  });

  it("a stale version is a lost claim, not an execution", async () => {
    mocks.requestFindUnique.mockReset();
    mocks.requestFindUnique
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", bookingId: "booking-1", booking: { lodgeId: "lodge-1" } })
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

  it("a row stored before guest ranges were recorded keeps the dates-and-ids drift check (round 7, F1)", async () => {
    // The stored original names no ranges, so a guest's live nights are not
    // compared: this row behaves exactly as it did before ranges were stored.
    mocks.bookingFindUnique.mockResolvedValue({
      ...finishedBooking,
      guests: [
        { id: "g2", stayStart: new Date("2026-06-11T00:00:00.000Z"), stayEnd: new Date("2026-06-12T00:00:00.000Z") },
        { id: "g1", stayStart: new Date("2026-06-10T00:00:00.000Z"), stayEnd: new Date("2026-06-14T00:00:00.000Z") },
      ],
    });
    expect(await run()).toMatchObject({ outcome: "executed" });
  });

  it("keeps the request pending when a guest's stored range has moved since the request (round 7, F1)", async () => {
    mocks.requestFindUnique.mockReset();
    mocks.requestFindUnique
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", bookingId: "booking-1", booking: { lodgeId: "lodge-1" } })
      .mockResolvedValueOnce(
        requestRow({
          requestedChanges: {
            ...storedRequest(),
            original: {
              ...storedRequest().original,
              guests: [
                { id: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-14" },
                { id: "g2", stayStart: "2026-06-10", stayEnd: "2026-06-14" },
              ],
            },
          },
        }),
      );
    mocks.bookingFindUnique.mockResolvedValue({
      ...finishedBooking,
      guests: [
        { id: "g2", stayStart: new Date("2026-06-10T00:00:00.000Z"), stayEnd: new Date("2026-06-12T00:00:00.000Z") },
        { id: "g1", stayStart: new Date("2026-06-10T00:00:00.000Z"), stayEnd: new Date("2026-06-14T00:00:00.000Z") },
      ],
    });
    expect(await run()).toEqual({ outcome: "keptPending", message: LOCKED_PERIOD_REQUEST_DRIFT_MESSAGE });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("hands the service a grid request's night sets exactly (#4088)", async () => {
    const nights = ["2026-06-10", "2026-06-12"];
    mocks.requestFindUnique.mockReset();
    mocks.requestFindUnique
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", bookingId: "booking-1", booking: { lodgeId: "lodge-1" } })
      .mockResolvedValueOnce(
        requestRow({
          requestedChanges: storedRequest({
            addGuests: [{ firstName: "Late", lastName: "Guest", ageTier: "CHILD", isMember: false, nights }],
            guestStayRanges: [{ guestId: "g1", nights }],
          }),
        }),
      );
    expect(await run()).toMatchObject({ outcome: "executed" });
    const { input } = mocks.modifyBookingBatch.mock.calls[0][0] as {
      input: { guestStayRanges: unknown; addGuests: unknown };
    };
    expect(input.guestStayRanges).toEqual([{ guestId: "g1", stayStart: null, stayEnd: null, nights }]);
    expect(input.addGuests).toEqual([expect.objectContaining({ firstName: "Late", nights })]);
  });

  it("keeps the request pending when a night inside a guest's range was trimmed since (#4088)", async () => {
    const storedNights = ["2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13"];
    const withNights = {
      ...storedRequest(),
      original: {
        ...storedRequest().original,
        guests: [
          { id: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-14", nights: storedNights },
          { id: "g2", stayStart: "2026-06-10", stayEnd: "2026-06-14", nights: storedNights },
        ],
      },
    };
    const liveGuest = (id: string, nights: string[]) => ({
      id,
      stayStart: new Date("2026-06-10T00:00:00.000Z"),
      stayEnd: new Date("2026-06-14T00:00:00.000Z"),
      nights: nights.map((night) => ({ stayDate: new Date(`${night}T00:00:00.000Z`) })),
    });
    const queue = () => {
      mocks.requestFindUnique.mockReset();
      mocks.requestFindUnique
        .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", bookingId: "booking-1", booking: { lodgeId: "lodge-1" } })
        .mockResolvedValueOnce(requestRow({ requestedChanges: withNights }));
    };
    // 12 June came off g2 after the request was sent; the range is unmoved.
    queue();
    mocks.bookingFindUnique.mockResolvedValue({
      ...finishedBooking,
      guests: [liveGuest("g1", storedNights), liveGuest("g2", ["2026-06-10", "2026-06-11", "2026-06-13"])],
    });
    expect(await run()).toEqual({ outcome: "keptPending", message: LOCKED_PERIOD_REQUEST_DRIFT_MESSAGE });
    expect(mocks.updateMany).not.toHaveBeenCalled();

    // The same nights as the request saw them: applied.
    queue();
    mocks.bookingFindUnique.mockResolvedValue({
      ...finishedBooking,
      guests: [liveGuest("g1", storedNights), liveGuest("g2", storedNights)],
    });
    expect(await run()).toMatchObject({ outcome: "executed" });
  });

  it("keeps the request pending when a guest holds as many nights as the request saw, but other ones (#4088)", async () => {
    const at = (night: string) => ({ stayDate: new Date(`${night}T00:00:00.000Z`) });
    mocks.requestFindUnique.mockReset();
    mocks.requestFindUnique
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", bookingId: "booking-1", booking: { lodgeId: "lodge-1" } })
      .mockResolvedValueOnce(
        requestRow({
          requestedChanges: {
            ...storedRequest(),
            original: {
              ...storedRequest().original,
              guests: [
                { id: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-14", nights: ["2026-06-10", "2026-06-12", "2026-06-13"] },
                { id: "g2" },
              ],
            },
          },
        }),
      );
    mocks.bookingFindUnique.mockResolvedValue({
      ...finishedBooking,
      guests: [
        {
          id: "g1",
          stayStart: new Date("2026-06-10T00:00:00.000Z"),
          stayEnd: new Date("2026-06-14T00:00:00.000Z"),
          nights: ["2026-06-10", "2026-06-11", "2026-06-13"].map(at),
        },
        { id: "g2" },
      ],
    });
    expect(await run()).toEqual({ outcome: "keptPending", message: LOCKED_PERIOD_REQUEST_DRIFT_MESSAGE });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("a snapshot with a guest's range but no night rows is not drift for a sparse guest (#4088)", async () => {
    // Stored by a route before #4088 recorded night rows: the range matches the
    // live guest, whose own nights have a gap the snapshot never described.
    mocks.requestFindUnique.mockReset();
    mocks.requestFindUnique
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", bookingId: "booking-1", booking: { lodgeId: "lodge-1" } })
      .mockResolvedValueOnce(
        requestRow({
          requestedChanges: {
            ...storedRequest(),
            original: {
              ...storedRequest().original,
              guests: [
                { id: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-14" },
                { id: "g2", stayStart: "2026-06-10", stayEnd: "2026-06-14" },
              ],
            },
          },
        }),
      );
    const sparse = ["2026-06-10", "2026-06-13"].map((night) => ({ stayDate: new Date(`${night}T00:00:00.000Z`) }));
    mocks.bookingFindUnique.mockResolvedValue({
      ...finishedBooking,
      guests: ["g1", "g2"].map((id) => ({
        id,
        stayStart: new Date("2026-06-10T00:00:00.000Z"),
        stayEnd: new Date("2026-06-14T00:00:00.000Z"),
        nights: sparse,
      })),
    });
    expect(await run()).toMatchObject({ outcome: "executed" });
  });

  it("hands the service a gapped guest's own nights where their range only repeats their dates (#4157)", async () => {
    // Range mode: g1 holds 10 and 12 June inside a 10-13 June range and the
    // member sent those dates back; g2's range really moves. Approving keeps
    // g1's nights (the gap is neither filled nor charged) and re-spreads g2's.
    const at = (night: string) => ({ stayDate: new Date(`${night}T00:00:00.000Z`) });
    const gapped = ["2026-06-10", "2026-06-12"];
    mocks.requestFindUnique.mockReset();
    mocks.requestFindUnique
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", bookingId: "booking-1", booking: { lodgeId: "lodge-1" } })
      .mockResolvedValueOnce(
        requestRow({
          requestedChanges: {
            ...storedRequest({
              guestStayRanges: [
                { guestId: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-13" },
                { guestId: "g2", stayStart: "2026-06-11", stayEnd: "2026-06-13" },
              ],
            }),
            original: {
              ...storedRequest().original,
              guests: [
                { id: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-13", nights: gapped },
                { id: "g2", stayStart: "2026-06-10", stayEnd: "2026-06-13", nights: gapped },
              ],
            },
          },
        }),
      );
    mocks.bookingFindUnique.mockResolvedValue({
      ...finishedBooking,
      guests: ["g1", "g2"].map((id) => ({
        id,
        stayStart: new Date("2026-06-10T00:00:00.000Z"),
        stayEnd: new Date("2026-06-13T00:00:00.000Z"),
        nights: gapped.map(at),
      })),
    });
    expect(await run()).toMatchObject({ outcome: "executed" });
    const { input } = mocks.modifyBookingBatch.mock.calls[0][0] as { input: { guestStayRanges: unknown } };
    expect(input.guestStayRanges, "INV-REQ-012: the executor passes the kept nights").toEqual([
      { guestId: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-13", nights: gapped },
      { guestId: "g2", stayStart: "2026-06-11", stayEnd: "2026-06-13" },
    ]);
    // The guarded claim records what was kept, for the officer's card: g1
    // only, since g2's range moved.
    const claim = mocks.updateMany.mock.calls[0][0] as { data: { requestedChanges: Record<string, unknown> } };
    expect(claim.data.requestedChanges.keptNights, "INV-REQ-012: the approval records the kept nights").toEqual([
      { guestId: "g1", nights: gapped },
    ]);
  });

  it("records the kept nights from the live rows when the snapshot holds none (#4157)", async () => {
    // Sent before #4088: the snapshot has g1's dates and no night rows. Under
    // the locks g1 holds 10 and 12 June, and the claim must record those.
    const gapped = ["2026-06-10", "2026-06-12"];
    mocks.requestFindUnique.mockReset();
    mocks.requestFindUnique
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", bookingId: "booking-1", booking: { lodgeId: "lodge-1" } })
      .mockResolvedValueOnce(
        requestRow({
          requestedChanges: {
            ...storedRequest({
              guestStayRanges: [{ guestId: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-13" }],
            }),
            original: {
              ...storedRequest().original,
              guests: [
                { id: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-13" },
                { id: "g2", stayStart: "2026-06-10", stayEnd: "2026-06-13" },
              ],
            },
          },
        }),
      );
    mocks.bookingFindUnique.mockResolvedValue({
      ...finishedBooking,
      guests: ["g1", "g2"].map((id) => ({
        id,
        stayStart: new Date("2026-06-10T00:00:00.000Z"),
        stayEnd: new Date("2026-06-13T00:00:00.000Z"),
        nights: (id === "g1" ? gapped : ["2026-06-10", "2026-06-11", "2026-06-12"]).map((night) => ({
          stayDate: new Date(`${night}T00:00:00.000Z`),
        })),
      })),
    });
    expect(await run()).toMatchObject({ outcome: "executed" });
    const claim = mocks.updateMany.mock.calls[0][0] as { data: { requestedChanges: Record<string, unknown> } };
    expect(claim.data.requestedChanges.keptNights, "INV-REQ-012: the record is built from the live rows").toEqual([
      { guestId: "g1", nights: gapped },
    ]);
  });

  it("keeps nothing for a guest whose later entry moves or sets nights after a repeat (#4157)", async () => {
    // The request names g1 twice: their own dates, then a night set (or a
    // moved range). The planner applies the last entry; the earlier repeat
    // must not overwrite it with g1's held nights, nor be recorded as kept.
    const at = (night: string) => ({ stayDate: new Date(`${night}T00:00:00.000Z`) });
    const gapped = ["2026-06-10", "2026-06-12"];
    const repeat = { guestId: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-13" };
    for (const later of [
      { guestId: "g1", nights: ["2026-06-11", "2026-06-12"] },
      { guestId: "g1", stayStart: "2026-06-11", stayEnd: "2026-06-13" },
    ]) {
      mocks.modifyBookingBatch.mockClear();
      mocks.updateMany.mockClear();
      mocks.requestFindUnique.mockReset();
      mocks.requestFindUnique
        .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", bookingId: "booking-1", booking: { lodgeId: "lodge-1" } })
        .mockResolvedValueOnce(
          requestRow({
            requestedChanges: {
              ...storedRequest({ guestStayRanges: [repeat, later] }),
              original: {
                ...storedRequest().original,
                guests: [
                  { id: "g1", stayStart: "2026-06-10", stayEnd: "2026-06-13", nights: gapped },
                  { id: "g2", stayStart: "2026-06-10", stayEnd: "2026-06-13", nights: gapped },
                ],
              },
            },
          }),
        );
      mocks.bookingFindUnique.mockResolvedValue({
        ...finishedBooking,
        guests: ["g1", "g2"].map((id) => ({
          id,
          stayStart: new Date("2026-06-10T00:00:00.000Z"),
          stayEnd: new Date("2026-06-13T00:00:00.000Z"),
          nights: gapped.map(at),
        })),
      });
      expect(await run()).toMatchObject({ outcome: "executed" });
      const { input } = mocks.modifyBookingBatch.mock.calls[0][0] as { input: { guestStayRanges: unknown } };
      expect(input.guestStayRanges, "INV-REQ-012: only the applied entry may keep nights").toEqual([
        { ...repeat },
        { stayStart: null, stayEnd: null, ...later },
      ]);
      const claim = mocks.updateMany.mock.calls[0][0] as { data: { requestedChanges: Record<string, unknown> } };
      expect(claim.data.requestedChanges.keptNights).toEqual([]);
    }
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
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", bookingId: "booking-1", booking: { lodgeId: "lodge-1" } })
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
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", bookingId: "booking-1", booking: { lodgeId: "lodge-1" } })
      .mockResolvedValueOnce(requestRow({ requestedChanges: { requested: "nonsense" } }));
    expect(await run()).toEqual({
      outcome: "keptPending",
      message: LOCKED_PERIOD_REQUEST_UNREADABLE_MESSAGE,
    });
  });

  it("refuses a request with nothing structural to apply", async () => {
    mocks.requestFindUnique.mockReset();
    mocks.requestFindUnique
      .mockResolvedValueOnce({ kind: "LOCKED_PERIOD", bookingId: "booking-1", booking: { lodgeId: "lodge-1" } })
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

describe("approveAndExecuteLockedPeriodChangeRequest — review round (#3955)", () => {
  it("defaults the refund to the way the booking was paid: a credit-paid stay gets credit", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      ...finishedBooking,
      payment: { amountCents: 0, creditAppliedCents: 12_000 },
    });
    expect(await run()).toMatchObject({ outcome: "executed", settlementMethod: "credit" });
    const [args] = mocks.modifyBookingBatch.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(args.input.settlementMethod).toBe("credit");
  });

  it("keeps the officer's explicit choice", async () => {
    await run({ settlementMethod: "credit" });
    const [args] = mocks.modifyBookingBatch.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(args.input.settlementMethod).toBe("credit");
  });

  it("a dry run answers the figures and rolls everything back: no link, no commit, no provider work", async () => {
    const result = await run({ dryRun: true });
    expect(result).toEqual({
      outcome: "quoted",
      priceDiffCents: 4_500,
      changeFeeCents: 0,
      additionalAmountCents: 4_500,
      refundAmountCents: 0,
      accountCreditAmountCents: 0,
      capacityOverridden: false,
      settlementMethod: "card",
    });
    expect(mocks.calls).not.toContain("link");
    expect(mocks.calls).not.toContain("commit");
    expect(mocks.deferred).not.toHaveBeenCalled();
  });
});
