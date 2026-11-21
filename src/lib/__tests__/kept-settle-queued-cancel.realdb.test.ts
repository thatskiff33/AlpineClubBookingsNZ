/**
 * Real-PostgreSQL proof that a cancel queued behind a KEPT bank-transfer settle
 * reads the net the cash supports (#4449, `INV-PAY-126`), through the REAL
 * inbound settle (`syncInternetBankingPaymentsForPaidInvoice`), the REAL
 * inbound credit-note sync (`reconcileXeroCreditNote` against a fake Xero,
 * #5289 G) with its allocation write and removal, and the REAL cancel.
 *
 * #5289 C: the allocation write locks and decides the payment the settle finds,
 * one named only by its invoice link included (LINK-ONLY), and a payment's
 * total counts one invoice's allocations, the one the settle decides with.
 *
 * A kept settle records the receipt at the stored figure, which still includes
 * every invoice-correction note applied to the invoice, so each such note must
 * count as refunded by the time anything else reads the payment. Before #4449
 * the settle added only the corrections it could see on top of the stored
 * total, and left the rest to a recount after its commit, which a cancel
 * queued on `lock(1)` overtakes:
 *
 * - case 2: a stored total above what the rows record (a refund-worded note
 *   folded into it) made the settle count no correction at all;
 * - case 1: a correction whose allocation the note sync wrote while the settle
 *   ran was invisible to both: the settle had read the links, and the sync
 *   read the receipt as uncaptured.
 *
 * Now the keep decides the whole refunded total from the links in its own
 * transaction, and the note sync's allocation write takes the Payment row
 * first and decides the total under it, so whichever commits second counts the
 * correction, and the cancel queued behind both reads it.
 *
 * Each case seeds the booking, payment, invoice link and edit notes as their
 * writers leave them (the shapes `ib-settle-from-cash.realdb.test.ts`
 * documents), stalls one writer on a row a holder transaction keeps locked,
 * queues the others behind it (`pg_blocking_pids`), then lets them run.
 *
 * Nothing is mocked. Ordinary Vitest runs skip the whole file. It reuses the
 * guarded, disposable loopback PostgreSQL `concurrency-lock-races.realdb.test.ts`
 * provisions (#1881), which imports this file so CI reaches it; it cleans its
 * own uniquely-namespaced `race-4449-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import type { Invoice } from "xero-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { syncFakeXeroCreditNote } from "./support/fake-xero-credit-note-sync";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4449-member";
const LODGE_ID = "race-4449-lodge";
const BOOKING_ID = "race-4449-booking";
const PAYMENT_ID = "race-4449-payment";
const PRIMARY_ID = "race-4449-primary";
const GUEST_ID = "race-4449-guest";
const INVOICE_ID = "race-4449-invoice";
// #5289 C: an older invoice the payment is still linked to, besides its own.
const OLD_INVOICE_ID = "race-4449-old-invoice";
// The edit's invoice correction, and an older edit's note worded as a refund.
const CORRECTION = { noteId: "race-4449-correction", modificationId: "race-4449-modification" };
const REFUND = { noteId: "race-4449-refund", modificationId: "race-4449-modification-refund" };
// #5289 C: a correction allocated to the older invoice.
const OLD_CORRECTION = { noteId: "race-4449-old-correction", modificationId: "race-4449-modification-old" };
const CHECK_IN = new Date("2027-09-01T00:00:00.000Z");
const CHECK_OUT = new Date("2027-09-02T00:00:00.000Z");

type NoteIds = { noteId: string; modificationId: string };

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeKeptSettleQueuedCancelRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Kept-settle queued-cancel proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run kept-settle queued-cancel proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Kept-settle queued-cancel proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Kept-settle queued-cancel proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let paidEffects: typeof import("@/lib/xero-inbound/invoice-paid-effects");
let bookingCancel: typeof import("@/lib/booking-cancel");
let amounts: typeof import("@/lib/xero-inbound/amounts");

async function clean(): Promise<void> {
  const modificationIds = [CORRECTION.modificationId, REFUND.modificationId, OLD_CORRECTION.modificationId];
  await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.xeroObjectLink.deleteMany({
    where: {
      OR: [
        { localId: { in: [PAYMENT_ID, BOOKING_ID, ...modificationIds] } },
        { xeroObjectId: { in: [INVOICE_ID, OLD_INVOICE_ID, CORRECTION.noteId, REFUND.noteId, OLD_CORRECTION.noteId] } },
      ],
    },
  });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID, ...modificationIds] } } });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { entityId: { in: [BOOKING_ID, PAYMENT_ID] } },
        { targetId: BOOKING_ID },
        ...[CORRECTION.noteId, REFUND.noteId, OLD_CORRECTION.noteId].map((noteId) => ({ metadata: { path: ["creditNoteId"], equals: noteId } })),
      ],
    },
  });
  await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

/**
 * A held Internet Banking booking at $300 as `booking-create.ts` writes it, its
 * invoice linked as the invoice job links it, and its price then cut to `priceCents`.
 * #5289 C: `stamped: false` leaves the invoice id unstamped on the payment and its
 * receipt, so only the link names the payment, as the settle can still find it.
 */
