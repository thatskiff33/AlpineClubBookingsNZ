/**
 * Real-PostgreSQL proof for #3953 (`INV-PAY-139`; owner plan, 21 Oct 2026: "it
 * runs once"): a booking change's card capture that no supplementary invoice
 * waited on gets ONE receipt operation, whoever sees the capture first.
 *
 *  1. The Stripe webhook and the confirm route reporting the same capture at
 *     once - held at a barrier until both are queued on the anchor lock - and
 *     a replay after both, go through the REAL late-success release
 *     (`releaseXeroSupplementaryInvoiceForCapturedPaymentIntent`): one row, one
 *     `receipt-queued`, every other caller `already-released`.
 *  2. Many enqueues at once (`enqueueAdditionalCaptureReceiptOperation`) make
 *     one row.
 *  4. Review round 1 (one recorder per capture): a capture that landed between
 *     the primary create's read and its gap check, on a change that raced the
 *     create, is recorded ONCE - by its receipt (the gap invoice is raised
 *     unpaid and names nothing) when the link's figures say the primary's cash
 *     did not cover it, or by the gap invoice (which names it, and the
 *     receipt then stands down) when the figures cannot say.
 *  5. Review rounds 3 to 5: two receipts on one booking go through the
 *     outbox's real claim and the real worker from one barrier - only one
 *     passes the planning gate and reaches Xero, the other waits for it -
 *     also with both gates queued together on the booking's anchor lock held
 *     by another session; a
 *     create dead past the staleness threshold blocks neither, a live one
 *     blocks both.
 *  6. Review round 8: a retired invoice the release revives for the capture,
 *     while its receipt stores a decision under the change's anchor lock,
 *     queues behind that lock and is revived unpaid - one recording.
 *  7. #4494: a credit-release card capture landing before the gap check is
 *     re-run (`recheckPrimaryInvoiceWorthGap`) is the sweep's money: the gap
 *     invoice is raised unpaid and names nothing, rather than pay from it -
 *     also where the sweep holds a partly refunded one.
 *  3. The enqueue runs under the existing per-anchor supplementary-invoice lock
 *     (`lockSupplementaryInvoiceAnchor`) on the change the capture pays for: a
 *     session holding that lock makes the enqueue queue behind it, and the
 *     enqueue then finds the row the holder wrote.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-3953-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-3953-owner";
const LODGE_ID = "race-3953-lodge";
const BOOKING_ID = "race-3953-booking";
const PAYMENT_ID = "race-3953-payment";
const PRIMARY_TX_ID = "race-3953-primary-capture";
const CHANGE_TX_ID = "race-3953-change-capture";
const CHANGE_TX_2_ID = "race-3953-change-capture-2";
const CHANGE_INTENT_2 = "pi_race_3953_change_2";
/** #4494: a card payment for credit released after a Xero offset. */
const RELEASE_TX_ID = "race-3953-release-capture";
const RELEASE_INTENT = "pi_race_3953_release";
/** The change the capture pays for: a provenance stamp, no foreign key. */
const MODIFICATION_ID = "race-3953-modification";
const PRIMARY_INTENT = "pi_race_3953_primary";
const CHANGE_INTENT = "pi_race_3953_change";
const INVOICE_ID = "race-3953-xero-invoice";
const LOCK_POLL_TIMEOUT_MS = 5_000;

let prisma: PrismaClient;
let observerClient: PrismaClient;
let release: typeof import("@/lib/xero-supplementary-invoice-late-capture");
let enqueue: typeof import("@/lib/additional-capture-receipt-enqueue");
let outbox: typeof import("@/lib/xero-operation-outbox");
let gapCheck: typeof import("@/lib/xero-primary-invoice-fee-gap");
let invoiceKey: typeof import("@/lib/xero-booking-invoice-key");
let worker: typeof import("@/lib/additional-capture-xero-receipt");
let busy: typeof import("@/lib/xero-applied-credit-operation-serialization");
let claim: typeof import("@/lib/xero-operation-claim");
let gate: typeof import("@/lib/additional-capture-receipt-gate");

