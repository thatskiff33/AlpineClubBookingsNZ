import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManualRefundTaskKind, ManualRefundTaskStatus } from "@prisma/client";

/**
 * #4042 (`INV-PAY-124`): the hand-back an organiser's Internet Banking group
 * cancel keeps for the organiser. Its total is DERIVED on every claim - the
 * joiners the ledger proves refunded, those a group task records, and this
 * claim's - less what closed group tasks repaid; a share booked after the task
 * closed raises a supplementary task for what nothing covers. Where the cancel
 * calls these is `group-cancel.test.ts`; the row against the real schema and a
 * completion that moves nothing are `booking-ledger-group-settlement.realdb.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  taskFindMany: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  bookingFindMany: vi.fn(),
  ledgerFindMany: vi.fn(),
  organiserFindUniqueOrThrow: vi.fn(),
  taskFindUniqueOrThrow: vi.fn(),
  prismaTaskFindMany: vi.fn(),
  txExecuteRaw: vi.fn(),
  txQueryRaw: vi.fn(),
  bookingCount: vi.fn(),
  txTaskFindUniqueOrThrow: vi.fn(),
  txTaskUpdate: vi.fn(),
  sendAdminManualRefundTaskAlert: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUniqueOrThrow: mocks.organiserFindUniqueOrThrow, count: mocks.bookingCount },
    manualRefundTask: { findUniqueOrThrow: mocks.taskFindUniqueOrThrow, findMany: mocks.prismaTaskFindMany },
    // The alert record's one writer: lock(1) first, then a re-read and a write.
    $transaction: async (cb: (tx: unknown) => unknown) =>
      cb({ $executeRaw: mocks.txExecuteRaw, $queryRaw: mocks.txQueryRaw, manualRefundTask: { findUniqueOrThrow: mocks.txTaskFindUniqueOrThrow, update: mocks.txTaskUpdate } }),
  },
}));
vi.mock("@/lib/email", () => ({ sendAdminManualRefundTaskAlert: mocks.sendAdminManualRefundTaskAlert }));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError, info: vi.fn(), warn: vi.fn() } }));

import {
  alertUnsentGroupOrganiserHandBacks,
  resendUnsentGroupOrganiserHandBackAlerts,
  composeGroupHandBackReason,
  recordGroupOrganiserHandBackShare,
} from "@/lib/group-organiser-hand-back";
import {
  isNonCancellationHandBackTask,
  NOT_NON_CANCELLATION_HAND_BACK_WHERE,
} from "@/lib/manual-refund-task-settlement-rules";
import {
  GROUP_ORGANISER_HAND_BACK_WHERE,
  groupOrganiserHandBackOccurrenceKey,
  isGroupOrganiserHandBackTask,
  readGroupOrganiserHandBackShares,
} from "@/lib/group-organiser-hand-back-rules";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const tx = {
  manualRefundTask: { findMany: mocks.taskFindMany, updateMany: mocks.updateMany, create: mocks.create },
  booking: { findMany: mocks.bookingFindMany },
  bookingLedgerLine: { findMany: mocks.ledgerFindMany },
} as unknown as Parameters<typeof recordGroupOrganiserHandBackShare>[0];

const INPUT = {
  settlementId: "settle-1",
  organiserBookingId: "org-booking",
  plan: new Map([["child-a", 4500], ["child-b", 3000], ["child-c", 0]]),
  claimedChildId: "child-a",
  format: CLUB_FORMAT_TEST,
};
const KEY = "group-organiser-hand-back:settle-1";
const NAMES: Record<string, [string, string]> = { "child-a": ["Ana", "Joiner"], "child-b": ["Ben", "Joiner, Jr"], "child-d": ["Dee", "Joiner"] };

const refundLine = (bookingId: string, cents: number) => ({ bookingId, amountCents: -cents });
const share = (bookingId: string, cents: number) => ({ bookingId, name: NAMES[bookingId]!.join(" "), cents });
const openTask = (amountCents: number, shares: ReturnType<typeof share>[], status: ManualRefundTaskStatus = ManualRefundTaskStatus.OPEN, occurrenceKey = KEY) => ({
  id: occurrenceKey === KEY ? "task-1" : "task-s",
  occurrenceKey,
  status,
  amountCents,
  reviewContext: { groupOrganiserHandBack: { settlementId: "settle-1", shares } },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.taskFindMany.mockResolvedValue([]);
  mocks.ledgerFindMany.mockResolvedValue([]);
  mocks.bookingFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map((id) => ({ id, member: { firstName: NAMES[id]![0], lastName: NAMES[id]![1] }, organisation: null })),
  );
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.create.mockResolvedValue({ id: "task-new" });
  mocks.sendAdminManualRefundTaskAlert.mockResolvedValue(undefined);
});

function created() {
  return (mocks.create.mock.calls[0] as [{ data: Record<string, unknown> & { reviewContext: unknown; reason: string } }])[0].data;
}
function updated() {
  return (mocks.updateMany.mock.calls[0] as [{ where: unknown; data: Record<string, unknown> & { reviewContext: unknown; reason: string } }])[0];
}

describe("recordGroupOrganiserHandBackShare", () => {
  it("the first share creates ONE cancellation hand-back on the organiser's booking, with no payment and its share recorded as data", async () => {
    const raised = await recordGroupOrganiserHandBackShare(tx, INPUT);

    expect(mocks.taskFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ occurrenceKey: KEY }, { occurrenceKey: { startsWith: `${KEY}:` } }] },
    }));
    expect(mocks.ledgerFindMany).toHaveBeenCalledWith({
      where: { postingKey: { in: ["group-settlement:settle-1:refund:child-a", "group-settlement:settle-1:refund:child-b"] } },
      select: { bookingId: true, amountCents: true },
    });
    const data = created();
    expect(data).toMatchObject({
      bookingId: "org-booking",
      amountCents: 4500,
      raisedAmountCents: 4500,
      kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
      occurrenceKey: KEY,
      reason: "Group cancelled by its organiser - paid by Internet Banking. Repay the organiser $45.00 by bank transfer. Joiners' shares: Ana Joiner $45.00.",
    });
    expect(data).not.toHaveProperty("paymentId");
    expect(readGroupOrganiserHandBackShares(data.reviewContext)).toEqual({ settlementId: "settle-1", shares: [share("child-a", 4500)] });
    expect(raised).toEqual({ id: "task-new", amountCents: 4500, created: true });
  });

  it("a later share SETS the open task to the derived total by a status-guarded update, never an increment", async () => {
    mocks.taskFindMany.mockResolvedValue([openTask(4500, [share("child-a", 4500)])]);
    mocks.ledgerFindMany.mockResolvedValue([refundLine("child-a", 4500)]);

    const raised = await recordGroupOrganiserHandBackShare(tx, { ...INPUT, claimedChildId: "child-b" });

    const { where, data } = updated();
    expect(where).toEqual({ id: "task-1", status: ManualRefundTaskStatus.OPEN });
    expect(data).toMatchObject({ amountCents: 7500, raisedAmountCents: 7500 });
    expect(data.reason).toContain("Repay the organiser $75.00 by bank transfer. Joiners' shares: Ana Joiner $45.00, Ben Joiner, Jr $30.00.");
    expect(readGroupOrganiserHandBackShares(data.reviewContext)?.shares).toEqual([share("child-a", 4500), share("child-b", 3000)]);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(raised).toEqual({ id: "task-1", amountCents: 7500, created: false });
  });

  it("OVERLAP: a joiner whose refund line is on the ledger but who never grew the task (an older release claimed it) is counted", async () => {
    // child-b was claimed by the previous release: its line exists, the task does not record it.
    mocks.taskFindMany.mockResolvedValue([openTask(4500, [share("child-a", 4500)])]);
    mocks.ledgerFindMany.mockResolvedValue([refundLine("child-a", 4500), refundLine("child-b", 3000)]);

    await recordGroupOrganiserHandBackShare(tx, { ...INPUT, plan: new Map([...INPUT.plan, ["child-d", 1000]]), claimedChildId: "child-d" });

    const { data } = updated();
    expect(data).toMatchObject({ amountCents: 8500, raisedAmountCents: 8500 });
    expect(readGroupOrganiserHandBackShares(data.reviewContext)?.shares.map((s) => s.bookingId)).toEqual(["child-a", "child-b", "child-d"]);
  });

  it("a soft-deleted joiner whose refund line is on the ledger is counted: the line is the proof, no deletedAt filter", async () => {
    mocks.ledgerFindMany.mockResolvedValue([refundLine("child-b", 3000)]);

    await recordGroupOrganiserHandBackShare(tx, INPUT);

    expect(created()).toMatchObject({ amountCents: 7500 });
    const [[{ where }]] = mocks.bookingFindMany.mock.calls as [[{ where: Record<string, unknown> }]];
    expect(where).toEqual({ id: { in: ["child-b", "child-a"] } });
  });

  it("a share booked after the task was completed raises a supplementary task for only what no task covers", async () => {
    mocks.taskFindMany.mockResolvedValue([openTask(4500, [share("child-a", 4500)], ManualRefundTaskStatus.COMPLETED)]);
    mocks.ledgerFindMany.mockResolvedValue([refundLine("child-a", 4500)]);

    const raised = await recordGroupOrganiserHandBackShare(tx, { ...INPUT, claimedChildId: "child-b" });

    expect(mocks.updateMany).not.toHaveBeenCalled();
    const data = created();
    expect(data).toMatchObject({ occurrenceKey: `${KEY}:child-b`, amountCents: 3000, raisedAmountCents: 3000 });
    expect(data.reason).toContain("recorded after the group's repayment task was closed: repay the organiser $30.00");
    expect(readGroupOrganiserHandBackShares(data.reviewContext)?.shares).toEqual([share("child-b", 3000)]);
    expect(raised).toEqual({ id: "task-new", amountCents: 3000, created: true });
    expect(isGroupOrganiserHandBackTask({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: `${KEY}:child-b` })).toBe(true);
  });

  it("nothing more is raised when every share is already covered, or for a joiner the plan owes nothing", async () => {
    mocks.taskFindMany.mockResolvedValue([
      openTask(4500, [share("child-a", 4500)], ManualRefundTaskStatus.COMPLETED),
      openTask(3000, [share("child-b", 3000)], ManualRefundTaskStatus.OPEN, `${KEY}:child-b`),
    ]);
    expect(await recordGroupOrganiserHandBackShare(tx, { ...INPUT, claimedChildId: "child-b" })).toBeNull();
    expect(await recordGroupOrganiserHandBackShare(tx, { ...INPUT, claimedChildId: "child-c" })).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

describe("the hand-back's reason", () => {
  it("lists shares up to the column, then counts the rest from the data, whatever the names contain", () => {
    const shares = Array.from({ length: 20 }, (_, index) => ({ name: `Joiner, Number ${index + 1}`, cents: 1000 + index }));
    const reason = composeGroupHandBackReason({ totalCents: 123_456, shares, supplementary: false, format: CLUB_FORMAT_TEST });
    expect(reason.length).toBeLessThanOrEqual(500);
    expect(reason).toContain("Repay the organiser $1,234.56 by bank transfer.");
    const more = / … and (\d+) more \(see each joiner's booking\)\.$/.exec(reason);
    expect(more).not.toBeNull();
    const listed = shares.filter((s) => reason.includes(`${s.name} $`)).length;
    expect(listed + Number(more![1])).toBe(20);
  });

  it("lists every share when they fit", () => {
    expect(composeGroupHandBackReason({ totalCents: 7500, shares: [{ name: "Ana Joiner", cents: 4500 }, { name: "Ben Joiner", cents: 3000 }], supplementary: false, format: CLUB_FORMAT_TEST }))
      .toBe("Group cancelled by its organiser - paid by Internet Banking. Repay the organiser $75.00 by bank transfer. Joiners' shares: Ana Joiner $45.00, Ben Joiner $30.00.");
  });
});

describe("the hand-back's marker", () => {
  it("is its own prefix: a cancellation's hand-back, never an edit's or an appeal's", () => {
    const task = { kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: groupOrganiserHandBackOccurrenceKey("s") };
    expect(isGroupOrganiserHandBackTask(task)).toBe(true);
    expect(isNonCancellationHandBackTask(task)).toBe(false);
    expect(isGroupOrganiserHandBackTask({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: null })).toBe(false);
    expect(isGroupOrganiserHandBackTask({ kind: "EDIT_FINANCIAL_REVIEW", occurrenceKey: task.occurrenceKey })).toBe(false);
    // ONE definition: the predicate is the where fragment, for a row.
    expect(GROUP_ORGANISER_HAND_BACK_WHERE).toEqual({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: { startsWith: "group-organiser-hand-back:" } });
    // The query fragment the cancellation readers spread keeps it (a NOT on the two other prefixes).
    expect(JSON.stringify(NOT_NON_CANCELLATION_HAND_BACK_WHERE)).not.toContain("group-organiser-hand-back:");
  });
});

describe("alertUnsentGroupOrganiserHandBacks", () => {
  const SHARES = [share("child-a", 4500), share("child-b", 3000)];
  /** The database's clock, which the lease and the record are stamped with (not the app's). */
  const DB_NOW = "2026-07-01T10:00:00.000Z";
  const INPUT_SWEEP = { settlementId: "settle-1", organiserBookingId: "org-booking", format: CLUB_FORMAT_TEST };
  /** One task row, written only through the locked transaction, as the database would hold it. */
  let row: { status: ManualRefundTaskStatus; amountCents: number; reason: string; reviewContext: unknown };
  const record = () => readGroupOrganiserHandBackShares(row.reviewContext);

  beforeEach(() => {
    row = { status: ManualRefundTaskStatus.OPEN, amountCents: 7500, reason: "final reason", reviewContext: { groupOrganiserHandBack: { settlementId: "settle-1", shares: SHARES } } };
    mocks.prismaTaskFindMany.mockImplementation(async () => [{ id: "task-1", reviewContext: row.reviewContext }]);
    mocks.txTaskFindUniqueOrThrow.mockImplementation(async () => ({ ...row }));
    mocks.txTaskUpdate.mockImplementation(async ({ data }: { data: { reviewContext: unknown } }) => {
      row = { ...row, reviewContext: data.reviewContext };
    });
    mocks.organiserFindUniqueOrThrow.mockResolvedValue({
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
      member: { firstName: "Olive", lastName: "Organiser" },
      organisation: null,
    });
    mocks.sendAdminManualRefundTaskAlert.mockResolvedValue("sent");
    mocks.txQueryRaw.mockImplementation(async () => [{ now: new Date(DB_NOW) }]);
  });

  it("claims under lock(1), sends with the amount and reason read in the claim, then records the send and drops the lease", async () => {
    mocks.sendAdminManualRefundTaskAlert.mockImplementationOnce(async () => {
      // While sending, the lease is on the task.
      expect(record()?.alertClaimedAt).toEqual(expect.any(String));
      expect(record()?.alertSentAt).toBeUndefined();
      return "sent";
    });

    expect(await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP)).toBe(1);

    expect(mocks.prismaTaskFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ occurrenceKey: KEY }, { occurrenceKey: { startsWith: `${KEY}:` } }], status: ManualRefundTaskStatus.OPEN },
    }));
    expect(mocks.sendAdminManualRefundTaskAlert).toHaveBeenCalledWith(
      {
        memberName: "Olive Organiser",
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        refundAmountCents: 7500,
        bookingId: "org-booking",
        reason: "final reason",
        situation: "group-organiser-internet-banking",
      },
      CLUB_FORMAT_TEST,
    );
    // Every write took lock(1) first: the claim and the record.
    expect(mocks.txExecuteRaw).toHaveBeenCalledTimes(2);
    expect(mocks.txExecuteRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.txTaskFindUniqueOrThrow.mock.invocationCallOrder[0]!);
    expect(record()).toEqual({ settlementId: "settle-1", shares: SHARES, alertSentAt: DB_NOW });
  });

  it("RESUME: a task whose creating run died before its alert is sent by the next run - and once recorded, never again", async () => {
    expect(await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP)).toBe(1);
    expect(await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP)).toBe(0);
    expect(mocks.sendAdminManualRefundTaskAlert).toHaveBeenCalledTimes(1);
  });

  it("OVERLAP: a run that finds another run's lease, measured on the database's clock, does not send until the 30 minutes are up", async () => {
    const leasedAt = (minutesBefore: number) => new Date(Date.parse(DB_NOW) - minutesBefore * 60 * 1000).toISOString();
    row.reviewContext = { groupOrganiserHandBack: { settlementId: "settle-1", shares: SHARES, alertClaimedAt: leasedAt(29) } };
    expect(await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP)).toBe(0);
    expect(mocks.sendAdminManualRefundTaskAlert).not.toHaveBeenCalled();

    row.reviewContext = { groupOrganiserHandBack: { settlementId: "settle-1", shares: SHARES, alertClaimedAt: leasedAt(31) } };
    expect(await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP)).toBe(1);
  });

  it("a send that reached nobody gives the lease back and counts it, so a later sweep retries", async () => {
    mocks.sendAdminManualRefundTaskAlert.mockResolvedValueOnce("undelivered");

    expect(await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP)).toBe(0);
    expect(record()).toEqual({ settlementId: "settle-1", shares: SHARES, alertUndeliveredCount: 1 });

    expect(await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP)).toBe(1);
    expect(mocks.sendAdminManualRefundTaskAlert).toHaveBeenCalledTimes(2);
  });

  it("after three sends that reached nobody it stops, logs once, and no run sends again", async () => {
    mocks.sendAdminManualRefundTaskAlert.mockResolvedValue("undelivered");

    for (let run = 0; run < 5; run += 1) await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP);

    expect(mocks.sendAdminManualRefundTaskAlert).toHaveBeenCalledTimes(3);
    expect(record()?.alertUndeliveredCount).toBe(3);
    const gaveUp = mocks.loggerError.mock.calls.filter(([, message]) => String(message).includes("reached nobody after every attempt"));
    expect(gaveUp).toEqual([[expect.objectContaining({ manualRefundTaskId: "task-1", attempts: 3 }), expect.any(String)]]);
  });

  it("a record write that fails is retried, up to three times", async () => {
    const write = async ({ data }: { data: { reviewContext: unknown } }) => {
      row = { ...row, reviewContext: data.reviewContext };
    };
    mocks.txTaskUpdate.mockImplementationOnce(write).mockRejectedValueOnce(new Error("blip")).mockImplementationOnce(write);

    expect(await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP)).toBe(1);
    expect(record()?.alertSentAt).toBe(DB_NOW);
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it("AT LEAST ONCE: a record that never lands is logged with its task id; its lease holds a resend off, then expires and the alert repeats", async () => {
    mocks.txTaskUpdate
      .mockImplementationOnce(async ({ data }: { data: { reviewContext: unknown } }) => {
        row = { ...row, reviewContext: data.reviewContext };
      })
      .mockRejectedValueOnce(new Error("db down"))
      .mockRejectedValueOnce(new Error("db down"))
      .mockRejectedValueOnce(new Error("db down"));

    expect(await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP)).toBe(1);
    expect(mocks.loggerError).toHaveBeenCalledWith(expect.objectContaining({ manualRefundTaskId: "task-1" }), expect.stringContaining("could not record it"));
    expect(await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP)).toBe(0);

    mocks.txQueryRaw.mockImplementation(async () => [{ now: new Date(Date.parse(DB_NOW) + 31 * 60 * 1000) }]);
    expect(await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP)).toBe(1);
    expect(mocks.sendAdminManualRefundTaskAlert).toHaveBeenCalledTimes(2);
  });

  it("one task's failure never stops the next", async () => {
    mocks.prismaTaskFindMany.mockResolvedValue([{ id: "task-1", reviewContext: row.reviewContext }, { id: "task-2", reviewContext: row.reviewContext }]);
    mocks.txTaskFindUniqueOrThrow.mockRejectedValueOnce(new Error("task-1 unreadable"));

    expect(await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP)).toBe(1);
    expect(mocks.loggerError).toHaveBeenCalledWith(expect.objectContaining({ manualRefundTaskId: "task-1" }), expect.any(String));
  });

  it("never throws: the cancellation has committed, and the task is the record", async () => {
    mocks.prismaTaskFindMany.mockRejectedValue(new Error("db down"));

    await expect(alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP)).resolves.toBe(0);
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
  });
});