async function bookInvoicedAndCutTo(priceCents: number, options: { stamped?: boolean } = {}): Promise<void> {
  const invoice = options.stamped === false ? { xeroInvoiceId: null, xeroInvoiceNumber: null } : { xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-4449" };
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: MEMBER_ID,
      lodgeId: LODGE_ID,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      status: "CONFIRMED",
      totalPriceCents: priceCents,
      finalPriceCents: priceCents,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: GUEST_ID,
      bookingId: BOOKING_ID,
      firstName: "Queued",
      lastName: "Cancel",
      ageTier: "ADULT",
      isMember: true,
      stayStart: CHECK_IN,
      stayEnd: CHECK_OUT,
      priceCents,
      nights: { create: [{ stayDate: CHECK_IN, priceCents, priceSource: "SOLD" }] },
    },
  });
  await prisma.payment.create({
    data: {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      amountCents: 30_000,
      source: "INTERNET_BANKING",
      status: "PENDING",
      reference: "BOOKING-RACE4449",
      internetBankingHoldSlots: true,
      ...invoice,
      transactions: {
        create: {
          id: PRIMARY_ID,
          kind: "PRIMARY",
          source: "INTERNET_BANKING",
          amountCents: 30_000,
          status: "PENDING",
          reference: "BOOKING-RACE4449",
          reason: "internet_banking_booking_payment",
          ...invoice,
        },
      },
    },
  });
  await prisma.xeroObjectLink.create({
    data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "INVOICE", xeroObjectId: INVOICE_ID, role: "PRIMARY_INVOICE", active: true },
  });
}

/** An edit's modification note, in the rows its builder leaves: the outbound operation and the note's link to the edit. */
async function queueModificationNote(ids: NoteIds, noteCents: number, wording: Record<string, unknown>, invoiceId = INVOICE_ID): Promise<void> {
  await prisma.bookingModification.create({
    data: {
      id: ids.modificationId,
      bookingId: BOOKING_ID,
      memberId: MEMBER_ID,
      modificationType: "BATCH_MODIFY",
      previousData: {},
      newData: {},
      priceDiffCents: -noteCents,
      changeFeeCents: 0,
    },
  });
  await prisma.xeroSyncOperation.create({
    data: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "BookingModification",
      localId: ids.modificationId,
      idempotencyKey: `race-4449-mod-credit-note-${ids.noteId}`,
      correlationKey: `race-4449-mod-credit-note-${ids.noteId}`,
      status: "SUCCEEDED",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: ids.noteId,
      requestPayload: { invoiceId, refundAmountCents: noteCents, ...wording },
    },
  });
  await prisma.xeroObjectLink.create({
    data: { localModel: "BookingModification", localId: ids.modificationId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: ids.noteId, role: "MODIFICATION_CREDIT_NOTE", active: true },
  });
}

/** The allocation link the sync writes for the note on the edit (`buildSyntheticAllocationLinkId`). */
function allocationLink(ids: NoteIds, noteCents: number) {
  return {
    localModel: "BookingModification",
    localId: ids.modificationId,
    xeroObjectType: "ALLOCATION",
    xeroObjectId: amounts.buildSyntheticAllocationLinkId(ids.noteId, INVOICE_ID, noteCents),
    role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
    metadata: { creditNoteId: ids.noteId, invoiceId: INVOICE_ID, amountCents: noteCents },
  };
}

