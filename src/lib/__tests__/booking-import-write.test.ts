/**
 * The paid-booking import's writer (#5005 child A; `INV-PAY-161`, `INV-CAP-040`),
 * run through the real `confirmBookingImport` with the database client doubled
 * at the Prisma boundary.
 *
 * Every collaborator that does its own database work is doubled and records,
 * in one ordered log, when it ran: the lock(1) statement, the lodge key, the
 * locked re-check, the row claim, the booking create, the settle or the $0
 * confirmation, the hosting review, the events, the row link, the transaction's
 * end, then the after-commit hosting drain and audit. The tests read that log,
 * the arguments and the refusal writes, so they hold the writer's protocol:
 * one booking per transaction on the lock(1) budget, checks repeated under the
 * locks before the status-guarded claim, a lost claim writing nothing, a
 * refusal recorded guarded on PENDING, and audit only after commit.
 * `booking-import.realdb.test.ts` proves the same flows on real PostgreSQL.
 */
import { AgeTier, BookingImportBatchStatus, BookingImportRowStatus, BookingStatus, Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const order: string[] = [];
  const tx = {
    $executeRaw: vi.fn(async () => (order.push("lock(1)"), 1)),
    lodge: { findUnique: vi.fn(), count: vi.fn() },
    member: { findMany: vi.fn() },
    bookingImportRow: { updateMany: vi.fn(), update: vi.fn() },
    booking: { create: vi.fn(), updateMany: vi.fn() },
    bookingEvent: { createMany: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(),
    bookingImportBatch: { findUnique: vi.fn(), create: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
    bookingImportRow: { createMany: vi.fn(), findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
  };
  return { order, tx, prisma };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/booking-import/plan", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-import/plan")),
  planBookingImport: vi.fn(),
  checkImportBooking: vi.fn(),
}));
vi.mock("@/lib/capacity", () => ({ acquireLodgeCapacityLock: vi.fn() }));
vi.mock("@/lib/payment-reconciliation", () => ({ settleImportedBookingInTransaction: vi.fn() }));
vi.mock("@/lib/booking-zero-price-payment", () => ({ createZeroPriceConfirmationPayment: vi.fn() }));
vi.mock("@/lib/booking-ledger-confirmation-sync", () => ({ postStoredBookingConfirmationLedgerLines: vi.fn() }));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({ reconcileBedAllocationsForBookingWithGlobalLockHeld: vi.fn() }));
vi.mock("@/lib/adult-member-hosting-review", () => ({ recordAdultMemberHostingReviewForNewBooking: vi.fn() }));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({ settleHostingCoverageAfterCommit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/booking-guests", () => ({ computeMemberGuestBoundary: vi.fn() }));
vi.mock("@/lib/member-money/doors", () => ({ resolveBookingMoneyPostingContext: vi.fn() }));
vi.mock("@/lib/member-dietary-booking-writes", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-dietary-booking-writes")),
  resolveBookingGuestDietarySeeding: vi.fn(),
}));

import { recordAdultMemberHostingReviewForNewBooking } from "@/lib/adult-member-hosting-review";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { logAudit } from "@/lib/audit";
import { reconcileBedAllocationsForBookingWithGlobalLockHeld } from "@/lib/bed-allocation-lifecycle";
import { computeMemberGuestBoundary } from "@/lib/booking-guests";
import { postStoredBookingConfirmationLedgerLines } from "@/lib/booking-ledger-confirmation-sync";
import { createZeroPriceConfirmationPayment } from "@/lib/booking-zero-price-payment";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";
import { ManualBookingPaymentError } from "@/lib/manual-booking-payment-error";
import { resolveBookingGuestDietarySeeding } from "@/lib/member-dietary-booking-writes";
import { resolveBookingMoneyPostingContext } from "@/lib/member-money/doors";
import { settleImportedBookingInTransaction } from "@/lib/payment-reconciliation";
import { parseBookingImportCsv, type ParsedImportBooking } from "@/lib/booking-import/parse";
import {
  BOOKING_IMPORT_HOSTING_REFUSAL,
  bookingImportBatchKey,
  checkImportBooking,
  planBookingImport,
  type BookingImportPlan,
  type BookingImportRefusal,
} from "@/lib/booking-import/plan";
import { confirmBookingImport } from "@/lib/booking-import/write";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const { order, tx, prisma } = h;
const FORMAT = { locale: CLUB_FORMAT_TEST.locale };
const TODAY = new Date("2026-07-01T00:00:00.000Z");
const LODGE = { id: "lodge-1", name: "Ridge Lodge", slug: "ridge", active: true };
const OFFICER = "m-officer";
const ANN = { id: "m-ann", email: "ann@example.test", firstName: "Ann", lastName: "Owner", ageTier: AgeTier.ADULT, active: true, cancelledAt: null, archivedAt: null };
const JOURNAL = { journal: "context" };
// Profile seeding off, so the real dietary resolver decides "nothing" without a read.
const SEEDING = { seedFromProfile: false };
const BATCH = "batch-1";