describe("resendUnsentGroupOrganiserHandBackAlerts (the reaper's task-keyed retry)", () => {
  const cutoff = new Date("2026-07-01T00:00:00.000Z");
  const unsent = (settlementId: string) => ({ groupOrganiserHandBack: { settlementId, shares: [share("child-a", 4500)] } });

  beforeEach(() => {
    mocks.bookingCount.mockResolvedValue(0);
    // Each settlement's own sweep finds nothing left to send (asserted by its query, not its sends).
    mocks.prismaTaskFindMany.mockResolvedValue([]);
  });

  it("reads OPEN group tasks untouched since the cutoff by the one group definition, and sweeps each unsent settlement once", async () => {
    const sent = { groupOrganiserHandBack: { settlementId: "settle-2", shares: [share("child-a", 4500)], alertSentAt: "2026-06-30T00:00:00.000Z" } };
    const givenUp = { groupOrganiserHandBack: { settlementId: "settle-3", shares: [share("child-a", 4500)], alertUndeliveredCount: 3 } };
    mocks.prismaTaskFindMany.mockResolvedValueOnce([
      { bookingId: "org-1", reviewContext: unsent("settle-1") },
      { bookingId: "org-1", reviewContext: unsent("settle-1") },
      { bookingId: "org-2", reviewContext: sent },
      { bookingId: "org-3", reviewContext: givenUp },
    ]);

    expect(await resendUnsentGroupOrganiserHandBackAlerts(cutoff, CLUB_FORMAT_TEST)).toBe(0);

    expect(mocks.prismaTaskFindMany.mock.calls[0]![0]).toEqual({
      where: {
        kind: "CANCELLED_BOOKING_HAND_BACK",
        occurrenceKey: { startsWith: "group-organiser-hand-back:" },
        ...NOT_NON_CANCELLATION_HAND_BACK_WHERE,
        status: ManualRefundTaskStatus.OPEN,
        // Every growth moves updatedAt, so a cancel still growing the task is never swept.
        updatedAt: { lt: cutoff },
      },
      select: { bookingId: true, reviewContext: true },
    });
    // settle-1 swept once; the sent and the given-up ones not at all.
    expect(mocks.prismaTaskFindMany).toHaveBeenCalledTimes(2);
    expect((mocks.prismaTaskFindMany.mock.calls[1]![0] as { where: unknown }).where).toMatchObject({ OR: [{ occurrenceKey: KEY }, { occurrenceKey: { startsWith: `${KEY}:` } }] });
  });

  it("MID-CANCEL: skips a group that still has an active organiser-settled joiner, as the resume does", async () => {
    mocks.prismaTaskFindMany.mockResolvedValueOnce([{ bookingId: "org-1", reviewContext: unsent("settle-1") }]);
    mocks.bookingCount.mockResolvedValueOnce(1);

    expect(await resendUnsentGroupOrganiserHandBackAlerts(cutoff, CLUB_FORMAT_TEST)).toBe(0);

    expect(mocks.bookingCount).toHaveBeenCalledWith({
      where: { parentBookingId: "org-1", organiserSettled: true, deletedAt: null, status: { in: ["PAYMENT_PENDING", "CONFIRMED", "PAID"] } },
    });
    expect(mocks.prismaTaskFindMany).toHaveBeenCalledTimes(1);
  });
});

