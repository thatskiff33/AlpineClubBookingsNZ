/**
 * Real-PostgreSQL proof for #3953 review round 7 (`INV-PAY-139`): A CAPTURE
 * WHOSE LEDGER ROW CARRIES NO CHANGE STAMP still has one recorder.
 *
 * Two such captures reach the supplementary-invoice enqueue with a request
 * to record the payment (`recordPayment: true`):
 *
 *  1. An officer's review charge (`edit_financial_review_charge_<change>`):
 *     the review's "covers the ask" plan queues the change's invoice paid.
 *     The change is read from the reason (`captureChangeId`), so the receipt
 *     stores its decision under that change's anchor lock and the invoice,
 *     deciding under the same lock, is raised unpaid.
 *  2. An older member ask from before the stamp: no change can be read, so
 *     its receipt stores under the BOOKING's lock. The repair tool's arm
 *     queues the change's invoice paid and naming no capture; the enqueue
 *     takes the booking's lock first (booking, then anchor - the one order),
 *     queues behind a session holding it, and raises the invoice unpaid.
 *  3. Round 9: such a capture's receipt never touches an invoice that NAMES
 *     another capture - a later change's own paying invoice stays paid.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-3953u-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { buildEditFinancialReviewChargeReason } from "@/lib/payment-recovery-keys";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-3953u-owner";
const LODGE_ID = "race-3953u-lodge";
const BOOKING_ID = "race-3953u-booking";
const PAYMENT_ID = "race-3953u-payment";
const CHANGE_TX_ID = "race-3953u-change-capture";
const CHANGE_INTENT = "pi_race_3953u_change";
const MODIFICATION_ID = "race-3953u-modification";
const INVOICE_ID = "race-3953u-xero-invoice";
const NEW_TX_ID = "race-3953u-new-capture";
const NEW_INTENT = "pi_race_3953u_new";
const NEW_MODIFICATION_ID = "race-3953u-new-modification";
const RECEIPT_KEY = `payment-intent:${CHANGE_INTENT}:additional-capture-receipt:v1`;
const LOCK_POLL_TIMEOUT_MS = 5_000;

let prisma: PrismaClient;
let observerClient: PrismaClient;
let outbox: typeof import("@/lib/xero-operation-outbox");

async function clean(): Promise<void> {
  await prisma.xeroSyncOperation.deleteMany({
    where: { localId: { in: [CHANGE_TX_ID, NEW_TX_ID, PAYMENT_ID, BOOKING_ID, MODIFICATION_ID, NEW_MODIFICATION_ID] } },
  });
  await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [CHANGE_TX_ID, NEW_TX_ID] } } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

/** A confirmed card booking, its primary invoice linked, and one change capture carrying `reason` and no stamp. */
async function seed(reason: string | null): Promise<void> {
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: new Date("2026-09-10T00:00:00.000Z"),
      checkOut: new Date("2026-09-12T00:00:00.000Z"),
      status: "CONFIRMED",
      totalPriceCents: 38_000,
      finalPriceCents: 38_000,
    },
  });
  await prisma.payment.create({
    data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 38_000, source: "STRIPE", status: "SUCCEEDED", xeroInvoiceId: INVOICE_ID },
  });
  await prisma.paymentTransaction.create({
    data: {
      id: CHANGE_TX_ID,
      paymentId: PAYMENT_ID,
      kind: "ADDITIONAL",
      source: "STRIPE",
      stripePaymentIntentId: CHANGE_INTENT,
      amountCents: 8_000,
      status: "SUCCEEDED",
      hadIssuedXeroInvoice: false,
      bookingModificationId: null,
      reason,
    },
  });
}

/** The capture's receipt, its decision stored (the worker's plan, before its Xero call). */
async function plannedReceipt(store: Pick<PrismaClient, "xeroSyncOperation"> = prisma): Promise<void> {
  await store.xeroSyncOperation.create({
    data: {
      direction: "OUTBOUND",
      entityType: "PAYMENT",
      operationType: "CREATE",
      localModel: "PaymentTransaction",
      localId: CHANGE_TX_ID,
      status: "FAILED",
      queueType: "ADDITIONAL_CAPTURE_RECEIPT",
      correlationKey: RECEIPT_KEY,
      idempotencyKey: RECEIPT_KEY,
      requestPayload: {
        queueType: "ADDITIONAL_CAPTURE_RECEIPT",
        bookingId: BOOKING_ID,
        paymentId: PAYMENT_ID,
        paymentTransactionId: CHANGE_TX_ID,
        paymentIntentId: CHANGE_INTENT,
        plan: { target: "PRIMARY_INVOICE", invoiceId: INVOICE_ID, amountCents: 8_000, capturedCents: 8_000, date: "2026-06-30" },
      },
    },
  });
}

async function changeInvoices() {
  return prisma.xeroSyncOperation.findMany({
    where: { localModel: "BookingModification", localId: MODIFICATION_ID, queueType: "SUPPLEMENTARY_INVOICE" },
    select: { requestPayload: true },
  });
}