const HEADER =
  "Booking Ref,Owner Email,Owner First Name,Owner Last Name,Guest Type,Guest Email,Guest First Name,Guest Last Name,Age Group,Check In,Check Out,Amount Paid";

function parsed(amount: string, ref = "B1"): ParsedImportBooking[] {
  const result = parseBookingImportCsv(
    [HEADER, `${ref},ann@example.test,Ann,Owner,Member,ann@example.test,Ann,Owner,,2026-08-10,2026-08-12,${amount}`].join("\n"),
  );
  if (!result.ok) throw new Error(result.error);
  return result.bookings;
}

function planFor(bookings: ParsedImportBooking[], outcome: "IMPORT" | "REFUSED" = "IMPORT", refusals: BookingImportRefusal[] = []): BookingImportPlan {
  const booking = bookings[0]!;
  const totals = { bookings: 1, guests: 1, guestNights: 2, amountCents: booking.totalCents };
  const empty = { bookings: 0, guests: 0, guestNights: 0, amountCents: 0 };
  return {
    lodgeId: LODGE.id,
    batchKey: bookingImportBatchKey(LODGE.id, bookings),
    digest: "digest-shown",
    rows: [
      {
        bookingRef: booking.bookingRef,
        firstLineNumber: 2,
        outcome,
        alreadyImported: false,
        refusals,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        amountCents: booking.totalCents,
        guestCount: 1,
        guestNightCount: 2,
        appRateCents: null,
        appRateDifferenceCents: null,
        nights: [],
        overCapacityNights: [],
      },
    ],
    importTotals: outcome === "IMPORT" ? totals : empty,
    refusedTotals: outcome === "IMPORT" ? empty : totals,
    refusedByCode: {},
    nights: [],
    overFullNights: [],
  };
}

/** The rows the final read returns, as the writer left them in the doubled database. */
let finalRows: { bookingRef: string; status: BookingImportRowStatus; bookingId: string | null; refusalReason: string | null; refusalCode: string | null }[];

function confirm(bookings: ParsedImportBooking[], digest = "digest-shown") {
  return confirmBookingImport({ lodgeId: LODGE.id, bookings, digest, officerMemberId: OFFICER, today: TODAY, format: FORMAT });
}