/**
 * The REAL inbound credit-note sync (`reconcileXeroCreditNote`, #5289 G) of the
 * AUTHORISED note, fully allocated to `invoiceId`, against a fake Xero (no
 * provider call): the note's own link, its allocation through the allocation
 * write, then the current note's contribution and the refunded-total recount.
 */
async function syncNote(ids: NoteIds, noteCents: number, invoiceId = INVOICE_ID): Promise<void> {
  await syncFakeXeroCreditNote({
    creditNoteID: ids.noteId,
    creditNoteNumber: `CN-${ids.noteId}`,
    status: "AUTHORISED",
    total: noteCents / 100,
    appliedAmount: noteCents / 100,
    remainingCredit: 0,
    updatedDateUTC: new Date("2026-06-30T11:00:00.000Z"),
    allocations: [{ invoice: { invoiceID: invoiceId }, amount: noteCents / 100 }],
    payments: [],
  });
}

/**
 * The REAL inbound credit-note sync (#5289 G) of a newer reading of the
 * AUTHORISED note that no longer lists the invoice: its removal
 * (`retireUnlistedCreditNoteAllocations`) turns the allocation off under the
 * payment's Payment row (#4449 verify).
 */
async function removeAllocation(ids: NoteIds, noteCents: number): Promise<void> {
  await syncFakeXeroCreditNote({
    creditNoteID: ids.noteId,
    creditNoteNumber: `CN-${ids.noteId}`,
    status: "AUTHORISED",
    total: noteCents / 100,
    appliedAmount: 0,
    remainingCredit: noteCents / 100,
    updatedDateUTC: new Date("2026-06-30T12:00:00.000Z"),
    allocations: [],
    payments: [],
  });
}

/** Whether the note's allocation link on the invoice is active. */
async function allocationActive(ids: NoteIds, noteCents: number): Promise<boolean | null> {
  const link = allocationLink(ids, noteCents);
  return (
    (await prisma.xeroObjectLink.findFirst({
      where: { localModel: link.localModel, localId: link.localId, xeroObjectType: link.xeroObjectType, xeroObjectId: link.xeroObjectId, role: link.role },
      select: { active: true },
    }))?.active ?? null
  );
}

/**
 * Xero reports the invoice PAID with an unquantifiable amount paid, so the cash
 * is incomplete and the settle keeps the stored $300, captured at that figure.
 */
function settleKept(appliedNotes: Array<{ id: string; cents: number }>) {
  const invoice = {
    invoiceID: INVOICE_ID,
    invoiceNumber: "INV-4449",
    status: "PAID",
    amountPaid: "degraded",
    total: 300,
    payments: [{ paymentID: "race-4449-xpay", amount: 0, status: "AUTHORISED" }],
    creditNotes: appliedNotes.map((note) => ({ creditNoteID: note.id, appliedAmount: note.cents / 100 })),
  } as unknown as Invoice;
  return paidEffects.syncInternetBankingPaymentsForPaidInvoice(invoice, [PAYMENT_ID], CLUB_FORMAT_TEST);
}

/**
 * A writer queued as the cancel's paid claim queues: `lock(1)` first, then the
 * Payment row, read as it stands the moment both are granted. A real cancel
 * queued behind the settle's transition refuses instead (its read before the
 * lock found nothing captured: `CANCEL_PAYMENT_JUST_RECORDED_MESSAGE`); one
 * that starts after the settle commits takes these locks and reads the same
 * row, before the recount after the commit (`recountCorrectionsAfterKeptSettle`)
 * can run.
 */
function readQueuedOnCancelLocks(): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      return (
        await tx.$queryRaw<Array<{ refundedAmountCents: number }>>`
          SELECT "refundedAmountCents" FROM "Payment" WHERE id = ${PAYMENT_ID} FOR NO KEY UPDATE
        `
      )[0].refundedAmountCents;
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}