/** How many sessions are queued behind this backend (`pg_blocking_pids`). */
async function untilQueuedBehind(blockerPid: number): Promise<number> {
  const startedAt = process.hrtime.bigint();
  let queued = 0;
  while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
    const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
      WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
    `;
    queued = rows[0]?.count ?? 0;
    if (queued >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return queued;
}

(RUN ? describe : describe.skip)("a change capture with no change stamp has one Xero recorder, on PostgreSQL (#3953 round 7)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Unattributed change capture receipt");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    outbox = await import("@/lib/xero-operation-outbox");
    const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
      import("@prisma/client"),
      import("@/lib/prisma-adapter"),
    ]);
    const observerUrl = new URL(RACE_DB_URL);
    observerUrl.searchParams.set("connection_limit", "1");
    observerUrl.searchParams.set("application_name", "race-3953u-observer");
    observerClient = new SeparatePrismaClient({ adapter: createPrismaPgAdapter(observerUrl.toString()) });
    await observerClient.$connect();

    await clean();
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: OWNER_ID } });
    await prisma.member.create({
      data: {
        id: OWNER_ID,
        email: `${OWNER_ID}@example.invalid`,
        passwordHash: "not-a-real-password",
        firstName: "Owner",
        lastName: "Proof",
        ageTier: "ADULT",
        canLogin: true,
      },
    });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3953u Lodge", slug: "race-3953u" } });
  }, 120_000);

  beforeEach(async () => {
    await clean();
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await clean();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: OWNER_ID } });
    } finally {
      await observerClient?.$disconnect();
    }
  });

  it("a review charge's capture, read to its change by its reason, makes that change's paid invoice unpaid", async () => {
    await seed(buildEditFinancialReviewChargeReason(MODIFICATION_ID));
    await plannedReceipt();

    // The review's "covers the ask" plan: the change's invoice, asked to record the payment.
    await outbox.enqueueXeroSupplementaryInvoiceOperation(
      { bookingId: BOOKING_ID, priceDiffCents: 8_000, changeFeeCents: 0, bookingModificationId: MODIFICATION_ID },
      { recordPayment: true },
    );

    const invoices = await changeInvoices();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.requestPayload).toMatchObject({ recordPayment: false });
  });

  it("a capture no change can be read from: the enqueue queues on the booking's lock first, then raises the invoice unpaid", async () => {
    await seed(null);
    let holderPid = 0;
    let releaseHolder!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // The holder is the receipt storing its decision under the booking's lock.
    const holder = prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
        holderPid = rows[0]?.pid ?? 0;
        await outbox.lockSupplementaryInvoiceAnchor(tx, BOOKING_ID);
        locked();
        await held;
        await plannedReceipt(tx);
      },
      { timeout: 20_000 },
    );
    await lockTaken;

    // The repair tool's ordinary arm: paid, naming no capture.
    const waiting = outbox.enqueueXeroSupplementaryInvoiceOperation(
      { bookingId: BOOKING_ID, priceDiffCents: 8_000, changeFeeCents: 0, bookingModificationId: MODIFICATION_ID },
      { recordPayment: true },
    );
    waiting.catch(() => undefined);
    expect(await untilQueuedBehind(holderPid)).toBe(1);
    releaseHolder();
    await holder;
    await waiting;

    const invoices = await changeInvoices();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.requestPayload).toMatchObject({ recordPayment: false });
  });

  it("MUTATION round 9: a legacy capture's receipt leaves a later change's invoice naming its own capture paid", async () => {
    await seed(null);
    // The legacy capture's receipt is in Xero.
    await prisma.xeroObjectLink.create({
      data: {
        localModel: "PaymentTransaction",
        localId: CHANGE_TX_ID,
        xeroObjectType: "PAYMENT",
        xeroObjectId: "race-3953u-xero-payment",
        role: "ADDITIONAL_CAPTURE_PAYMENT",
        active: true,
        metadata: { invoiceId: INVOICE_ID },
      },
    });
    // A later change, stamped, paid by card.
    await prisma.paymentTransaction.create({
      data: {
        id: NEW_TX_ID,
        paymentId: PAYMENT_ID,
        kind: "ADDITIONAL",
        source: "STRIPE",
        stripePaymentIntentId: NEW_INTENT,
        amountCents: 5_000,
        status: "SUCCEEDED",
        hadIssuedXeroInvoice: false,
        bookingModificationId: NEW_MODIFICATION_ID,
      },
    });

    await outbox.enqueueXeroSupplementaryInvoiceOperation(
      { bookingId: BOOKING_ID, priceDiffCents: 5_000, changeFeeCents: 0, bookingModificationId: NEW_MODIFICATION_ID },
      { recordPayment: true, paymentIntentId: NEW_INTENT },
    );

    const invoices = await prisma.xeroSyncOperation.findMany({
      where: { localModel: "BookingModification", localId: NEW_MODIFICATION_ID, queueType: "SUPPLEMENTARY_INVOICE" },
      select: { requestPayload: true },
    });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.requestPayload).toMatchObject({ paymentIntentId: NEW_INTENT });
    expect(invoices[0]!.requestPayload).not.toMatchObject({ recordPayment: false });
  });
});