beforeEach(() => {
  order.length = 0;
  finalRows = [{ bookingRef: "B1", status: BookingImportRowStatus.IMPORTED, bookingId: "booking-1", refusalReason: null, refusalCode: null }];

  vi.mocked(resolveBookingMoneyPostingContext).mockResolvedValue(JOURNAL as never);
  vi.mocked(resolveBookingGuestDietarySeeding).mockResolvedValue(SEEDING as never);
  vi.mocked(computeMemberGuestBoundary).mockResolvedValue({ scopeByMemberId: new Map() } as never);
  vi.mocked(acquireLodgeCapacityLock).mockImplementation(async () => void order.push("lodge-lock"));
  vi.mocked(checkImportBooking).mockImplementation(async (_db, _context, _booking, options) => {
    order.push(`check(lock=${options.lock})`);
    return { refusals: [], nights: [], overCapacityNights: [] };
  });
  vi.mocked(settleImportedBookingInTransaction).mockImplementation(async () => (order.push("settle"), {}) as never);
  vi.mocked(createZeroPriceConfirmationPayment).mockImplementation(async () => void order.push("zero-payment"));
  vi.mocked(postStoredBookingConfirmationLedgerLines).mockImplementation(async () => (order.push("confirmation-lines"), undefined) as never);
  vi.mocked(reconcileBedAllocationsForBookingWithGlobalLockHeld).mockImplementation(async () => (order.push("beds"), undefined) as never);
  vi.mocked(recordAdultMemberHostingReviewForNewBooking).mockImplementation(async () => (order.push("hosting-review"), { violation: false }) as never);
  vi.mocked(settleHostingCoverageAfterCommit).mockImplementation(async () => (order.push("hosting-drain"), undefined) as never);
  vi.mocked(logAudit).mockImplementation(((entry: { action: string }) => void order.push(`audit:${entry.action}`)) as never);

  tx.lodge.findUnique.mockResolvedValue(LODGE);
  tx.lodge.count.mockResolvedValue(1);
  tx.member.findMany.mockResolvedValue([ANN]);
  tx.bookingImportRow.updateMany.mockImplementation(async () => (order.push("claim"), { count: 1 }));
  tx.bookingImportRow.update.mockImplementation(async () => (order.push("row-link"), {}));
  tx.booking.create.mockImplementation(async () => (order.push("booking.create"), { id: "booking-1" }));
  tx.booking.updateMany.mockImplementation(async () => (order.push("PAID"), { count: 1 }));
  tx.bookingEvent.createMany.mockImplementation(async () => (order.push("events"), { count: 2 }));

  prisma.$transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => {
    order.push("tx-open");
    try {
      return await fn(tx);
    } finally {
      order.push("tx-close");
    }
  });
  prisma.bookingImportBatch.findUnique.mockResolvedValue(null);
  prisma.bookingImportBatch.create.mockResolvedValue({ id: BATCH });
  prisma.bookingImportBatch.updateMany.mockResolvedValue({ count: 1 });
  prisma.bookingImportRow.createMany.mockResolvedValue({ count: 1 });
  prisma.bookingImportRow.findMany.mockImplementation(async ({ where }: { where: { status?: BookingImportRowStatus } }) =>
    where.status === BookingImportRowStatus.PENDING ? [{ id: "row-1", bookingRef: "B1" }] : finalRows,
  );
  prisma.bookingImportRow.count.mockImplementation(async ({ where }: { where: { status: BookingImportRowStatus } }) =>
    where.status === BookingImportRowStatus.PENDING ? 0 : 1,
  );
  prisma.bookingImportRow.updateMany.mockImplementation(async () => (order.push("refuse-row"), { count: 1 }));
});

