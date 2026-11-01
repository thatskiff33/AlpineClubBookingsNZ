/**
 * Real-PostgreSQL proof for #4324 (owner decision 25 Oct 2026; `INV-PAY-144`,
 * `INV-PAY-139`): a late card payment for a booking change that a treasurer
 * KEPT on a cancelled booking whose primary invoice bills the change is
 * recorded by ONE document, decided once under the approval task's row lock
 * and then the change's supplementary-invoice anchor lock.
 *
 *  1. The keep (the dismissal's status-fenced claim, then its plan on the same
 *     transaction) racing the repair tool's supplementary invoice for the same
 *     change, both queued on a session holding the change's anchor lock: the
 *     capture ends with one recorder, whichever wins. And where the change's
 *     own ask was withdrawn, the repair tool re-raising its invoice ahead of
 *     the keep on that anchor: the keep decides after it, so no kept-capture
 *     invoice is raised beside it (what the anchor lock alone prevents).
 *  2. The repair tool's kept-capture action racing a keep of the same task,
 *     both queued on a session holding the task row: one receipt row, which
 *     the loser finds.
 *  3. A webhook replay of the capture after the keep (twice at once) goes
 *     through the REAL late-success release and answers `already-released`;
 *     no second record is queued.
 *  4. An approval after a reopen, committed while the receipt's worker is
 *     between its claim and its locked decision: the worker reads the task
 *     again under the anchor lock and stands down - no payment reaches Xero.
 *  5. (Review C1.) A re-keep after a reopen racing the receipt's worker, the
 *     worker first on the change's anchor while the re-keep's claim is still
 *     uncommitted: the worker closes its row in the transaction that read
 *     "not kept", so the re-keep queues a fresh receipt - one live recorder.
 *  6. (Item 11.) The keep raising the kept-capture invoice for a change whose
 *     own invoice was withdrawn, then the repair tool's supplementary enqueue
 *     for that change: no second invoice, paid or unpaid.
 *  7. (Review CONC-1.) A treasurer's paid-another-way close of the capture's
 *     approved refund racing the repair tool's supplementary invoice for the
 *     change, the invoice first on the change's anchor: the close reads its
 *     plan under that anchor, so it finds the invoice and queues no
 *     kept-capture invoice beside it - one recorder.
 *  8. (#3403 LANE-SYNC.) The change's waiting invoice moved off the
 *     capture's intent onto a carrier (#4406): the keep reads it as the
 *     change's invoice answering the capture, and the real release takes it
 *     back and pays it - no receipt and no kept-capture invoice beside it.
 *
 * The dismissal is driven as `resolveManualRefundTask` drives it - the
 * `OPEN -> DISMISSED` guarded `updateMany`, then `planKeptLateCaptureXeroRecord`
 * on the same transaction - rather than through the whole door, whose other
 * arms (settlement routes, audits) are this proof's noise.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-4324-` fixtures.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-4324-owner";
const LODGE_ID = "race-4324-lodge";
const BOOKING_ID = "race-4324-booking";
const PAYMENT_ID = "race-4324-payment";
const PRIMARY_TX_ID = "race-4324-primary-capture";
const CHANGE_TX_ID = "race-4324-change-capture";
const MODIFICATION_ID = "race-4324-modification";
/** 4384-R2: a second marked edit that raced the primary, made after the first - the gap's first anchor. */
const FIRST_ANCHOR_ID = "race-4324-modification-first";
const TASK_ID = "race-4324-approval-task";
const PRIMARY_INTENT = "pi_race_4324_primary";
const CHANGE_INTENT = "pi_race_4324_change";
/** #3403: the later request a superseded ask's invoice was moved onto. */
const CARRIER_INTENT = "pi_race_4324_carrier";
const INVOICE_ID = "race-4324-xero-invoice";
const ZONE = "Pacific/Auckland";
const LOCK_POLL_TIMEOUT_MS = 5_000;
const REFUND_OPERATION_ID = "race-4324-approval-refund";

let prisma: PrismaClient;
let observerClient: PrismaClient;
let keep: typeof import("@/lib/late-capture-kept-xero");
let release: typeof import("@/lib/xero-supplementary-invoice-late-capture");
let outbox: typeof import("@/lib/xero-operation-outbox");
let kept: typeof import("@/lib/xero-kept-late-capture-invoice");
let recorder: typeof import("@/lib/additional-capture-recorder");
let worker: typeof import("@/lib/additional-capture-xero-receipt");
let claim: typeof import("@/lib/xero-operation-claim");
let withdraw: typeof import("@/lib/additional-payment-withdraw");
let paidAnotherWay: typeof import("@/lib/card-refund-paid-another-way");
let gapCheck: typeof import("@/lib/xero-primary-invoice-fee-gap");
let invoiceKey: typeof import("@/lib/xero-booking-invoice-key");

