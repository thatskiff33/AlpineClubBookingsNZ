/**
 * #4435: a stored receipt decision survives a crash without adopting the
 * sweep's equal payment on the same invoice. Real database writes and worker;
 * only Xero is replaced by the provider seam. No live provider is called.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const OWNER = "race-4435-owner";
const LODGE = "race-4435-lodge";
const BOOKING = "race-4435-booking";
const PAYMENT = "race-4435-payment";
const CAPTURE = "race-4435-capture";
const INTENT = "pi_race_4435_capture";
const INVOICE = "race-4435-invoice";
const SWEEP_ASK = "race-4435-sweep-ask";
const SWEEP_PAYMENT = "race-4435-sweep-payment";
const RECEIPT_PAYMENT = "race-4435-receipt-payment";
let prisma: PrismaClient;
let worker: typeof import("@/lib/additional-capture-xero-receipt");
let claim: typeof import("@/lib/xero-operation-claim");
let sweep: typeof import("@/lib/credit-release-xero-payment");
let receipt: typeof import("@/lib/additional-capture-receipt-link");

async function clean() {
  await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [CAPTURE, SWEEP_ASK] } } });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: CAPTURE } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT } });
  await prisma.booking.deleteMany({ where: { id: BOOKING } });
  await prisma.lodge.deleteMany({ where: { id: LODGE } });
  await prisma.member.deleteMany({ where: { id: OWNER } });
}

(RUN ? describe : describe.skip)("receipt crash recovery beside a credit-release sweep on PostgreSQL (#4435)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Receipt sweep retry");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    worker = await import("@/lib/additional-capture-xero-receipt");
    claim = await import("@/lib/xero-operation-claim");
    sweep = await import("@/lib/credit-release-xero-payment");
    receipt = await import("@/lib/additional-capture-receipt-link");
    await clean();
  }, 120_000);

  afterAll(async () => {
    if (prisma) await clean();
  });

  it("a receipt retried after a crash sends its own payment beside the sweep's equal payment on the primary invoice", async () => {
    await prisma.member.create({ data: {
      id: OWNER, email: `${OWNER}@example.invalid`, passwordHash: "not-a-real-password",
      firstName: "Receipt", lastName: "Proof", ageTier: "ADULT", canLogin: true,
    } });
    await prisma.lodge.create({ data: { id: LODGE, name: "Receipt Sweep Proof", slug: "race-4435" } });
    await prisma.booking.create({ data: {
      id: BOOKING, memberId: OWNER, lodgeId: LODGE, status: "CONFIRMED",
      checkIn: new Date("2026-09-10T00:00:00.000Z"), checkOut: new Date("2026-09-12T00:00:00.000Z"),
      totalPriceCents: 38_000, finalPriceCents: 38_000,
    } });
    await prisma.payment.create({ data: {
      id: PAYMENT, bookingId: BOOKING, source: "STRIPE", status: "SUCCEEDED",
      amountCents: 38_000, creditAppliedCents: 0, xeroInvoiceId: INVOICE,
    } });
    // No release share/ask: the receipt remains this capture's recorder.
    // The sweep's identity is its link, on a distinct ask, not this capture.
    await prisma.paymentTransaction.create({ data: {
      id: CAPTURE, paymentId: PAYMENT, kind: "ADDITIONAL", source: "STRIPE",
      status: "SUCCEEDED", amountCents: 8_000, stripePaymentIntentId: INTENT,
    } });
    await prisma.xeroObjectLink.create({ data: {
      localModel: "PaymentTransaction", localId: SWEEP_ASK, xeroObjectType: "PAYMENT",
      xeroObjectId: SWEEP_PAYMENT, role: sweep.CREDIT_RELEASE_PAYMENT_ROLE, active: true,
    } });
    // Crash state: a stored decision, with no receipt payment link yet.
    const key = worker.additionalCaptureReceiptKey(INTENT);
    const operation = await prisma.xeroSyncOperation.create({ data: {
      direction: "OUTBOUND", entityType: "PAYMENT", operationType: "CREATE",
      localModel: "PaymentTransaction", localId: CAPTURE, status: "PENDING",
      queueType: "ADDITIONAL_CAPTURE_RECEIPT", correlationKey: key, idempotencyKey: key,
      requestPayload: {
        queueType: "ADDITIONAL_CAPTURE_RECEIPT", bookingId: BOOKING, paymentId: PAYMENT,
        paymentTransactionId: CAPTURE, paymentIntentId: INTENT,
        plan: { target: "PRIMARY_INVOICE", invoiceId: INVOICE, amountCents: 4_000, capturedCents: 8_000, date: "2026-06-30" },
      },
    } });
    const claimed = await claim.claimXeroSyncOperationToRunning(operation.id, {
      direction: "OUTBOUND", entityType: "PAYMENT", operationType: "CREATE",
      localModel: { in: ["PaymentTransaction"] },
    });
    if (!claimed) throw new Error("Receipt proof could not claim its operation");
    const createPayment = vi.fn(async () => RECEIPT_PAYMENT);
    const providers: import("@/lib/additional-capture-xero-receipt").AdditionalCaptureReceiptProviders = {
      getAuthenticatedXeroClient: vi.fn().mockResolvedValue({
        tenantId: "race-4435-tenant",
        xero: { accountingApi: { getInvoice: async () => ({ body: { invoices: [{
          invoiceID: INVOICE, status: "AUTHORISED", amountDue: 40,
          payments: [{ paymentID: SWEEP_PAYMENT, reference: worker.additionalCapturePaymentReference(INTENT), amount: 40, status: "AUTHORISED" }],
        }] } }) } },
      }),
      callXeroApi: (async (call: () => Promise<unknown>) => call()) as never,
      createXeroPaymentForInvoice: createPayment,
      readStripeCaptureDocumentDate: async () => null,
    };

    await expect(worker.recordAdditionalCaptureReceipt({ syncOperation: claimed }, providers)).resolves.toBe(RECEIPT_PAYMENT);

    expect(createPayment).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      amountCents: 4_000, invoiceId: INVOICE, reference: worker.additionalCapturePaymentReference(INTENT),
      role: receipt.ADDITIONAL_CAPTURE_PAYMENT_ROLE,
      idempotencyKey: worker.additionalCapturePaymentKey(INTENT, INVOICE),
    }));
    expect(await prisma.xeroSyncOperation.findUnique({ where: { id: operation.id } })).toMatchObject({
      status: "SUCCEEDED", xeroObjectId: RECEIPT_PAYMENT,
      responsePayload: { paymentId: RECEIPT_PAYMENT, recoveredExisting: false },
    });
    expect(await prisma.xeroObjectLink.findMany({
      where: { localId: { in: [CAPTURE, SWEEP_ASK] }, active: true },
      select: { localId: true, xeroObjectId: true, role: true },
    })).toEqual(expect.arrayContaining([
      { localId: CAPTURE, xeroObjectId: RECEIPT_PAYMENT, role: receipt.ADDITIONAL_CAPTURE_PAYMENT_ROLE },
      { localId: SWEEP_ASK, xeroObjectId: SWEEP_PAYMENT, role: sweep.CREDIT_RELEASE_PAYMENT_ROLE },
    ]));
    expect(await prisma.xeroObjectLink.count({
      where: { localId: CAPTURE, role: receipt.ADDITIONAL_CAPTURE_PAYMENT_ROLE, xeroObjectId: SWEEP_PAYMENT, active: true },
    })).toBe(0);
  });
});