describe("confirmBookingImport: before anything is written", () => {
  it("returns the fresh plan and writes nothing when it differs from the one confirmed", async () => {
    const bookings = parsed("100.00");
    const fresh = planFor(bookings);
    vi.mocked(planBookingImport).mockResolvedValue(fresh);
    await expect(confirm(bookings, "digest-the-officer-saw-earlier")).resolves.toEqual({ outcome: "stale", plan: fresh });
    expect(prisma.bookingImportBatch.create).not.toHaveBeenCalled();
    expect(prisma.bookingImportRow.createMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses to confirm a reversed batch's file again", async () => {
    const bookings = parsed("100.00");
    prisma.bookingImportBatch.findUnique.mockResolvedValue({ id: BATCH, status: BookingImportBatchStatus.REVERSED });
    await expect(confirm(bookings)).resolves.toEqual({ outcome: "reversed", batchId: BATCH });
    expect(planBookingImport).not.toHaveBeenCalled();
  });

  it("re-plans against the existing batch so decided rows keep the digest the officer saw", async () => {
    const bookings = parsed("100.00");
    prisma.bookingImportBatch.findUnique.mockResolvedValue({ id: BATCH, status: BookingImportBatchStatus.OPEN });
    vi.mocked(planBookingImport).mockResolvedValue(planFor(bookings));
    await confirm(bookings);
    expect(vi.mocked(planBookingImport).mock.calls[0]![1]).toMatchObject({ lodgeId: LODGE.id, batchId: BATCH, today: TODAY });
    expect(prisma.bookingImportBatch.create).not.toHaveBeenCalled();
  });

  it("joins the batch a concurrent confirm of the same file created", async () => {
    const bookings = parsed("100.00");
    vi.mocked(planBookingImport).mockResolvedValue(planFor(bookings));
    prisma.bookingImportBatch.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" }));
    prisma.bookingImportBatch.findUniqueOrThrow.mockResolvedValue({ id: "batch-from-the-other-confirm" });
    const result = await confirm(bookings);
    expect(result).toMatchObject({ outcome: "completed", batchId: "batch-from-the-other-confirm" });
    expect(prisma.bookingImportBatch.findUniqueOrThrow).toHaveBeenCalledWith({ where: { batchKey: bookingImportBatchKey(LODGE.id, bookings) }, select: { id: true } });
  });

  it("records the plan's refused rows as refused, with their reasons, and imports only the pending ones", async () => {
    const bookings = parsed("100.00");
    const refusals: BookingImportRefusal[] = [{ code: "HOSTING", message: "first" }, { code: "SUPERVISION", message: "second" }];
    vi.mocked(planBookingImport).mockResolvedValue(planFor(bookings, "REFUSED", refusals));
    prisma.bookingImportRow.findMany.mockImplementation(async ({ where }: { where: { status?: BookingImportRowStatus } }) =>
      where.status === BookingImportRowStatus.PENDING ? [] : [{ bookingRef: "B1", status: BookingImportRowStatus.REFUSED, bookingId: null, refusalReason: "first\nsecond", refusalCode: "HOSTING" }],
    );
    const result = await confirm(bookings);
    expect(prisma.bookingImportRow.createMany.mock.calls[0]![0]).toMatchObject({
      data: [{ batchId: BATCH, bookingRef: "B1", status: BookingImportRowStatus.REFUSED, refusalReason: "first\nsecond", refusalCode: "HOSTING", amountCents: 10_000 }],
      skipDuplicates: true,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(result).toEqual({
      outcome: "completed",
      batchId: BATCH,
      rows: [{ bookingRef: "B1", outcome: "REFUSED", refusals: [{ code: "HOSTING", message: "first" }, { code: "HOSTING", message: "second" }] }],
    });
  });
});

describe("confirmBookingImport: one paid booking", () => {
  it("locks, re-checks, claims, creates and settles in one transaction on the lock(1) budget, then audits after commit", async () => {
    const bookings = parsed("100.00");
    vi.mocked(planBookingImport).mockResolvedValue(planFor(bookings));

    const result = await confirm(bookings);

    expect(order).toEqual([
      "tx-open",
      "lock(1)",
      "lodge-lock",
      "check(lock=true)",
      "claim",
      "booking.create",
      "settle",
      "hosting-review",
      "events",
      "row-link",
      "tx-close",
      "hosting-drain",
      "audit:booking_import.booking_imported",
      "audit:booking_import.completed",
    ]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0]![1]).toBe(LOCK1_HOLDER_TRANSACTION_BUDGET);
    expect(acquireLodgeCapacityLock).toHaveBeenCalledWith(tx, LODGE.id);
    expect(vi.mocked(checkImportBooking).mock.calls[0]![3]).toMatchObject({ batchId: BATCH, lock: true });
    expect(tx.bookingImportRow.updateMany).toHaveBeenCalledWith({
      where: { id: "row-1", status: BookingImportRowStatus.PENDING },
      data: { status: BookingImportRowStatus.IMPORTED, decidedAt: expect.any(Date) },
    });
    expect(tx.booking.create.mock.calls[0]![0].data).toMatchObject({
      memberId: ANN.id,
      lodgeId: LODGE.id,
      status: BookingStatus.PAYMENT_PENDING,
      totalPriceCents: 10_000,
      finalPriceCents: 10_000,
      hasNonMembers: false,
      createdById: OFFICER,
    });
    expect(settleImportedBookingInTransaction).toHaveBeenCalledWith(
      tx,
      "booking-1",
      { actingAdminMemberId: OFFICER, note: `Imported paid booking: batch ${BATCH}, Booking Ref B1`, expectedAmountCents: 10_000 },
      JOURNAL,
    );
    expect(createZeroPriceConfirmationPayment).not.toHaveBeenCalled();
    expect(tx.bookingEvent.createMany.mock.calls[0]![0].data).toEqual([
      { bookingId: "booking-1", type: "CREATED", actorMemberId: OFFICER, amountCents: 10_000, reason: null },
      { bookingId: "booking-1", type: "MEMBER_PAID", actorMemberId: OFFICER, amountCents: 10_000, reason: "booking_import" },
    ]);
    expect(tx.bookingImportRow.update).toHaveBeenCalledWith({ where: { id: "row-1" }, data: { bookingId: "booking-1" } });
    expect(vi.mocked(logAudit).mock.calls[0]![0]).toMatchObject({
      action: "booking_import.booking_imported",
      subjectMemberId: ANN.id,
      targetId: "booking-1",
      metadata: { batchId: BATCH, bookingRef: "B1", amountCents: 10_000, guestCount: 1 },
    });
    expect(prisma.bookingImportBatch.updateMany).toHaveBeenCalledWith({
      where: { id: BATCH, status: BookingImportBatchStatus.OPEN },
      data: { status: BookingImportBatchStatus.COMPLETED, completedAt: expect.any(Date) },
    });
    expect(result).toEqual({ outcome: "completed", batchId: BATCH, rows: [{ bookingRef: "B1", outcome: "IMPORTED", bookingId: "booking-1" }] });
  });

  it("writes nothing when another confirm already claimed the row", async () => {
    const bookings = parsed("100.00");
    vi.mocked(planBookingImport).mockResolvedValue(planFor(bookings));
    tx.bookingImportRow.updateMany.mockImplementation(async () => (order.push("claim"), { count: 0 }));

    await confirm(bookings);

    expect(order.slice(0, 6)).toEqual(["tx-open", "lock(1)", "lodge-lock", "check(lock=true)", "claim", "tx-close"]);
    expect(tx.booking.create).not.toHaveBeenCalled();
    expect(settleImportedBookingInTransaction).not.toHaveBeenCalled();
    expect(settleHostingCoverageAfterCommit).not.toHaveBeenCalled();
    expect(order).not.toContain("refuse-row");
    expect(order).not.toContain("audit:booking_import.booking_imported");
  });

  it("refuses the row, guarded on PENDING, when a check fails under the locks, and claims nothing", async () => {
    const bookings = parsed("100.00");
    vi.mocked(planBookingImport).mockResolvedValue(planFor(bookings));
    vi.mocked(checkImportBooking).mockImplementation(async () => {
      order.push("check(lock=true)");
      return { refusals: [{ code: "OVER_CAPACITY", message: "10 Aug would have 5 people in a 4-bed lodge" }], nights: [], overCapacityNights: ["2026-08-10"] };
    });

    await confirm(bookings);

    expect(order.slice(0, 6)).toEqual(["tx-open", "lock(1)", "lodge-lock", "check(lock=true)", "tx-close", "refuse-row"]);
    expect(tx.bookingImportRow.updateMany).not.toHaveBeenCalled();
    expect(prisma.bookingImportRow.updateMany).toHaveBeenCalledWith({
      where: { id: "row-1", status: BookingImportRowStatus.PENDING },
      data: {
        status: BookingImportRowStatus.REFUSED,
        refusalReason: "10 Aug would have 5 people in a 4-bed lodge",
        refusalCode: "OVER_CAPACITY",
        decidedAt: expect.any(Date),
      },
    });
    expect(logAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "booking_import.booking_imported" }));
  });

  it("refuses the row when its member no longer resolves under the locks", async () => {
    const bookings = parsed("100.00");
    vi.mocked(planBookingImport).mockResolvedValue(planFor(bookings));
    tx.member.findMany.mockResolvedValue([]);
    await confirm(bookings);
    expect(checkImportBooking).not.toHaveBeenCalled();
    expect(prisma.bookingImportRow.updateMany.mock.calls[0]![0].data).toMatchObject({
      status: BookingImportRowStatus.REFUSED,
      refusalCode: "MEMBER",
      refusalReason: "The owner on line 2 matches no member\nThe guest on line 2 matches no member",
    });
  });

  it("records NOT_SETTLED when the settlement refuses the booking, and audits no import", async () => {
    const bookings = parsed("100.00");
    vi.mocked(planBookingImport).mockResolvedValue(planFor(bookings));
    vi.mocked(settleImportedBookingInTransaction).mockRejectedValue(new ManualBookingPaymentError("This booking no longer fits the lodge", 409));
    finalRows = [{ bookingRef: "B1", status: BookingImportRowStatus.REFUSED, bookingId: null, refusalReason: "The payment could not be recorded: This booking no longer fits the lodge", refusalCode: "NOT_SETTLED" }];

    const result = await confirm(bookings);

    expect(prisma.bookingImportRow.updateMany).toHaveBeenCalledWith({
      where: { id: "row-1", status: BookingImportRowStatus.PENDING },
      data: {
        status: BookingImportRowStatus.REFUSED,
        refusalReason: "The payment could not be recorded: This booking no longer fits the lodge",
        refusalCode: "NOT_SETTLED",
        decidedAt: expect.any(Date),
      },
    });
    expect(settleHostingCoverageAfterCommit).not.toHaveBeenCalled();
    expect(order).not.toContain("audit:booking_import.booking_imported");
    expect(result).toMatchObject({ rows: [{ bookingRef: "B1", outcome: "REFUSED", refusals: [{ code: "NOT_SETTLED" }] }] });
  });

  it("lets any other failure propagate without recording a refusal", async () => {
    const bookings = parsed("100.00");
    vi.mocked(planBookingImport).mockResolvedValue(planFor(bookings));
    vi.mocked(settleImportedBookingInTransaction).mockRejectedValue(new Error("connection lost"));
    await expect(confirm(bookings)).rejects.toThrow("connection lost");
    expect(prisma.bookingImportRow.updateMany).not.toHaveBeenCalled();
  });

  it("refuses the row with the hosting reason when the review finds the rule broken under the locks", async () => {
    const bookings = parsed("100.00");
    vi.mocked(planBookingImport).mockResolvedValue(planFor(bookings));
    vi.mocked(recordAdultMemberHostingReviewForNewBooking).mockResolvedValue({ violation: true } as never);
    await confirm(bookings);
    expect(vi.mocked(recordAdultMemberHostingReviewForNewBooking)).toHaveBeenCalledWith("booking-1", tx, null);
    expect(prisma.bookingImportRow.updateMany.mock.calls[0]![0].data).toMatchObject({
      refusalReason: BOOKING_IMPORT_HOSTING_REFUSAL.message,
      refusalCode: "HOSTING",
    });
    expect(tx.bookingEvent.createMany).not.toHaveBeenCalled();
  });
});