describe("a growing claim keeps the alert's record", () => {
  it("rewrites the shares and keeps alertSentAt and a live lease, read fresh under its lock(1)", async () => {
    mocks.taskFindMany.mockResolvedValue([
      { ...openTask(4500, [share("child-a", 4500)]), reviewContext: { groupOrganiserHandBack: { settlementId: "settle-1", shares: [share("child-a", 4500)], alertSentAt: "2026-07-01T00:00:00.000Z", alertClaimedAt: "2026-07-01T00:00:00.000Z" } } },
    ]);

    await recordGroupOrganiserHandBackShare(tx, { ...INPUT, claimedChildId: "child-b" });

    const kept = readGroupOrganiserHandBackShares(updated().data.reviewContext);
    expect(kept?.alertSentAt).toBe("2026-07-01T00:00:00.000Z");
    expect(kept?.alertClaimedAt).toBe("2026-07-01T00:00:00.000Z");
    // Not fenced on reviewContext: a fence miss would wrongly raise a supplementary task.
    expect(updated().where).toEqual({ id: "task-1", status: ManualRefundTaskStatus.OPEN });
  });
});

describe("the finance queue payload marks it for the card's own sentence", () => {
  it("true for the group key only", async () => {
    const { toOpenManualRefundTaskPayload } = await import("@/lib/manual-refund-task-queue-payload");
    const row = {
      id: "task-1",
      bookingId: "org-booking",
      amountCents: 7500,
      raisedAmountCents: 7500,
      kind: "CANCELLED_BOOKING_HAND_BACK",
      paymentId: null,
      payment: null,
      lateCaptureApprovalIntentId: null,
      partPaymentReviewPaymentId: null,
      partPaymentReviewXeroPaidAt: null,
      partPaymentReviewXeroPaidCents: null,
      occurrenceKey: groupOrganiserHandBackOccurrenceKey("settle-1"),
      reviewContext: null,
      reason: "r",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      booking: {
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        member: { firstName: "Olive", lastName: "Organiser" },
        organisation: null,
        memberId: "olive",
        deletedAt: null,
        organiserSettled: false,
        parentBookingId: null,
        status: "CANCELLED",
        payment: null,
      },
    };
    const payload = toOpenManualRefundTaskPayload(row, null, []);
    expect(payload).toMatchObject({ groupOrganiserHandBack: true, editRefundHandBack: false, refundRequestHandBack: false, memberName: "Olive Organiser" });
    expect(toOpenManualRefundTaskPayload({ ...row, occurrenceKey: null }, null, []).groupOrganiserHandBack).toBe(false);
    // Its shares are kept in reviewContext: never read as unreadable review evidence.
    const withShares = toOpenManualRefundTaskPayload({ ...row, reviewContext: { groupOrganiserHandBack: { settlementId: "settle-1", shares: [] } } }, null, []);
    expect(withShares).toMatchObject({ reviewEvidence: null, reviewEvidenceUnreadable: false });
  });
});