async function receiptRows() {
  return prisma.xeroSyncOperation.findMany({
    where: { localModel: "PaymentTransaction", localId: CHANGE_TX_ID, queueType: "ADDITIONAL_CAPTURE_RECEIPT" },
    select: { id: true, status: true, correlationKey: true, requestPayload: true },
  });
}

async function clean(): Promise<void> {
  await prisma.xeroSyncOperation.deleteMany({
    where: { localId: { in: [CHANGE_TX_ID, CHANGE_TX_2_ID, RELEASE_TX_ID, PRIMARY_TX_ID, PAYMENT_ID, BOOKING_ID, MODIFICATION_ID] } },
  });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

/** A confirmed card booking, its primary invoice linked, and a change's captured card ask nothing waited on. */
async function seed(): Promise<void> {
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
    data: {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      amountCents: 38_000,
      source: "STRIPE",
      status: "SUCCEEDED",
      stripePaymentIntentId: PRIMARY_INTENT,
      xeroInvoiceId: INVOICE_ID,
    },
  });
  await prisma.paymentTransaction.create({
    data: {
      id: PRIMARY_TX_ID,
      paymentId: PAYMENT_ID,
      kind: "PRIMARY",
      source: "STRIPE",
      stripePaymentIntentId: PRIMARY_INTENT,
      amountCents: 30_000,
      status: "SUCCEEDED",
    },
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
      bookingModificationId: MODIFICATION_ID,
    },
  });
}