describe("confirmBookingImport: one free stay", () => {
  it("writes the shared $0 row, then PAID guarded on PAYMENT_PENDING, then the confirmation lines, then beds; no settle", async () => {
    const bookings = parsed("0");
    vi.mocked(planBookingImport).mockResolvedValue(planFor(bookings));

    await confirm(bookings);

    expect(order.slice(0, 12)).toEqual([
      "tx-open",
      "lock(1)",
      "lodge-lock",
      "check(lock=true)",
      "claim",
      "booking.create",
      "zero-payment",
      "PAID",
      "confirmation-lines",
      "beds",
      "hosting-review",
      "events",
    ]);
    expect(createZeroPriceConfirmationPayment).toHaveBeenCalledWith(tx, { bookingId: "booking-1", creditAppliedCents: 0 });
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: "booking-1", status: BookingStatus.PAYMENT_PENDING },
      data: { status: BookingStatus.PAID },
    });
    expect(postStoredBookingConfirmationLedgerLines).toHaveBeenCalledWith(tx, "booking-1", JOURNAL);
    expect(reconcileBedAllocationsForBookingWithGlobalLockHeld).toHaveBeenCalledWith({ bookingId: "booking-1", db: tx });
    expect(settleImportedBookingInTransaction).not.toHaveBeenCalled();
  });

  it("fails the transaction, posting no lines, if the free booking's PAID claim is lost", async () => {
    const bookings = parsed("0");
    vi.mocked(planBookingImport).mockResolvedValue(planFor(bookings));
    tx.booking.updateMany.mockImplementation(async () => (order.push("PAID"), { count: 0 }));
    await expect(confirm(bookings)).rejects.toThrow("The free imported booking lost its confirmation claim");
    expect(postStoredBookingConfirmationLedgerLines).not.toHaveBeenCalled();
  });
});