/** The REAL cancel once every writer has finished: everything back, so its credit is the payment's net. */
async function expectCancelCredits(cents: number): Promise<void> {
  const result = await bookingCancel.cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
  expect(result.status).toBe(200);
  const credits = await prisma.memberCredit.findMany({
    where: { memberId: MEMBER_ID, sourceBookingId: BOOKING_ID, type: "CANCELLATION_REFUND" },
    select: { amountCents: true },
  });
  expect(credits.reduce((sum, credit) => sum + credit.amountCents, 0)).toBe(cents);
}

/** The backend ids queued behind `blockerPid` (`pg_blocking_pids`), polled on the real clock. */
async function untilQueuedBehind(
  blockerPid: number,
  options: { count?: number; unless?: () => boolean } = {},
): Promise<number[]> {
  const count = options.count ?? 1;
  const startedAt = process.hrtime.bigint();
  while (realElapsedMs(startedAt) < 20_000) {
    if (options.unless?.()) return [];
    const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
    `;
    if (rows.length >= count) return rows.map((row) => row.pid);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Fewer than ${count} backends queued behind ${blockerPid}`);
}

/**
 * A transaction that runs `hold` and then keeps its locks until released.
 * `rollback` undoes what `hold` wrote, so a reserved row disappears again.
 */
async function holdLocks(hold: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<unknown>, options: { rollback?: boolean } = {}) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pid = 0;
  const holder = prisma
    .$transaction(
      async (tx) => {
        pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
        await hold(tx);
        await released;
        if (options.rollback) throw new Error("race-4449 holder rolled back");
      },
      { maxWait: 10_000, timeout: 60_000 },
    )
    .catch((error: unknown) => {
      if (!(options.rollback && error instanceof Error && error.message === "race-4449 holder rolled back")) throw error;
    });
  const startedAt = process.hrtime.bigint();
  while (pid === 0 && realElapsedMs(startedAt) < 10_000) await new Promise((resolve) => setTimeout(resolve, 10));
  return { pid, release, done: holder };
}

/** Hold the receipt row, so the settle stops at its receipt write with its locks and the Payment row taken. */
function holdReceiptRow() {
  return holdLocks((tx) => tx.$queryRaw`SELECT id FROM "PaymentTransaction" WHERE id = ${PRIMARY_ID} FOR UPDATE`);
}

async function paymentFigures() {
  return prisma.payment.findUniqueOrThrow({
    where: { id: PAYMENT_ID },
    select: { amountCents: true, refundedAmountCents: true, status: true },
  });
}