async function clean(): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: REFUND_OPERATION_ID }, { targetId: BOOKING_ID }] } });
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentRecoveryOperation.deleteMany({ where: { id: REFUND_OPERATION_ID } });
  await prisma.xeroSyncOperation.deleteMany({
    where: { localId: { in: [CHANGE_TX_ID, PRIMARY_TX_ID, PAYMENT_ID, BOOKING_ID, MODIFICATION_ID, FIRST_ANCHOR_ID, TASK_ID] } },
  });
  await prisma.xeroObjectLink.deleteMany({ where: { localModel: "BookingModification", localId: MODIFICATION_ID } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

/**
 * A paid-cancelled card booking: its primary invoice ($380, raised after a $80
 * edit settled against it) linked, $300 paid; the change's $80 card ask
 * captured after the cancel, its approval task open.
 */
async function seed(taskStatus: "OPEN" | "DISMISSED" | "COMPLETED" = "OPEN", options: { marked?: boolean } = {}): Promise<void> {
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: new Date("2026-09-10T00:00:00.000Z"),
      checkOut: new Date("2026-09-12T00:00:00.000Z"),
      status: "CANCELLED",
      totalPriceCents: 38_000,
      finalPriceCents: 38_000,
    },
  });
  await prisma.bookingModification.create({
    data: {
      id: MODIFICATION_ID,
      bookingId: BOOKING_ID,
      memberId: OWNER_ID,
      modificationType: "GUEST_ADD",
      previousData: {},
      newData: options.marked === false ? {} : { primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } },
      priceDiffCents: 8_000,
    },
  });
  await prisma.payment.create({
    data: {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      amountCents: 30_000,
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
  await prisma.manualRefundTask.create({
    data: {
      id: TASK_ID,
      bookingId: BOOKING_ID,
      paymentId: PAYMENT_ID,
      kind: "DELETED_BOOKING_LATE_CAPTURE",
      status: taskStatus,
      lateCaptureApprovalIntentId: CHANGE_INTENT,
      amountCents: 8_000,
      reason: "Late capture held for a treasurer (race proof)",
      ...(taskStatus !== "OPEN" ? { completedAt: new Date("2026-06-20T00:00:00.000Z"), note: taskStatus === "DISMISSED" ? "kept" : "refund approved" } : {}),
    },
  });
}

const receiptRows = () =>
  prisma.xeroSyncOperation.findMany({
    where: { localModel: "PaymentTransaction", localId: CHANGE_TX_ID, queueType: "ADDITIONAL_CAPTURE_RECEIPT" },
    select: { id: true, status: true, lastErrorCode: true, requestPayload: true },
  });

const supplementaryRows = () =>
  prisma.xeroSyncOperation.findMany({
    where: { localModel: "BookingModification", localId: MODIFICATION_ID, queueType: "SUPPLEMENTARY_INVOICE" },
    select: { id: true, status: true, requestPayload: true },
  });

/** The keep, as `resolveManualRefundTask` runs it: the status-fenced claim, then the plan, on one transaction. */
function dismiss() {
  return prisma.$transaction(
    async (tx) => {
      const claimed = await tx.manualRefundTask.updateMany({
        where: { id: TASK_ID, status: "OPEN" },
        data: { status: "DISMISSED", completedAt: new Date(), note: "kept (race proof)" },
      });
      if (claimed.count === 0) return { kind: "lost-claim" as const };
      return keep.planKeptLateCaptureXeroRecord({
        manualRefundTaskId: TASK_ID,
        bookingId: BOOKING_ID,
        paymentIntentId: CHANGE_INTENT,
        clubZone: ZONE as never,
        store: tx,
      });
    },
    { timeout: 20_000 },
  );
}

/** The repair tool's kept-capture action: the same decision on a transaction of its own. */
function repairRecord() {
  return prisma.$transaction(
    (tx) =>
      keep.planKeptLateCaptureXeroRecord({
        manualRefundTaskId: TASK_ID,
        bookingId: BOOKING_ID,
        paymentIntentId: CHANGE_INTENT,
        clubZone: ZONE as never,
        store: tx,
      }),
    { timeout: 20_000 },
  );
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

/**
 * How many sessions in this database are waiting on a lock at all. Row locks
 * queue their waiters behind one another (the second waits on the first's
 * tuple lock), so a row-lock barrier counts waiters, not the holder's.
 */
async function untilWaiting(target: number): Promise<number> {
  const startedAt = process.hrtime.bigint();
  let waiting = 0;
  while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
    const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
      WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
    `;
    waiting = rows[0]?.count ?? 0;
    if (waiting >= target) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return waiting;
}

/** A session that takes `lock` and holds it until released; resolves its pid once held. */
async function holdLock(lock: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let releaseHolder!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });
  let pid = 0;
  let locked!: () => void;
  const lockTaken = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
      pid = rows[0]?.pid ?? 0;
      await lock(tx);
      locked();
      await held;
    },
    { timeout: 20_000 },
  );
  await lockTaken;
  return { pid, release: releaseHolder, done: holder };
}

(RUN ? describe : describe.skip)("a kept change capture is recorded once, on PostgreSQL (#4324)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Kept change capture record");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    keep = await import("@/lib/late-capture-kept-xero");
    release = await import("@/lib/xero-supplementary-invoice-late-capture");
    outbox = await import("@/lib/xero-operation-outbox");
    kept = await import("@/lib/xero-kept-late-capture-invoice");
    recorder = await import("@/lib/additional-capture-recorder");
    worker = await import("@/lib/additional-capture-xero-receipt");
    claim = await import("@/lib/xero-operation-claim");
    withdraw = await import("@/lib/additional-payment-withdraw");
    paidAnotherWay = await import("@/lib/card-refund-paid-another-way");
    gapCheck = await import("@/lib/xero-primary-invoice-fee-gap");
    invoiceKey = await import("@/lib/xero-booking-invoice-key");
    const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
      import("@prisma/client"),
      import("@/lib/prisma-adapter"),
    ]);
    const observerUrl = new URL(RACE_DB_URL);
    observerUrl.searchParams.set("connection_limit", "1");
    observerUrl.searchParams.set("application_name", "race-4324-observer");
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
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4324 Lodge", slug: "race-4324" } });
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

  it("the keep and the repair tool's supplementary invoice for the change, at once: one recorder", { timeout: 30_000 }, async () => {
    // A change that never had a supplementary invoice, which the repair tool now raises.
    await seed("OPEN", { marked: false });
    const holder = await holdLock((tx) => outbox.lockSupplementaryInvoiceAnchor(tx, MODIFICATION_ID));
    const both = Promise.allSettled([
      dismiss(),
      outbox.enqueueXeroSupplementaryInvoiceOperation({
        bookingId: BOOKING_ID,
        bookingModificationId: MODIFICATION_ID,
        priceDiffCents: 8_000,
        changeFeeCents: 0,
      }),
    ]);
    expect(await untilQueuedBehind(holder.pid, 2)).toBe(2);
    holder.release();
    await holder.done;
    const [keepOutcome, invoiceOutcome] = await both;
    expect(keepOutcome.status).toBe("fulfilled");
    expect(invoiceOutcome.status).toBe("fulfilled");

    const receipts = (await receiptRows()).filter((row) => row.status !== "CANCELLED");
    const invoices = (await supplementaryRows()).filter((row) => row.status !== "CANCELLED");
    expect(invoices).toHaveLength(1);
    // Whichever won, the capture's recorder is one document: the change's own
    // invoice where it records the payment (a queued receipt then stands down
    // at its worker), else the receipt.
    const now = await recorder.readCaptureRecorder({
      bookingId: BOOKING_ID,
      primaryInvoiceId: INVOICE_ID,
      paymentIntentId: CHANGE_INTENT,
      bookingModificationId: MODIFICATION_ID,
    });
    const invoicePays = (invoices[0]!.requestPayload as { recordPayment?: boolean }).recordPayment !== false;
    if (invoicePays) {
      expect(now.kind).toBe("supplementary-invoice");
    } else {
      expect(receipts).toHaveLength(1);
      expect(now.kind).toBe("receipt");
    }
    expect(receipts.length).toBeLessThanOrEqual(1);
  });

  it("MUTATION (anchor lock): the repair tool re-raises a withdrawn change's invoice ahead of the keep - the keep decides after it, so no kept invoice is raised beside it", { timeout: 30_000 }, async () => {
    // The change's own ask was withdrawn (the real enqueue, then the write
    // `withdrawAdditionalPaymentAsk` makes), so on its own the keep reads
    // "nothing bills the change" and would raise the kept-capture invoice.
    await seed("OPEN", { marked: false });
    const withdrawnAsk = await outbox.enqueueXeroSupplementaryInvoiceOperation(
      { bookingId: BOOKING_ID, bookingModificationId: MODIFICATION_ID, priceDiffCents: 8_000, changeFeeCents: 0 },
      { paymentIntentId: "pi_race_4324_superseded", waitForConfirmedAdditionalPayment: true },
    );
    expect(withdrawnAsk.queueOperationId).toBeTruthy();
    await prisma.xeroSyncOperation.updateMany({
      where: { id: withdrawnAsk.queueOperationId!, status: "WAITING_PAYMENT" },
      data: { status: "CANCELLED", completedAt: new Date(), lastErrorCode: withdraw.ADDITIONAL_ASK_WITHDRAWN_XERO_ERROR_CODE },
    });

    // The repair tool's supplementary invoice for the change queues first on
    // the change's anchor; the keep starts only once it is queued there. The
    // keep's decision serialises on that anchor and NOT on anything the repair
    // enqueue holds, so only the anchor lock puts it behind the invoice.
    const holder = await holdLock((tx) => outbox.lockSupplementaryInvoiceAnchor(tx, MODIFICATION_ID));
    let queuedBehind = 0;
    let keepOutcome: PromiseSettledResult<Awaited<ReturnType<typeof dismiss>>> | undefined;
    let invoiceOutcome: PromiseSettledResult<unknown> | undefined;
    try {
      const reRaise = outbox.enqueueXeroSupplementaryInvoiceOperation({
        bookingId: BOOKING_ID,
        bookingModificationId: MODIFICATION_ID,
        priceDiffCents: 8_000,
        changeFeeCents: 0,
      });
      const reRaiseSettled = reRaise.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      expect(await untilQueuedBehind(holder.pid, 1)).toBe(1);
      const keepRun = dismiss();
      const keepSettled = keepRun.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      // Under the lock the keep queues behind the holder too; without it the
      // keep decides at once, and this stops waiting when it has.
      queuedBehind = await Promise.race([untilQueuedBehind(holder.pid, 2), keepSettled.then(() => -1)]);
      holder.release();
      await holder.done;
      [keepOutcome, invoiceOutcome] = await Promise.all([keepSettled, reRaiseSettled]);
    } finally {
      holder.release();
      await holder.done.catch(() => undefined);
    }

    expect(invoiceOutcome?.status).toBe("fulfilled");
    expect(keepOutcome?.status).toBe("fulfilled");
    const keptInvoices = await prisma.xeroSyncOperation.findMany({
      where: { localModel: "ManualRefundTask", localId: TASK_ID, queueType: "KEPT_LATE_CAPTURE_INVOICE" },
      select: { id: true, status: true },
    });
    const invoices = (await supplementaryRows()).filter((row) => row.status !== "CANCELLED");
    expect(keptInvoices).toEqual([]);
    expect(invoices).toHaveLength(1);
    expect((invoices[0]!.requestPayload as { recordPayment?: boolean }).recordPayment).toBe(true);
    expect((await receiptRows()).filter((row) => row.status !== "CANCELLED")).toEqual([]);
    // One recorder: the change's re-raised invoice records the $80.
    await expect(
      recorder.readCaptureRecorder({
        bookingId: BOOKING_ID,
        primaryInvoiceId: INVOICE_ID,
        paymentIntentId: CHANGE_INTENT,
        bookingModificationId: MODIFICATION_ID,
      }),
    ).resolves.toMatchObject({ kind: "supplementary-invoice" });
    expect(keepOutcome).toEqual({ status: "fulfilled", value: { kind: "none" } });
    // The keep waited on the change's anchor, behind the repair tool's invoice.
    expect(queuedBehind).toBe(2);
  });

  it("the repair tool's action and a re-keep of the same task, at once: one receipt, which the loser finds", { timeout: 30_000 }, async () => {
    await seed("DISMISSED");
    const holder = await holdLock((tx) => kept.lockKeptLateCaptureTask(tx, TASK_ID));
    const both = Promise.all([repairRecord(), repairRecord()]);
    expect(await untilWaiting(2)).toBe(2);
    holder.release();
    await holder.done;
    const outcomes = await both;

    const rows = await receiptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "PENDING" });
    expect(outcomes).toEqual([
      { kind: "receipt-queued", queueOperationId: rows[0]!.id },
      { kind: "receipt-queued", queueOperationId: rows[0]!.id },
    ]);
    const keptInvoices = await prisma.xeroSyncOperation.count({
      where: { localModel: "ManualRefundTask", localId: TASK_ID, queueType: "KEPT_LATE_CAPTURE_INVOICE" },
    });
    expect(keptInvoices).toBe(0);
  });

  it("the keep against the repair tool's action on a task still OPEN: one receipt, whichever commits first", { timeout: 30_000 }, async () => {
    await seed("OPEN");
    const holder = await holdLock((tx) => kept.lockKeptLateCaptureTask(tx, TASK_ID));
    const both = Promise.all([dismiss(), repairRecord()]);
    expect(await untilWaiting(2)).toBe(2);
    holder.release();
    await holder.done;
    await both;
    expect(await receiptRows()).toHaveLength(1);
  });

  it("a webhook replay after the keep, twice at once, answers already-released and queues no second record", async () => {
    await seed("OPEN");
    const plan = await dismiss();
    expect(plan).toMatchObject({ kind: "receipt-queued" });
    const replays = await Promise.all([
      release.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(CHANGE_INTENT),
      release.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(CHANGE_INTENT),
    ]);
    expect(replays.map((result) => result.outcome)).toEqual(["already-released", "already-released"]);
    expect(replays.every((result) => result.released === 0)).toBe(true);
    expect(await receiptRows()).toHaveLength(1);
  });

  it("MUTATION #3403 LANE-SYNC: the change's invoice moved off the capture's intent onto a carrier answers the keep - the release takes it back and pays it, and nothing else records the capture", async () => {
    await seed("OPEN", { marked: false });
    // The change's invoice, parked on its ask (the real enqueue) ...
    const parked = await outbox.enqueueXeroSupplementaryInvoiceOperation(
      { bookingId: BOOKING_ID, bookingModificationId: MODIFICATION_ID, priceDiffCents: 8_000, changeFeeCents: 0 },
      { paymentIntentId: CHANGE_INTENT, waitForConfirmedAdditionalPayment: true },
    );
    const parkedRow = await prisma.xeroSyncOperation.findUniqueOrThrow({
      where: { id: parked.queueOperationId! },
      select: { status: true, requestPayload: true },
    });
    expect(parkedRow.status).toBe("WAITING_PAYMENT");
    // ... then moved by #4406's supersede onto the request carrying its
    // balance, written as `followSupersededAskInvoicesToCarrier` writes it.
    await prisma.xeroSyncOperation.update({
      where: { id: parked.queueOperationId! },
      data: {
        requestPayload: {
          ...(parkedRow.requestPayload as Prisma.JsonObject),
          paymentIntentId: CARRIER_INTENT,
          parkedFromPaymentIntentId: CHANGE_INTENT,
        },
      },
    });

    // The keep reads the moved invoice as the change's, answering this capture.
    const plan = await dismiss();
    expect(plan).toEqual({ kind: "change-payment", paymentIntentId: CHANGE_INTENT });
    expect(await receiptRows()).toEqual([]);

    // The real release takes it back to this capture's intent and releases it, paid.
    const released = await release.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(CHANGE_INTENT);
    expect(released.released).toBe(1);
    const invoices = await supplementaryRows();
    expect(invoices).toHaveLength(1);
    const payload = invoices[0]!.requestPayload as Record<string, unknown>;
    expect(invoices[0]!.status).not.toBe("WAITING_PAYMENT");
    expect(invoices[0]!.status).not.toBe("CANCELLED");
    expect(payload).toMatchObject({ paymentIntentId: CHANGE_INTENT, takenBackFromPaymentIntentId: CARRIER_INTENT });
    expect(payload.parkedFromPaymentIntentId).toBeUndefined();
    expect(payload.recordPayment).not.toBe(false);

    // One recorder: the change's invoice. No receipt, no kept-capture invoice.
    expect(await receiptRows()).toEqual([]);
    expect(
      await prisma.xeroSyncOperation.count({ where: { localModel: "ManualRefundTask", localId: TASK_ID, queueType: "KEPT_LATE_CAPTURE_INVOICE" } }),
    ).toBe(0);
    await expect(
      recorder.readCaptureRecorder({
        bookingId: BOOKING_ID,
        primaryInvoiceId: INVOICE_ID,
        paymentIntentId: CHANGE_INTENT,
        bookingModificationId: MODIFICATION_ID,
      }),
    ).resolves.toEqual({ kind: "supplementary-invoice", operationId: parked.queueOperationId });
  });

  it("a re-kept capture whose named invoice was issued unpaid gets a receipt, not a second invoice", async () => {
    await seed("OPEN", { marked: false });
    const invoice = await outbox.enqueueXeroSupplementaryInvoiceOperation(
      { bookingId: BOOKING_ID, bookingModificationId: MODIFICATION_ID, priceDiffCents: 8_000, changeFeeCents: 0 },
      { paymentIntentId: CHANGE_INTENT, recordPayment: false },
    );
    await prisma.xeroSyncOperation.updateMany({
      where: { id: invoice.queueOperationId!, status: "PENDING" },
      data: { status: "SUCCEEDED", completedAt: new Date() },
    });
    await prisma.xeroObjectLink.create({
      data: { localModel: "BookingModification", localId: MODIFICATION_ID, xeroObjectType: "INVOICE", xeroObjectId: "race-4324-unpaid-invoice", role: "SUPPLEMENTARY_INVOICE", active: true },
    });
    await expect(dismiss()).resolves.toMatchObject({ kind: "receipt-queued" });
    const rows = await receiptRows();
    expect(rows).toHaveLength(1);
    const replay = await repairRecord();
    expect(replay).toEqual({ kind: "receipt-queued", queueOperationId: rows[0]!.id });
    await expect(recorder.readCaptureRecorder({
      bookingId: BOOKING_ID, primaryInvoiceId: INVOICE_ID,
      paymentIntentId: CHANGE_INTENT, bookingModificationId: MODIFICATION_ID,
    })).resolves.toMatchObject({ kind: "receipt", target: { kind: "CHANGE_INVOICE", operation: { id: invoice.queueOperationId } } });
    expect(await prisma.xeroSyncOperation.count({ where: { localId: TASK_ID, queueType: "KEPT_LATE_CAPTURE_INVOICE" } })).toBe(0);
  });

  it("an approval committed between the receipt worker's claim and its locked decision: the worker stands down, nothing reaches Xero", async () => {
    await seed("OPEN");
    await dismiss();
    const [row] = await receiptRows();
    const claimed = await claim.claimXeroSyncOperationToRunning(row!.id, {
      direction: "OUTBOUND",
      entityType: "PAYMENT",
      operationType: "CREATE",
      localModel: { in: ["PaymentTransaction"] },
    });
    expect(claimed).toBeTruthy();
    // Reopened, then approved: the approval's claim and its settlement, on one transaction.
    await prisma.$transaction(async (tx) => {
      await tx.manualRefundTask.update({ where: { id: TASK_ID }, data: { status: "COMPLETED" } });
      await kept.settleKeptLateCaptureRecordOnApproval({ manualRefundTaskId: TASK_ID, paymentIntentId: CHANGE_INTENT, store: tx });
    });
    // A RUNNING row is not the approval's to withdraw; its worker reads the task again.
    expect((await receiptRows())[0]).toMatchObject({ status: "RUNNING" });

    const paid: unknown[] = [];
    await worker.recordAdditionalCaptureReceipt(
      { syncOperation: claimed! },
      {
        getAuthenticatedXeroClient: async () =>
          ({
            tenantId: "tenant",
            xero: {
              accountingApi: {
                getInvoice: async () => ({
                  body: { invoices: [{ invoiceID: INVOICE_ID, status: "AUTHORISED", amountDue: 80, payments: [] }] },
                }),
              },
            },
          }) as never,
        callXeroApi: ((call: () => Promise<unknown>) => call()) as never,
        createXeroPaymentForInvoice: async (input) => {
          paid.push(input);
          return "xero_payment_unreachable";
        },
        readStripeCaptureDocumentDate: async () => "2026-06-20",
      },
    );
    expect(paid).toEqual([]);
    expect((await receiptRows())[0]).toMatchObject({ status: "CANCELLED" });
  });

  it("MUTATION review C1: a re-keep racing the receipt's worker after a reopen ends with exactly one live recorder", { timeout: 30_000 }, async () => {
    await seed("OPEN");
    await dismiss();
    const [row] = await receiptRows();
    // Reopened (DISMISSED -> OPEN), and the outbox claims the undecided receipt.
    await prisma.manualRefundTask.update({ where: { id: TASK_ID }, data: { status: "OPEN", completedAt: null } });
    const claimed = await claim.claimXeroSyncOperationToRunning(row!.id, {
      direction: "OUTBOUND",
      entityType: "PAYMENT",
      operationType: "CREATE",
      localModel: { in: ["PaymentTransaction"] },
    });
    expect(claimed).toBeTruthy();

    // The worker queues first on the change's anchor, then the re-keep (its
    // OPEN -> DISMISSED claim uncommitted behind it). Released, the worker
    // reads the task as OPEN - the re-keep has not committed - and decides.
    const holder = await holdLock((tx) => outbox.lockSupplementaryInvoiceAnchor(tx, MODIFICATION_ID));
    const paid: unknown[] = [];
    let workerOutcome: PromiseSettledResult<string | null> | undefined;
    let keepOutcome: PromiseSettledResult<Awaited<ReturnType<typeof dismiss>>> | undefined;
    try {
      const work = worker
        .recordAdditionalCaptureReceipt(
          { syncOperation: claimed! },
          {
            getAuthenticatedXeroClient: async () => {
              throw new Error("no Xero call for a capture no longer kept");
            },
            callXeroApi: ((call: () => Promise<unknown>) => call()) as never,
            createXeroPaymentForInvoice: async (input) => {
              paid.push(input);
              return "xero_payment_unreachable";
            },
            readStripeCaptureDocumentDate: async () => "2026-06-20",
          },
        )
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
      expect(await untilQueuedBehind(holder.pid, 1)).toBe(1);
      const reKeep = dismiss().then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      expect(await untilQueuedBehind(holder.pid, 2)).toBe(2);
      holder.release();
      await holder.done;
      [workerOutcome, keepOutcome] = await Promise.all([work, reKeep]);
    } finally {
      holder.release();
      await holder.done.catch(() => undefined);
    }

    expect(workerOutcome).toEqual({ status: "fulfilled", value: null });
    expect(paid).toEqual([]);
    const rows = await receiptRows();
    const live = rows.filter((candidate) => candidate.status !== "CANCELLED");
    // INV-PAY-144: the re-kept capture has one live recorder - a fresh receipt,
    // never the row the worker closed.
    expect(rows.find((candidate) => candidate.id === row!.id)).toMatchObject({ status: "CANCELLED" });
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe(row!.id);
    expect(keepOutcome).toEqual({ status: "fulfilled", value: { kind: "receipt-queued", queueOperationId: live[0]!.id } });
  });

  it("MUTATION item 11: the keep's kept-capture invoice for a withdrawn change, then the repair tool's supplementary enqueue: no second invoice", { timeout: 30_000 }, async () => {
    await seed("OPEN", { marked: false });
    const withdrawnAsk = await outbox.enqueueXeroSupplementaryInvoiceOperation(
      { bookingId: BOOKING_ID, bookingModificationId: MODIFICATION_ID, priceDiffCents: 8_000, changeFeeCents: 0 },
      { paymentIntentId: "pi_race_4324_superseded", waitForConfirmedAdditionalPayment: true },
    );
    await prisma.xeroSyncOperation.updateMany({
      where: { id: withdrawnAsk.queueOperationId!, status: "WAITING_PAYMENT" },
      data: { status: "CANCELLED", completedAt: new Date(), lastErrorCode: withdraw.ADDITIONAL_ASK_WITHDRAWN_XERO_ERROR_CODE },
    });
    await expect(dismiss()).resolves.toMatchObject({ kind: "kept-invoice-queued" });

    const reRaise = await outbox.enqueueXeroSupplementaryInvoiceOperation({
      bookingId: BOOKING_ID,
      bookingModificationId: MODIFICATION_ID,
      priceDiffCents: 8_000,
      changeFeeCents: 0,
    });
    expect(reRaise).toMatchObject({ queueOperationId: null, outcome: "none" });
    // INV-PAY-144: the kept-capture invoice bills and records the $80; nothing else does.
    expect((await supplementaryRows()).filter((row) => row.status !== "CANCELLED")).toEqual([]);
    expect(
      await prisma.xeroSyncOperation.count({
        where: { localModel: "ManualRefundTask", localId: TASK_ID, queueType: "KEPT_LATE_CAPTURE_INVOICE", status: { not: "CANCELLED" } },
      }),
    ).toBe(1);
  });

  it("MUTATION review CONC-1: the repair tool's supplementary invoice for the change ahead of a paid-another-way close on the change's anchor - the close plans after it, so no kept-capture invoice is raised beside it", { timeout: 30_000 }, async () => {
    // The treasurer approved refunding the $80 (task COMPLETED), Stripe gave up
    // on the refund, and the change's own ask was withdrawn: on its own the
    // close would queue the kept-capture invoice as the capture's receipt.
    await seed("COMPLETED", { marked: false });
    const withdrawnAsk = await outbox.enqueueXeroSupplementaryInvoiceOperation(
      { bookingId: BOOKING_ID, bookingModificationId: MODIFICATION_ID, priceDiffCents: 8_000, changeFeeCents: 0 },
      { paymentIntentId: "pi_race_4324_superseded", waitForConfirmedAdditionalPayment: true },
    );
    await prisma.xeroSyncOperation.updateMany({
      where: { id: withdrawnAsk.queueOperationId!, status: "WAITING_PAYMENT" },
      data: { status: "CANCELLED", completedAt: new Date(), lastErrorCode: withdraw.ADDITIONAL_ASK_WITHDRAWN_XERO_ERROR_CODE },
    });
    await prisma.paymentRecoveryOperation.create({
      data: {
        id: REFUND_OPERATION_ID,
        type: "REFUND_BOOKING_MODIFICATION",
        status: "FAILED",
        bookingId: BOOKING_ID,
        paymentId: PAYMENT_ID,
        paymentIntentId: CHANGE_INTENT,
        amountCents: 8_000,
        allocationPlan: [{ paymentTransactionId: CHANGE_TX_ID, amountCents: 8_000 }],
        idempotencyKey: `late_capture_approval_refund_recovery_${CHANGE_INTENT}`,
        attempts: 5,
        nextRetryAt: null,
      },
    });

    // The repair tool's invoice for the change (naming the capture, as its
    // action can) queues first on the change's anchor; the close starts once it
    // is queued there. Under the lock the close's plan waits on that anchor too;
    // without it the close plans at once and waits only to queue.
    const holder = await holdLock((tx) => outbox.lockSupplementaryInvoiceAnchor(tx, MODIFICATION_ID));
    let closeOutcome: PromiseSettledResult<Awaited<ReturnType<typeof paidAnotherWay.closeCardRefundPaidAnotherWay>>> | undefined;
    let invoiceOutcome: PromiseSettledResult<unknown> | undefined;
    try {
      const invoice = outbox
        .enqueueXeroSupplementaryInvoiceOperation(
          { bookingId: BOOKING_ID, bookingModificationId: MODIFICATION_ID, priceDiffCents: 8_000, changeFeeCents: 0 },
          { paymentIntentId: CHANGE_INTENT },
        )
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
      expect(await untilQueuedBehind(holder.pid, 1)).toBe(1);
      const closing = paidAnotherWay
        .closeCardRefundPaidAnotherWay({
          operationId: REFUND_OPERATION_ID,
          amountCents: 8_000,
          paidBack: "full",
          expectedOwedCents: 8_000,
          note: "Bank transfer, ref RACE-4324",
          actingMemberId: OWNER_ID,
        })
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
      expect(await untilQueuedBehind(holder.pid, 2)).toBe(2);
      holder.release();
      await holder.done;
      [closeOutcome, invoiceOutcome] = await Promise.all([closing, invoice]);
    } finally {
      holder.release();
      await holder.done.catch(() => undefined);
    }

    expect(invoiceOutcome?.status).toBe("fulfilled");
    expect(closeOutcome).toMatchObject({ status: "fulfilled", value: { xeroQueued: "refund-note-after-receipt" } });
    const invoices = (await supplementaryRows()).filter((row) => row.status !== "CANCELLED");
    expect(invoices).toHaveLength(1);
    expect((invoices[0]!.requestPayload as { recordPayment?: boolean }).recordPayment).toBe(true);
    // INV-PAY-144 / INV-PAY-139: one recorder - the change's invoice; no kept-capture invoice beside it.
    expect(
      await prisma.xeroSyncOperation.count({
        where: { localModel: "ManualRefundTask", localId: TASK_ID, queueType: "KEPT_LATE_CAPTURE_INVOICE", status: { not: "CANCELLED" } },
      }),
    ).toBe(0);
  });

  it("an approval with the receipt still undecided withdraws it", async () => {
    await seed("OPEN");
    await dismiss();
    await prisma.$transaction(async (tx) => {
      await tx.manualRefundTask.update({ where: { id: TASK_ID }, data: { status: "COMPLETED" } });
      await kept.settleKeptLateCaptureRecordOnApproval({ manualRefundTaskId: TASK_ID, paymentIntentId: CHANGE_INTENT, store: tx });
    });
    expect(await receiptRows()).toEqual([
      expect.objectContaining({ status: "CANCELLED", lastErrorCode: "KEPT_LATE_CAPTURE_WITHDRAWN" }),
    ]);
  });

  /**
   * 4384-R2 (Codex re-review, `INV-PAY-144`): two marked +$80 edits raced a
   * $220 primary invoice built before either, so its $160 gap invoice bills
   * both, anchored on the newer. The primary's link is saved (its figures
   * stored on its create row) and its gap check has not run yet. The kept
   * capture pays for the OLDER edit - the gap's second anchor.
   */
  describe("4384-R2: a kept capture on the gap's second anchor, and the gap check", () => {
    const figures = {
      xeroInvoiceId: INVOICE_ID,
      billedChangeFeeCents: 0,
      billedTotalCents: 22_000,
      recordedChangeFeeCentsAtLink: 0,
      primaryInvoiceCashCents: 22_000,
      worth: { atBuildCents: 22_000, builtTotalCents: 22_000, atLinkCents: 38_000, markedModificationIdsAtBuild: [] },
      paymentIntentIdsRecordedAtLink: [PRIMARY_INTENT],
    };
    let createId = "";
    beforeEach(async () => {
      await seed("OPEN");
      const older = await prisma.bookingModification.findUniqueOrThrow({ where: { id: MODIFICATION_ID }, select: { createdAt: true } });
      await prisma.bookingModification.create({
        data: {
          id: FIRST_ANCHOR_ID,
          bookingId: BOOKING_ID,
          memberId: OWNER_ID,
          modificationType: "GUEST_ADD",
          previousData: {},
          newData: { primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } },
          priceDiffCents: 8_000,
          // Newer than the capture's change, so the gap anchors on it first (newest first).
          createdAt: new Date(older.createdAt.getTime() + 60_000),
        },
      });
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
      createId = create.id;
    });
    const runGapCheck = () => gapCheck.queuePrimaryInvoiceWorthGap({ bookingId: BOOKING_ID, atLink: figures, figuresOperationId: createId });
    const gapRows = () =>
      prisma.xeroSyncOperation.findMany({
        where: { localModel: "BookingModification", localId: FIRST_ANCHOR_ID, queueType: "SUPPLEMENTARY_INVOICE" },
        select: { id: true, status: true, requestPayload: true },
      });
    const keptRows = () =>
      prisma.xeroSyncOperation.findMany({
        where: { localModel: "ManualRefundTask", localId: TASK_ID, queueType: "KEPT_LATE_CAPTURE_INVOICE", status: { not: "CANCELLED" } },
        select: { id: true, requestPayload: true },
      });
    const reviewRows = () =>
      prisma.xeroSyncOperation.findMany({ where: { localModel: "Booking", localId: BOOKING_ID }, select: { id: true } });

    it("MUTATION: the keep holds the second anchor with its kept invoice undecided - the gap check queues behind it, then is refused, and the treasurer's task names the change", { timeout: 30_000 }, async () => {
      const holder = await holdLock(async (tx) => {
        await tx.manualRefundTask.updateMany({ where: { id: TASK_ID, status: "OPEN" }, data: { status: "DISMISSED", completedAt: new Date(), note: "kept (race proof)" } });
        const plan = await keep.planKeptLateCaptureXeroRecord({
          manualRefundTaskId: TASK_ID,
          bookingId: BOOKING_ID,
          paymentIntentId: CHANGE_INTENT,
          clubZone: ZONE as never,
          store: tx,
        });
        // No gap invoice yet, and the primary missed the change: billed nowhere.
        expect(plan).toMatchObject({ kind: "kept-invoice-queued" });
      });
      const gap = runGapCheck();
      let queuedBehind = 0;
      try {
        // The gap check bills this change too, so it waits on the change's key.
        queuedBehind = await untilQueuedBehind(holder.pid);
      } finally {
        holder.release();
        await holder.done;
      }
      const result = await gap;
      expect(queuedBehind).toBe(1);

      expect(result).toMatchObject({ gapCents: 16_000, queueOperationId: null });
      expect(result.reviewOperationId).toBeTruthy();
      // One document bills the kept $80 - the kept-capture invoice, for exactly 8000 - and no gap invoice on either anchor.
      const keptInvoices = await keptRows();
      expect(keptInvoices).toHaveLength(1);
      expect(keptInvoices[0]!.requestPayload).toMatchObject({ paymentIntentId: CHANGE_INTENT, capturedCents: 8_000 });
      expect(await gapRows()).toEqual([]);
      expect(await supplementaryRows()).toEqual([]);
      expect(await receiptRows()).toEqual([]);
      const review = await prisma.xeroSyncOperation.findUnique({ where: { id: result.reviewOperationId! }, select: { requestPayload: true } });
      expect(JSON.stringify(review?.requestPayload)).toContain(MODIFICATION_ID);

      // Retries: the gap check replayed (the create's replay) is refused again on one deduplicated task; the keep's repair replay finds its kept invoice.
      const again = await runGapCheck();
      expect(again).toMatchObject({ queueOperationId: null, reviewOperationId: result.reviewOperationId });
      await expect(repairRecord()).resolves.toMatchObject({ kind: "kept-invoice-queued", queueOperationId: keptInvoices[0]!.id });
      expect(await keptRows()).toHaveLength(1);
      expect(await gapRows()).toEqual([]);
      expect(await reviewRows()).toHaveLength(1);
    });

    it("the reverse order: the gap invoice is queued first, so the keep finds it billing the change and records the capture's receipt on it - no kept invoice", { timeout: 30_000 }, async () => {
      const result = await runGapCheck();
      expect(result).toMatchObject({ gapCents: 16_000 });
      // The gap invoice bills both racing edits' 160.00, on the first anchor; nothing on the capture's own change.
      const gaps = await gapRows();
      expect(gaps).toHaveLength(1);
      expect(gaps[0]!.requestPayload).toMatchObject({ primaryInvoiceGap: true, priceDiffCents: 16_000, changeFeeCents: 0, bookingModificationId: FIRST_ANCHOR_ID });
      expect(await supplementaryRows()).toEqual([]);

      const plan = await dismiss();
      expect(plan).toMatchObject({ kind: "receipt-queued" });
      expect(await keptRows()).toEqual([]);
      const receipts = await receiptRows();
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.requestPayload).toMatchObject({ paymentIntentId: CHANGE_INTENT });

      // Retries: the gap check replayed finds its own invoice; the keep's repair replay finds the receipt. Still one of each.
      await expect(runGapCheck()).resolves.toMatchObject({ gapCents: 16_000 });
      await expect(repairRecord()).resolves.toMatchObject({ kind: "receipt-queued", queueOperationId: receipts[0]!.id });
      expect(await gapRows()).toHaveLength(1);
      expect(await receiptRows()).toHaveLength(1);
      expect(await keptRows()).toEqual([]);
    });
  });
});