describe("confirmBookingImport: completing the batch", () => {
  it("leaves the batch open, with no completion audit, while a row is still pending", async () => {
    const bookings = parsed("100.00");
    vi.mocked(planBookingImport).mockResolvedValue(planFor(bookings));
    prisma.bookingImportRow.count.mockResolvedValue(1);
    await confirm(bookings);
    expect(prisma.bookingImportBatch.updateMany).not.toHaveBeenCalled();
    expect(order).not.toContain("audit:booking_import.completed");
  });

  it("audits the completion once: a concurrent confirm that completed it first wins", async () => {
    const bookings = parsed("100.00");
    vi.mocked(planBookingImport).mockResolvedValue(planFor(bookings));
    prisma.bookingImportBatch.updateMany.mockResolvedValue({ count: 0 });
    await confirm(bookings);
    expect(order).not.toContain("audit:booking_import.completed");
  });

  it("reports the completion with the batch's counts", async () => {
    const bookings = parsed("100.00");
    vi.mocked(planBookingImport).mockResolvedValue(planFor(bookings));
    await confirm(bookings);
    expect(vi.mocked(logAudit).mock.calls.at(-1)![0]).toMatchObject({
      action: "booking_import.completed",
      targetId: BATCH,
      metadata: { lodgeId: LODGE.id, bookings: 1, imported: 1, refused: 0 },
    });
  });
});