(RUN ? describe : describe.skip)("a cancel queued behind a kept bank-transfer settle reads the net the cash supports, against PostgreSQL (#4449)", () => {
  beforeAll(async () => {
    assertSafeKeptSettleQueuedCancelRaceDbUrl(RACE_DB_URL);
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    paidEffects = await import("@/lib/xero-inbound/invoice-paid-effects");
    bookingCancel = await import("@/lib/booking-cancel");
    amounts = await import("@/lib/xero-inbound/amounts");

    await clean();
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    await prisma.member.create({
      data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Queued", lastName: "Cancel", ageTier: "ADULT" },
    });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4449 Lodge", slug: "race-4449" } });
    // Everything back, no fee: the cancel's credit IS the payment's net.
    await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 } });
  }, 60_000);

  beforeEach(async () => {
    await clean();
  });

  afterAll(async () => {
    if (!prisma) return;
    await clean();
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
  });

  it("CASE 2: $300 less a $50 refund folded into the stored total and a synced $100 correction: a writer queued behind the settle reads $150 of net, never $250, and the cancel credits $150", async () => {
    await bookInvoicedAndCutTo(15_000);
    await queueModificationNote(REFUND, 5_000, { refundMethod: "internet-banking" });
    await syncNote(REFUND, 5_000);
    await queueModificationNote(CORRECTION, 10_000, { noteWording: "invoice-correction" });
    await syncNote(CORRECTION, 10_000);
    // The refund note counts before any receipt; the rows record none of it.
    expect(await paymentFigures()).toMatchObject({ amountCents: 30_000, refundedAmountCents: 5_000, status: "PARTIALLY_REFUNDED" });

    const receipt = await holdReceiptRow();
    const settling = settleKept([
      { id: REFUND.noteId, cents: 5_000 },
      { id: CORRECTION.noteId, cents: 10_000 },
    ]);
    let reading: Promise<number> | null = null;
    try {
      const [settlePid] = await untilQueuedBehind(receipt.pid);
      reading = readQueuedOnCancelLocks();
      await untilQueuedBehind(settlePid);
      receipt.release();
      expect(await reading).toBe(15_000);
    } finally {
      receipt.release();
      await receipt.done;
      await settling;
      await reading?.catch(() => undefined);
    }

    await expectCancelCredits(15_000);
  }, 60_000);

  it("CASE 1, SETTLE FIRST: the correction's allocation written while the settle holds its locks waits on the Payment row and counts it at the settle's commit, before a writer queued on lock(1) reads it", async () => {
    await bookInvoicedAndCutTo(20_000);
    await queueModificationNote(CORRECTION, 10_000, { noteWording: "invoice-correction" });

    const receipt = await holdReceiptRow();
    const settling = settleKept([{ id: CORRECTION.noteId, cents: 10_000 }]);
    let syncing: Promise<void> | null = null;
    let reading: Promise<number> | null = null;
    try {
      const [settlePid] = await untilQueuedBehind(receipt.pid);
      // The settle has read the links; the note's sync starts now, and its
      // allocation write queues on the settle's Payment row (before #4449 it
      // committed at once, and its recount read the receipt as uncaptured).
      let synced = false;
      syncing = syncNote(CORRECTION, 10_000).finally(() => {
        synced = true;
      });
      await untilQueuedBehind(settlePid, { unless: () => synced });
      reading = readQueuedOnCancelLocks();
      await untilQueuedBehind(settlePid, { count: synced ? 1 : 2 });
      receipt.release();
      expect(await reading).toBe(10_000);
    } finally {
      receipt.release();
      await receipt.done;
      await settling;
      await syncing?.catch(() => undefined);
      await reading?.catch(() => undefined);
    }

    await expectCancelCredits(20_000);
  }, 60_000);

  it("CASE 1, SYNC FIRST: the note's allocation write holds the Payment row while the settle waits on it, and the keep counts the correction it then reads, before a writer queued on lock(1) reads it", async () => {
    await bookInvoicedAndCutTo(20_000);
    await queueModificationNote(CORRECTION, 10_000, { noteWording: "invoice-correction" });
    const link = allocationLink(CORRECTION, 10_000);

    // Reserve the allocation row uncommitted, so the sync's own reservation
    // waits on it after the sync has taken the Payment row; rolled back on release.
    const reservation = await holdLocks(
      (tx) =>
        tx.xeroObjectLink.create({
          data: { localModel: link.localModel, localId: link.localId, xeroObjectType: link.xeroObjectType, xeroObjectId: link.xeroObjectId, role: link.role, active: false },
        }),
      { rollback: true },
    );
    let settling: ReturnType<typeof settleKept> | null = null;
    let reading: Promise<number> | null = null;
    const syncing = syncNote(CORRECTION, 10_000);
    try {
      const [syncPid] = await untilQueuedBehind(reservation.pid);
      settling = settleKept([{ id: CORRECTION.noteId, cents: 10_000 }]);
      const [settlePid] = await untilQueuedBehind(syncPid);
      reading = readQueuedOnCancelLocks();
      await untilQueuedBehind(settlePid);
      reservation.release();
      expect(await reading).toBe(10_000);
    } finally {
      reservation.release();
      await reservation.done;
      await syncing;
      await settling;
      await reading?.catch(() => undefined);
    }

    await expectCancelCredits(20_000);
  }, 60_000);

  it("REMOVAL, SETTLE FIRST: the correction's allocation removed while the settle holds its locks waits on the Payment row, and its total, decided second, is what a writer queued on lock(1) reads", async () => {
    await bookInvoicedAndCutTo(20_000);
    await queueModificationNote(CORRECTION, 10_000, { noteWording: "invoice-correction" });
    await syncNote(CORRECTION, 10_000);

    const receipt = await holdReceiptRow();
    const settling = settleKept([{ id: CORRECTION.noteId, cents: 10_000 }]);
    let removing: Promise<void> | null = null;
    let reading: Promise<number> | null = null;
    try {
      const [settlePid] = await untilQueuedBehind(receipt.pid);
      // The settle has counted the correction; the newer reading removes its allocation now.
      let removed = false;
      removing = removeAllocation(CORRECTION, 10_000).finally(() => {
        removed = true;
      });
      await untilQueuedBehind(settlePid, { unless: () => removed });
      reading = readQueuedOnCancelLocks();
      await untilQueuedBehind(settlePid, { count: removed ? 1 : 2 });
      receipt.release();
      // The settle committed $100; the removal, second on the Payment row, set nothing refunded.
      expect(await reading).toBe(0);
      await removing;
      expect(await allocationActive(CORRECTION, 10_000)).toBe(false);
    } finally {
      receipt.release();
      await receipt.done;
      await settling;
      await removing?.catch(() => undefined);
      await reading?.catch(() => undefined);
    }
    expect(await paymentFigures()).toMatchObject({ refundedAmountCents: 0, status: "SUCCEEDED" });
  }, 60_000);

  it("REMOVAL FIRST: the removal holds the Payment row while the settle waits on it, and the keep, second, counts no correction, before a writer queued on lock(1) reads it", async () => {
    await bookInvoicedAndCutTo(20_000);
    await queueModificationNote(CORRECTION, 10_000, { noteWording: "invoice-correction" });
    await syncNote(CORRECTION, 10_000);
    const link = allocationLink(CORRECTION, 10_000);

    // Hold the allocation row, so the removal parks on it after it has taken the Payment row.
    const allocationRow = await holdLocks((tx) =>
      tx.$queryRaw`
        SELECT 1 FROM "XeroObjectLink"
        WHERE "localModel" = ${link.localModel} AND "localId" = ${link.localId} AND "xeroObjectType" = ${link.xeroObjectType}
          AND "xeroObjectId" = ${link.xeroObjectId} AND "role" = ${link.role}
        FOR UPDATE`,
    );
    let settling: ReturnType<typeof settleKept> | null = null;
    let reading: Promise<number> | null = null;
    const removing = removeAllocation(CORRECTION, 10_000);
    try {
      const [removePid] = await untilQueuedBehind(allocationRow.pid);
      settling = settleKept([{ id: CORRECTION.noteId, cents: 10_000 }]);
      const [settlePid] = await untilQueuedBehind(removePid);
      reading = readQueuedOnCancelLocks();
      await untilQueuedBehind(settlePid);
      allocationRow.release();
      expect(await reading).toBe(0);
      await removing;
      expect(await allocationActive(CORRECTION, 10_000)).toBe(false);
    } finally {
      allocationRow.release();
      await allocationRow.done;
      await removing.catch(() => undefined);
      await settling;
      await reading?.catch(() => undefined);
    }
    expect(await paymentFigures()).toMatchObject({ refundedAmountCents: 0, status: "SUCCEEDED" });
  }, 60_000);

  it("A CORRECTION SYNCED BEFORE THE SETTLE: the keep counts it in its own transaction, so a writer queued on lock(1) reads $200 of net and the cancel credits $200", async () => {
    await bookInvoicedAndCutTo(20_000);
    await queueModificationNote(CORRECTION, 10_000, { noteWording: "invoice-correction" });
    // Synced before the transfer: against an uncaptured receipt it counts nothing.
    await syncNote(CORRECTION, 10_000);
    expect(await paymentFigures()).toMatchObject({ amountCents: 30_000, refundedAmountCents: 0, status: "PENDING" });

    const receipt = await holdReceiptRow();
    const settling = settleKept([{ id: CORRECTION.noteId, cents: 10_000 }]);
    let reading: Promise<number> | null = null;
    try {
      const [settlePid] = await untilQueuedBehind(receipt.pid);
      reading = readQueuedOnCancelLocks();
      await untilQueuedBehind(settlePid);
      receipt.release();
      expect(await reading).toBe(10_000);
    } finally {
      receipt.release();
      await receipt.done;
      await settling;
      await reading?.catch(() => undefined);
    }

    await expectCancelCredits(20_000);
  }, 60_000);
  // #5289 C: the allocation write locks and decides the payment the settle finds, one named only by its invoice link included.
  it("LINK-ONLY, SETTLE FIRST: a payment with no invoice id stamped, found by its invoice link: the correction's allocation waits on the settle's Payment row and counts it before a writer queued on lock(1) reads it", async () => {
    await bookInvoicedAndCutTo(20_000, { stamped: false });
    await queueModificationNote(CORRECTION, 10_000, { noteWording: "invoice-correction" });

    const receipt = await holdReceiptRow();
    const settling = settleKept([{ id: CORRECTION.noteId, cents: 10_000 }]);
    let syncing: Promise<void> | null = null;
    let reading: Promise<number> | null = null;
    try {
      const [settlePid] = await untilQueuedBehind(receipt.pid);
      let synced = false;
      syncing = syncNote(CORRECTION, 10_000).finally(() => {
        synced = true;
      });
      // Before #5289 the write found no payment by the invoice id and took no lock, so this never queued.
      await untilQueuedBehind(settlePid, { unless: () => synced });
      reading = readQueuedOnCancelLocks();
      await untilQueuedBehind(settlePid, { count: synced ? 1 : 2 });
      receipt.release();
      expect(await reading).toBe(10_000);
    } finally {
      receipt.release();
      await receipt.done;
      await settling;
      await syncing?.catch(() => undefined);
      await reading?.catch(() => undefined);
    }

    await expectCancelCredits(20_000);
  }, 60_000);

  it("LINK-ONLY, SYNC FIRST: the allocation write holds the link-only payment's Payment row while the settle waits on it, and the keep counts the correction before a writer queued on lock(1) reads it", async () => {
    await bookInvoicedAndCutTo(20_000, { stamped: false });
    await queueModificationNote(CORRECTION, 10_000, { noteWording: "invoice-correction" });
    const link = allocationLink(CORRECTION, 10_000);

    const reservation = await holdLocks(
      (tx) =>
        tx.xeroObjectLink.create({
          data: { localModel: link.localModel, localId: link.localId, xeroObjectType: link.xeroObjectType, xeroObjectId: link.xeroObjectId, role: link.role, active: false },
        }),
      { rollback: true },
    );
    let settling: ReturnType<typeof settleKept> | null = null;
    let reading: Promise<number> | null = null;
    const syncing = syncNote(CORRECTION, 10_000);
    try {
      const [syncPid] = await untilQueuedBehind(reservation.pid);
      settling = settleKept([{ id: CORRECTION.noteId, cents: 10_000 }]);
      const [settlePid] = await untilQueuedBehind(syncPid);
      reading = readQueuedOnCancelLocks();
      await untilQueuedBehind(settlePid);
      reservation.release();
      expect(await reading).toBe(10_000);
    } finally {
      reservation.release();
      await reservation.done;
      await syncing.catch(() => undefined);
      await settling;
      await reading?.catch(() => undefined);
    }

    await expectCancelCredits(20_000);
  }, 60_000);

  it("ONE INVOICE PER PAYMENT: a payment linked to an older invoice besides its own counts only its own invoice's correction, the one the settle decides with, whichever note syncs after the settle", async () => {
    await bookInvoicedAndCutTo(15_000);
    await prisma.xeroObjectLink.create({
      data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "INVOICE", xeroObjectId: OLD_INVOICE_ID, role: "PRIMARY_INVOICE", active: true },
    });
    await queueModificationNote(CORRECTION, 10_000, { noteWording: "invoice-correction" });
    await queueModificationNote(OLD_CORRECTION, 5_000, { noteWording: "invoice-correction" }, OLD_INVOICE_ID);
    await syncNote(CORRECTION, 10_000);
    await syncNote(OLD_CORRECTION, 5_000, OLD_INVOICE_ID);

    await settleKept([{ id: CORRECTION.noteId, cents: 10_000 }]);
    expect(await paymentFigures()).toMatchObject({ refundedAmountCents: 10_000 });
    // The older invoice's note syncs again: its allocation write and recount add nothing on top.
    await syncNote(OLD_CORRECTION, 5_000, OLD_INVOICE_ID);
    expect(await paymentFigures()).toMatchObject({ refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED" });
    await syncNote(CORRECTION, 10_000);
    expect(await paymentFigures()).toMatchObject({ refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED" });
  }, 60_000);
});