/** How many sessions are queued behind this backend (`pg_blocking_pids`). */
async function untilQueuedBehind(blockerPid: number, target = 1): Promise<number> {
  const startedAt = process.hrtime.bigint();
  let queued = 0;
  while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
    const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
      WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
    `;
    queued = rows[0]?.count ?? 0;
    if (queued >= target) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return queued;
}

(RUN ? describe : describe.skip)("a change's card capture is given one Xero receipt, on PostgreSQL (#3953)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Change capture receipt");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    release = await import("@/lib/xero-supplementary-invoice-late-capture");
    enqueue = await import("@/lib/additional-capture-receipt-enqueue");
    outbox = await import("@/lib/xero-operation-outbox");
    gapCheck = await import("@/lib/xero-primary-invoice-fee-gap");
    invoiceKey = await import("@/lib/xero-booking-invoice-key");
    worker = await import("@/lib/additional-capture-xero-receipt");
    busy = await import("@/lib/xero-applied-credit-operation-serialization");
    claim = await import("@/lib/xero-operation-claim");
    gate = await import("@/lib/additional-capture-receipt-gate");
    const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
      import("@prisma/client"),
      import("@/lib/prisma-adapter"),
    ]);
    const observerUrl = new URL(RACE_DB_URL);
    observerUrl.searchParams.set("connection_limit", "1");
    observerUrl.searchParams.set("application_name", "race-3953-observer");
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
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3953 Lodge", slug: "race-3953" } });
  }, 120_000);

  beforeEach(async () => {
    await clean();
    await seed();
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

  it("the webhook and the confirm route at once, then a replay, queue one receipt", async () => {
    // A barrier: a session holds the change's anchor lock until BOTH releases
    // are queued on it, so they genuinely contend rather than run in turn.
    let holderPid = 0;
    let releaseHolder!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
        holderPid = rows[0]?.pid ?? 0;
        await outbox.lockSupplementaryInvoiceAnchor(tx, MODIFICATION_ID);
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await lockTaken;
    const both = Promise.all([
      release.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(CHANGE_INTENT),
      release.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(CHANGE_INTENT),
    ]);
    expect(await untilQueuedBehind(holderPid, 2)).toBe(2);
    releaseHolder();
    await holder;
    const [webhook, confirmRoute] = await both;
    const replay = await release.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(CHANGE_INTENT);

    const rows = await receiptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        status: "PENDING",
        correlationKey: `payment-intent:${CHANGE_INTENT}:additional-capture-receipt:v1`,
        requestPayload: expect.objectContaining({ paymentIntentId: CHANGE_INTENT, paymentTransactionId: CHANGE_TX_ID }),
      }),
    );
    const outcomes = [webhook, confirmRoute, replay].map((result) => result.outcome).sort();
    expect(outcomes).toEqual(["already-released", "already-released", "receipt-queued"]);
    // Exactly one caller is told to kick the outbox for it.
    expect(webhook.released + confirmRoute.released + replay.released).toBe(1);
  });

  it("many enqueues at once make one row", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => enqueue.enqueueAdditionalCaptureReceiptOperation(CHANGE_INTENT)),
    );

    const rows = await receiptRows();
    expect(rows).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "queued")).toHaveLength(1);
    expect(new Set(results.map((result) => ("queueOperationId" in result ? result.queueOperationId : null)))).toEqual(
      new Set([rows[0]!.id]),
    );
  });

  it("queues behind a session holding the change's supplementary-invoice anchor lock, then finds its row", async () => {
    let holderPid = 0;
    let releaseHolder!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // The holder takes the anchor lock and, under it, queues the row itself.
    const holder = prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
        holderPid = rows[0]?.pid ?? 0;
        await outbox.lockSupplementaryInvoiceAnchor(tx, MODIFICATION_ID);
        locked();
        await held;
        await tx.xeroSyncOperation.create({
          data: {
            direction: "OUTBOUND",
            entityType: "PAYMENT",
            operationType: "CREATE",
            localModel: "PaymentTransaction",
            localId: CHANGE_TX_ID,
            status: "PENDING",
            queueType: "ADDITIONAL_CAPTURE_RECEIPT",
            correlationKey: `payment-intent:${CHANGE_INTENT}:additional-capture-receipt:v1`,
            idempotencyKey: `payment-intent:${CHANGE_INTENT}:additional-capture-receipt:v1`,
            requestPayload: { queueType: "ADDITIONAL_CAPTURE_RECEIPT" },
          },
        });
      },
      { timeout: 20_000 },
    );
    await lockTaken;

    const waiting = enqueue.enqueueAdditionalCaptureReceiptOperation(CHANGE_INTENT);
    expect(await untilQueuedBehind(holderPid)).toBe(1);
    releaseHolder();
    await holder;

    const result = await waiting;
    expect(result.outcome).toBe("already-queued");
    expect(await receiptRows()).toHaveLength(1);
  });

  it("an invoice for the change queued after its capture's receipt stored a decision is raised unpaid (round 6, 1a)", async () => {
    const key = `payment-intent:${CHANGE_INTENT}:additional-capture-receipt:v1`;
    await prisma.xeroSyncOperation.create({
      data: {
        direction: "OUTBOUND",
        entityType: "PAYMENT",
        operationType: "CREATE",
        localModel: "PaymentTransaction",
        localId: CHANGE_TX_ID,
        status: "FAILED",
        queueType: "ADDITIONAL_CAPTURE_RECEIPT",
        correlationKey: key,
        idempotencyKey: key,
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

    // The repair tool's arm, from a sweep that read no receipt: it asks to record the payment.
    await outbox.enqueueXeroSupplementaryInvoiceOperation(
      { bookingId: BOOKING_ID, priceDiffCents: 8_000, changeFeeCents: 0, bookingModificationId: MODIFICATION_ID },
      { recordPayment: true, paymentIntentId: CHANGE_INTENT },
    );

    const invoices = await prisma.xeroSyncOperation.findMany({
      where: { localModel: "BookingModification", localId: MODIFICATION_ID, queueType: "SUPPLEMENTARY_INVOICE" },
      select: { requestPayload: true },
    });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.requestPayload).toMatchObject({ recordPayment: false, paymentIntentId: CHANGE_INTENT });
  });

  it("a retired invoice revived for the capture while its receipt stores a decision is revived unpaid (round 8)", async () => {
    await prisma.xeroSyncOperation.create({
      data: {
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: MODIFICATION_ID,
        status: "CANCELLED",
        lastErrorCode: "STALE_WAITING_PAYMENT",
        queueType: "SUPPLEMENTARY_INVOICE",
        correlationKey: `race-3953:${MODIFICATION_ID}:retired`,
        idempotencyKey: `race-3953:${MODIFICATION_ID}:retired`,
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: BOOKING_ID,
          bookingModificationId: MODIFICATION_ID,
          priceDiffCents: 8_000,
          changeFeeCents: 0,
          recordPayment: true,
          paymentIntentId: CHANGE_INTENT,
          waitForConfirmedAdditionalPayment: true,
        },
      },
    });
    const key = `payment-intent:${CHANGE_INTENT}:additional-capture-receipt:v1`;
    let holderPid = 0;
    let releaseHolder!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // The receipt's plan store: under the change's anchor lock, it stores its decision.
    const holder = prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
        holderPid = rows[0]?.pid ?? 0;
        await outbox.lockSupplementaryInvoiceAnchor(tx, MODIFICATION_ID);
        locked();
        await held;
        await tx.xeroSyncOperation.create({
          data: {
            direction: "OUTBOUND",
            entityType: "PAYMENT",
            operationType: "CREATE",
            localModel: "PaymentTransaction",
            localId: CHANGE_TX_ID,
            status: "RUNNING",
            queueType: "ADDITIONAL_CAPTURE_RECEIPT",
            correlationKey: key,
            idempotencyKey: key,
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
      },
      { timeout: 20_000 },
    );
    await lockTaken;

    // The webhook's late-success release finds the retired invoice and revives it.
    const reviving = release.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(CHANGE_INTENT);
    reviving.catch(() => undefined);
    expect(await untilQueuedBehind(holderPid)).toBe(1);
    releaseHolder();
    await holder;
    expect((await reviving).outcome).toBe("requeued");

    const invoices = await prisma.xeroSyncOperation.findMany({
      where: { localModel: "BookingModification", localId: MODIFICATION_ID, queueType: "SUPPLEMENTARY_INVOICE" },
      select: { status: true, requestPayload: true },
    });
    // One recording: the receipt's; the revived invoice bills the change and records nothing.
    expect(invoices).toEqual([
      { status: "PENDING", requestPayload: expect.objectContaining({ recordPayment: false, paymentIntentId: CHANGE_INTENT }) },
    ]);
    expect(await receiptRows()).toHaveLength(1);
  });

  describe("a capture landing between the primary create's read and its gap check (review round 1)", () => {
    const INVOICE_LINES_CENTS = 30_000;
    /** The figures the create stored at its link: it billed and recorded the booking's own 300.00. */
    const atLink = (recordedIntents: string[] | undefined) => ({
      xeroInvoiceId: INVOICE_ID,
      billedChangeFeeCents: 0,
      billedTotalCents: INVOICE_LINES_CENTS,
      recordedChangeFeeCentsAtLink: 0,
      primaryInvoiceCashCents: INVOICE_LINES_CENTS,
      worth: { atBuildCents: INVOICE_LINES_CENTS, builtTotalCents: INVOICE_LINES_CENTS, atLinkCents: 38_000, markedModificationIdsAtBuild: [] },
      ...(recordedIntents ? { paymentIntentIdsRecordedAtLink: recordedIntents } : {}),
    });

    beforeEach(async () => {
      // The change raced the create: it settled against the primary invoice,
      // outside the create's snapshot, and moved 80.00 - the gap's anchor.
      await prisma.bookingModification.create({
        data: {
          id: MODIFICATION_ID,
          bookingId: BOOKING_ID,
          memberId: OWNER_ID,
          modificationType: "GUEST_ADD",
          previousData: {},
          newData: { primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } },
          priceDiffCents: 8_000,
        },
      });
    });

    async function gapRows() {
      return prisma.xeroSyncOperation.findMany({
        where: { localModel: "BookingModification", localId: MODIFICATION_ID, queueType: "SUPPLEMENTARY_INVOICE" },
        select: { requestPayload: true },
      });
    }

    it("is recorded once, by its receipt, where the figures say the primary's cash did not cover it", async () => {
      const result = await gapCheck.queuePrimaryInvoiceWorthGap({ bookingId: BOOKING_ID, atLink: atLink([PRIMARY_INTENT]) });

      expect(result).toMatchObject({ gapCents: 8_000, cashTakenCents: 0 });
      const gaps = await gapRows();
      expect(gaps).toHaveLength(1);
      expect(gaps[0]!.requestPayload).toMatchObject({ recordPayment: false, primaryInvoiceGap: true, coveredPaymentIntentIds: [] });
      expect(await receiptRows()).toHaveLength(1);

      // The capture's own release, replayed after the link: still one receipt.
      await release.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(CHANGE_INTENT);
      expect(await receiptRows()).toHaveLength(1);
    });

    it("is recorded once, by the gap invoice that names it, where the figures cannot say - and its receipt stands down", async () => {
      // The create's own row, with the figures it stored at its link, so the
      // gap invoice is known to bill this change: only its naming the capture
      // stands the receipt down.
      const figures = atLink(undefined);
      const key = invoiceKey.buildXeroBookingInvoiceCorrelationKey(BOOKING_ID);
      const create = await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND",
          entityType: "INVOICE",
          operationType: "CREATE",
          localModel: "Payment",
          localId: PAYMENT_ID,
          status: "SUCCEEDED",
          correlationKey: key,
          idempotencyKey: key,
          xeroObjectId: INVOICE_ID,
          requestPayload: { primaryInvoiceBilledFee: figures },
        },
      });
      const result = await gapCheck.queuePrimaryInvoiceWorthGap({ bookingId: BOOKING_ID, atLink: figures, figuresOperationId: create.id });

      expect(result).toMatchObject({ gapCents: 8_000, cashTakenCents: 8_000 });
      const gaps = await gapRows();
      expect(gaps[0]!.requestPayload).toMatchObject({
        recordPayment: true,
        coveredPaymentIntentIds: [CHANGE_INTENT],
        coveredCaptureCents: { [CHANGE_INTENT]: 8_000 },
      });
      expect(await receiptRows()).toHaveLength(0);

      await expect(enqueue.enqueueAdditionalCaptureReceiptOperation(CHANGE_INTENT)).resolves.toEqual({
        outcome: "not-eligible",
        reason: "recorded-by-supplementary-invoice",
      });
      expect((await release.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(CHANGE_INTENT)).outcome).toBe("none-queued");
      expect(await receiptRows()).toHaveLength(0);
    });
  });

  describe("#4494: a credit-release capture before the gap check re-runs", () => {
    const INVOICE_LINES_CENTS = 30_000;

    beforeEach(async () => {
      // The edit raced the create and anchors the 80.00 gap, as above.
      await prisma.bookingModification.create({
        data: {
          id: MODIFICATION_ID,
          bookingId: BOOKING_ID,
          memberId: OWNER_ID,
          modificationType: "GUEST_ADD",
          previousData: {},
          newData: { primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } },
          priceDiffCents: 8_000,
        },
      });
      // The create stored its figures, in the recorded-at-link form, and died
      // before it queued the gap: no gap operation exists.
      const key = invoiceKey.buildXeroBookingInvoiceCorrelationKey(BOOKING_ID);
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND",
          entityType: "INVOICE",
          operationType: "CREATE",
          localModel: "Payment",
          localId: PAYMENT_ID,
          status: "SUCCEEDED",
          correlationKey: key,
          idempotencyKey: key,
          xeroObjectId: INVOICE_ID,
          requestPayload: {
            primaryInvoiceBilledFee: {
              xeroInvoiceId: INVOICE_ID,
              billedChangeFeeCents: 0,
              billedTotalCents: INVOICE_LINES_CENTS,
              recordedChangeFeeCentsAtLink: 0,
              primaryInvoiceCashCents: INVOICE_LINES_CENTS,
              worth: { atBuildCents: INVOICE_LINES_CENTS, builtTotalCents: INVOICE_LINES_CENTS, atLinkCents: 38_000, markedModificationIdsAtBuild: [] },
              paymentIntentIdsRecordedAtLink: [PRIMARY_INTENT],
            },
          },
        },
      });
    });

    /** A release request raised, asked for and paid by card - 100.00, more than the 80.00 gap. */
    async function captureRelease(over: { status: "SUCCEEDED" | "PARTIALLY_REFUNDED"; refundedAmountCents: number }) {
      await prisma.paymentTransaction.create({
        data: {
          id: RELEASE_TX_ID,
          paymentId: PAYMENT_ID,
          kind: "ADDITIONAL",
          source: "STRIPE",
          reason: "credit_released_outside_app",
          carriedAskCents: 0,
          stripePaymentIntentId: RELEASE_INTENT,
          amountCents: 10_000,
          hadIssuedXeroInvoice: false,
          ...over,
        },
      });
    }

    async function gapPayloads() {
      const rows = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "BookingModification", localId: MODIFICATION_ID, queueType: "SUPPLEMENTARY_INVOICE" },
        select: { requestPayload: true },
      });
      return rows.map((row) => row.requestPayload);
    }

    it.each([
      ["paid in full, the sweep's own", { status: "SUCCEEDED" as const, refundedAmountCents: 0 }],
      ["partly refunded, held by the sweep for an officer", { status: "PARTIALLY_REFUNDED" as const, refundedAmountCents: 1_000 }],
    ])("is never the gap invoice's cash when %s: raised unpaid, naming nothing", async (_name, over) => {
      await captureRelease(over);

      const result = await gapCheck.recheckPrimaryInvoiceWorthGap({ bookingId: BOOKING_ID, xeroInvoiceId: INVOICE_ID });

      expect(result).toMatchObject({ gapCents: 8_000, cashTakenCents: 0 });
      expect(await gapPayloads()).toEqual([
        expect.objectContaining({ primaryInvoiceGap: true, recordPayment: false, coveredPaymentIntentIds: [], coveredCaptureCents: {} }),
      ]);
      // The edit's own capture has its receipt; the release capture has none - the sweep records it.
      expect(await receiptRows()).toHaveLength(1);
      const releaseReceipts = await prisma.xeroSyncOperation.count({
        where: { localModel: "PaymentTransaction", localId: RELEASE_TX_ID, queueType: "ADDITIONAL_CAPTURE_RECEIPT" },
      });
      expect(releaseReceipts).toBe(0);
    });
  });

  describe("two receipts on one booking, claimed and run at once (review rounds 3 and 4)", () => {
    const STALE_MINUTES_AGO = 24 * 60;
    async function pendingReceipt(id: string, transactionId: string, intent: string) {
      const key = `payment-intent:${intent}:additional-capture-receipt:v1`;
      await prisma.xeroSyncOperation.create({
        data: {
          id,
          direction: "OUTBOUND",
          entityType: "PAYMENT",
          operationType: "CREATE",
          localModel: "PaymentTransaction",
          localId: transactionId,
          status: "PENDING",
          queueType: "ADDITIONAL_CAPTURE_RECEIPT",
          correlationKey: key,
          idempotencyKey: key,
          requestPayload: {
            queueType: "ADDITIONAL_CAPTURE_RECEIPT",
            bookingId: BOOKING_ID,
            paymentId: PAYMENT_ID,
            paymentTransactionId: transactionId,
            paymentIntentId: intent,
          },
        },
      });
    }
    async function runningCreate(startedAt: Date) {
      const key = invoiceKey.buildXeroBookingInvoiceCorrelationKey(BOOKING_ID);
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND",
          entityType: "INVOICE",
          operationType: "CREATE",
          localModel: "Payment",
          localId: PAYMENT_ID,
          status: "RUNNING",
          startedAt,
          correlationKey: key,
          idempotencyKey: key,
          requestPayload: {},
        },
      });
    }

    /**
     * Both receipts go through the outbox's REAL claim (PENDING -> RUNNING)
     * and the REAL worker from one barrier. A receipt that reaches Xero (the
     * provider seam) is held there until the other has finished, so the other
     * plans while the first is mid-flight - the case the gate exists for.
     */
    async function runTwoAtOnce(ids: string[]) {
      const reached: string[] = [];
      let settledCount = 0;
      let releaseSeam!: () => void;
      const seamHeld = new Promise<void>((resolve) => {
        releaseSeam = resolve;
      });
      let go!: () => void;
      const barrier = new Promise<void>((resolve) => {
        go = resolve;
      });
      const runs = ids.map((id) =>
        (async () => {
          await barrier;
          const claimed = await claim.claimXeroSyncOperationToRunning(id, {
            direction: "OUTBOUND",
            entityType: "PAYMENT",
            operationType: "CREATE",
            localModel: { in: ["PaymentTransaction"] },
          });
          if (!claimed) throw new Error(`claim of ${id} lost`);
          return worker.recordAdditionalCaptureReceipt(
            { syncOperation: claimed },
            {
              getAuthenticatedXeroClient: async () => {
                reached.push(id);
                await seamHeld;
                throw new busy.XeroAppliedCreditOperationBusyError("test: stop at the Xero call");
              },
              callXeroApi: (async () => {
                throw new Error("unreachable");
              }) as never,
              createXeroPaymentForInvoice: async () => {
                throw new Error("unreachable");
              },
              readStripeCaptureDocumentDate: async () => null,
            },
          );
        })().finally(() => {
          settledCount += 1;
        }),
      );
      // Observed now, so a run that settles before the end is never an unhandled rejection.
      for (const run of runs) run.catch(() => undefined);
      go();
      // Every run either finishes or is parked at the seam; neither may take long.
      const startedAt = process.hrtime.bigint();
      while (settledCount + reached.length < ids.length && realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      releaseSeam();
      return { reached, outcomes: await Promise.allSettled(runs) };
    }

    beforeEach(async () => {
      await prisma.paymentTransaction.create({
        data: {
          id: CHANGE_TX_2_ID,
          paymentId: PAYMENT_ID,
          kind: "ADDITIONAL",
          source: "STRIPE",
          stripePaymentIntentId: CHANGE_INTENT_2,
          amountCents: 2_000,
          status: "SUCCEEDED",
          bookingModificationId: "race-3953-modification-2",
        },
      });
      await pendingReceipt("race-3953-receipt-1", CHANGE_TX_ID, CHANGE_INTENT);
      await pendingReceipt("race-3953-receipt-2", CHANGE_TX_2_ID, CHANGE_INTENT_2);
    });

    it("only one of two receipts claimed at once reaches Xero; the other waits for it", async () => {
      const { reached, outcomes } = await runTwoAtOnce(["race-3953-receipt-1", "race-3953-receipt-2"]);

      expect(reached).toHaveLength(1);
      const waiter = outcomes.find((_outcome, index) => ["race-3953-receipt-1", "race-3953-receipt-2"][index] !== reached[0]);
      expect(waiter).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          waitCode: gate.ADDITIONAL_CAPTURE_RECEIPT_WAITING_CODE,
          message: expect.stringMatching(new RegExp(`Another card payment receipt for this booking \\(operation ${reached[0]!}\\)`)),
        }),
      });
    });

    it("both gates queue on the booking's anchor lock held elsewhere; released, only one passes (round 5, item 3)", async () => {
      let holderPid = 0;
      let releaseHolder!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
          holderPid = rows[0]?.pid ?? 0;
          await outbox.lockSupplementaryInvoiceAnchor(tx, BOOKING_ID);
          locked();
          await held;
        },
        { timeout: 20_000 },
      );
      await lockTaken;

      const ids = ["race-3953-receipt-1", "race-3953-receipt-2"];
      const reached: string[] = [];
      let settledCount = 0;
      let releaseSeam!: () => void;
      const seamHeld = new Promise<void>((resolve) => {
        releaseSeam = resolve;
      });
      const runs = ids.map((id) =>
        (async () => {
          const claimed = await claim.claimXeroSyncOperationToRunning(id, {
            direction: "OUTBOUND",
            entityType: "PAYMENT",
            operationType: "CREATE",
            localModel: { in: ["PaymentTransaction"] },
          });
          if (!claimed) throw new Error(`claim of ${id} lost`);
          return worker.recordAdditionalCaptureReceipt(
            { syncOperation: claimed },
            {
              getAuthenticatedXeroClient: async () => {
                reached.push(id);
                await seamHeld;
                throw new busy.XeroAppliedCreditOperationBusyError("test: stop at the Xero call");
              },
              callXeroApi: (async () => {
                throw new Error("unreachable");
              }) as never,
              createXeroPaymentForInvoice: async () => {
                throw new Error("unreachable");
              },
              readStripeCaptureDocumentDate: async () => null,
            },
          );
        })().finally(() => {
          settledCount += 1;
        }),
      );
      for (const run of runs) run.catch(() => undefined);

      // Both gates have read nothing yet: they wait on the lock, together.
      expect(await untilQueuedBehind(holderPid, 2)).toBe(2);
      expect(reached).toEqual([]);
      releaseHolder();
      await holder;

      const startedAt = process.hrtime.bigint();
      while (settledCount + reached.length < ids.length && realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      releaseSeam();
      const outcomes = await Promise.allSettled(runs);
      expect(reached).toHaveLength(1);
      const waiter = outcomes[ids.indexOf(ids.find((id) => id !== reached[0])!)];
      expect(waiter).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          waitCode: gate.ADDITIONAL_CAPTURE_RECEIPT_WAITING_CODE,
          message: expect.stringContaining("Another card payment receipt for this booking"),
        }),
      });
    });

    it("a create dead past the staleness threshold blocks neither; a live one blocks both", async () => {
      await runningCreate(new Date(Date.now() - STALE_MINUTES_AGO * 60_000));
      const dead = await runTwoAtOnce(["race-3953-receipt-1", "race-3953-receipt-2"]);
      // Not blocked by the dead create: one passes, the other waits only for it.
      expect(dead.reached).toHaveLength(1);

      // The stale reset retires the dead row (one active create per key); a live
      // create starts; both receipts, back to PENDING, run again.
      await prisma.xeroSyncOperation.updateMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, status: "RUNNING" },
        data: { status: "FAILED" },
      });
      await prisma.xeroSyncOperation.updateMany({
        where: { id: { in: ["race-3953-receipt-1", "race-3953-receipt-2"] } },
        data: { status: "PENDING", startedAt: null, lastErrorCode: null },
      });
      await runningCreate(new Date());
      const live = await runTwoAtOnce(["race-3953-receipt-1", "race-3953-receipt-2"]);
      expect(live.reached).toEqual([]);
      for (const outcome of live.outcomes) {
        expect(outcome).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("still being raised") }) });
      }
    });
  });
});
