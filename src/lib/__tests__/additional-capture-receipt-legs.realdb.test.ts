/**
 * #4434 (`INV-PAY-139`): a receipt whose stored plan splits the capture
 * across two invoices, sent and retried leg by leg. Real database writes, the
 * worker and the officer's Retry; only Xero is replaced by the provider seam,
 * which writes each payment's link as the real create does. No live provider
 * is called.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const OWNER = "race-4434-owner";
const LODGE = "race-4434-lodge";
const BOOKING = "race-4434-booking";
const PAYMENT = "race-4434-payment";
const CAPTURE = "race-4434-capture";
const INTENT = "pi_race_4434_capture";
const PRIMARY = "race-4434-primary-invoice";
const CHANGE = "race-4434-change-invoice";
const SWEEP_ASK = "race-4434-sweep-ask";
const SWEEP_PAYMENT = "race-4434-sweep-payment";
const CHANGE_CENTS = 5_000;
const PRIMARY_CENTS = 3_000;
const CAPTURED_CENTS = CHANGE_CENTS + PRIMARY_CENTS;
let prisma: PrismaClient;
let worker: typeof import("@/lib/additional-capture-xero-receipt");
let claim: typeof import("@/lib/xero-operation-claim");
let retry: typeof import("@/lib/xero-operation-retry");
let sweep: typeof import("@/lib/credit-release-xero-payment");
let receipt: typeof import("@/lib/additional-capture-receipt-link");

type XeroPayment = { paymentID: string; reference: string; amount: number; status: string };
type Invoices = Record<string, { amountDueCents: number; payments: XeroPayment[] }>;

async function clean() {
  await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [CAPTURE, SWEEP_ASK] } } });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: CAPTURE } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT } });
  await prisma.booking.deleteMany({ where: { id: BOOKING } });
  await prisma.lodge.deleteMany({ where: { id: LODGE } });
  await prisma.member.deleteMany({ where: { id: OWNER } });
}

async function seed() {
  await prisma.member.create({ data: {
    id: OWNER, email: `${OWNER}@example.invalid`, passwordHash: "not-a-real-password",
    firstName: "Receipt", lastName: "Legs", ageTier: "ADULT", canLogin: true,
  } });
  await prisma.lodge.create({ data: { id: LODGE, name: "Receipt Legs Proof", slug: "race-4434" } });
  await prisma.booking.create({ data: {
    id: BOOKING, memberId: OWNER, lodgeId: LODGE, status: "CONFIRMED",
    checkIn: new Date("2026-09-10T00:00:00.000Z"), checkOut: new Date("2026-09-12T00:00:00.000Z"),
    totalPriceCents: 38_000, finalPriceCents: 38_000,
  } });
  await prisma.payment.create({ data: {
    id: PAYMENT, bookingId: BOOKING, source: "STRIPE", status: "SUCCEEDED",
    amountCents: 38_000, creditAppliedCents: 0, xeroInvoiceId: PRIMARY,
  } });
  await prisma.paymentTransaction.create({ data: {
    id: CAPTURE, paymentId: PAYMENT, kind: "ADDITIONAL", source: "STRIPE",
    status: "SUCCEEDED", amountCents: CAPTURED_CENTS, stripePaymentIntentId: INTENT,
  } });
}

/** A stored two-leg decision with nothing sent yet: the change's invoice first, then the primary. */
async function queueTwoLegReceipt() {
  const key = worker.additionalCaptureReceiptKey(INTENT);
  return prisma.xeroSyncOperation.create({ data: {
    direction: "OUTBOUND", entityType: "PAYMENT", operationType: "CREATE",
    localModel: "PaymentTransaction", localId: CAPTURE, status: "PENDING",
    queueType: "ADDITIONAL_CAPTURE_RECEIPT", correlationKey: key, idempotencyKey: key,
    requestPayload: {
      queueType: "ADDITIONAL_CAPTURE_RECEIPT", bookingId: BOOKING, paymentId: PAYMENT,
      paymentTransactionId: CAPTURE, paymentIntentId: INTENT,
      plan: {
        target: "CHANGE_INVOICE", invoiceId: CHANGE, amountCents: CHANGE_CENTS,
        capturedCents: CAPTURED_CENTS, date: "2026-06-30",
        legs: [
          { target: "CHANGE_INVOICE", invoiceId: CHANGE, amountCents: CHANGE_CENTS },
          { target: "PRIMARY_INVOICE", invoiceId: PRIMARY, amountCents: PRIMARY_CENTS },
        ],
        targetInvoiceIds: [CHANGE, PRIMARY],
      },
    },
  } });
}

async function claimRow(id: string) {
  const claimed = await claim.claimXeroSyncOperationToRunning(id, {
    direction: "OUTBOUND", entityType: "PAYMENT", operationType: "CREATE",
    localModel: { in: ["PaymentTransaction"] },
  });
  if (!claimed) throw new Error("Receipt legs proof could not claim its operation");
  return claimed;
}

/**
 * Xero, faked. `failures` says, per invoice, how its next create goes wrong:
 * `refused` never reaches Xero; `lost` lands in Xero but its response is lost.
 * A create that succeeds writes its link, as `createXeroPaymentForInvoice` does.
 */
function fakeXero(invoices: Invoices, failures: Record<string, "refused" | "lost"> = {}) {
  let next = 0;
  const createPayment = vi.fn(async (params: {
    invoiceId: string; amountCents: number; reference: string; role: string;
    localId: string; metadata?: Record<string, unknown>;
  }) => {
    const failure = failures[params.invoiceId];
    delete failures[params.invoiceId];
    if (failure === "refused") throw new Error(`Xero refused the payment on ${params.invoiceId}`);
    const paymentID = `race-4434-payment-${++next}`;
    const invoice = invoices[params.invoiceId];
    if (!invoice) throw new Error(`No fake invoice ${params.invoiceId}`);
    invoice.amountDueCents -= params.amountCents;
    invoice.payments.push({ paymentID, reference: params.reference, amount: params.amountCents / 100, status: "AUTHORISED" });
    if (failure === "lost") throw new Error(`The response for the payment on ${params.invoiceId} was lost`);
    await prisma.xeroObjectLink.create({ data: {
      localModel: "PaymentTransaction", localId: params.localId, xeroObjectType: "PAYMENT",
      // The real helper takes `Record<string, unknown>`; Prisma's JSON input wants its own type.
      xeroObjectId: paymentID, role: params.role, active: true, metadata: (params.metadata ?? {}) as Prisma.InputJsonObject,
    } });
    return paymentID;
  });
  const providers: import("@/lib/additional-capture-xero-receipt").AdditionalCaptureReceiptProviders = {
    getAuthenticatedXeroClient: vi.fn().mockResolvedValue({
      tenantId: "race-4434-tenant",
      xero: { accountingApi: { getInvoice: async (_tenant: string, invoiceId: string) => {
        const invoice = invoices[invoiceId];
        return { body: { invoices: invoice ? [{
          invoiceID: invoiceId, status: "AUTHORISED", amountDue: invoice.amountDueCents / 100,
          payments: invoice.payments.map((payment) => ({ ...payment })),
        }] : [] } };
      } } },
    }),
    callXeroApi: (async (call: () => Promise<unknown>) => call()) as never,
    createXeroPaymentForInvoice: createPayment as never,
    readStripeCaptureDocumentDate: async () => null,
  };
  return { providers, createPayment };
}

function receiptLinks() {
  return prisma.xeroObjectLink.findMany({
    where: { localId: CAPTURE, role: receipt.ADDITIONAL_CAPTURE_PAYMENT_ROLE, active: true },
    orderBy: { createdAt: "asc" },
    select: { xeroObjectId: true, metadata: true },
  });
}

/** The worker failed the row; the officer's Retry puts it back, and the next run claims it. */
async function officerRetries(id: string) {
  expect(await prisma.xeroSyncOperation.findUnique({ where: { id } })).toMatchObject({ status: "FAILED" });
  await retry.retryXeroSyncOperation(id, CLUB_FORMAT_TEST);
  return claimRow(id);
}

(RUN ? describe : describe.skip)("a receipt split across two invoices, retried on PostgreSQL (#4434)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Receipt legs");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    worker = await import("@/lib/additional-capture-xero-receipt");
    claim = await import("@/lib/xero-operation-claim");
    retry = await import("@/lib/xero-operation-retry");
    sweep = await import("@/lib/credit-release-xero-payment");
    receipt = await import("@/lib/additional-capture-receipt-link");
    await clean();
  }, 120_000);

  beforeEach(async () => {
    await clean();
    await seed();
  });

  afterAll(async () => {
    if (prisma) await clean();
  });

  it("the second leg refused: the Retry sends only the second leg, and a refund names the first leg's invoice", async () => {
    const invoices: Invoices = { [CHANGE]: { amountDueCents: CHANGE_CENTS, payments: [] }, [PRIMARY]: { amountDueCents: 10_000, payments: [] } };
    const xero = fakeXero(invoices, { [PRIMARY]: "refused" });
    const operation = await queueTwoLegReceipt();

    await expect(worker.recordAdditionalCaptureReceipt({ syncOperation: await claimRow(operation.id) }, xero.providers)).rejects.toThrow(/refused/);
    expect(await receiptLinks()).toEqual([expect.objectContaining({ xeroObjectId: "race-4434-payment-1", metadata: expect.objectContaining({ invoiceId: CHANGE }) })]);
    // While the row waits, the refund paths read the first leg too.
    expect(await receipt.findAdditionalCaptureReceiptInvoiceId(INTENT)).toBe(CHANGE);

    await expect(worker.recordAdditionalCaptureReceipt({ syncOperation: await officerRetries(operation.id) }, xero.providers)).resolves.toBe("race-4434-payment-1");

    expect(xero.createPayment.mock.calls.map(([call]) => [call.invoiceId, call.amountCents])).toEqual([
      [CHANGE, CHANGE_CENTS], [PRIMARY, PRIMARY_CENTS], [PRIMARY, PRIMARY_CENTS],
    ]);
    expect(xero.createPayment.mock.calls.at(-1)?.[0]).toMatchObject({ idempotencyKey: worker.additionalCapturePaymentKey(INTENT, PRIMARY) });
    expect(invoices[CHANGE].payments).toHaveLength(1);
    expect(invoices[PRIMARY].payments).toHaveLength(1);
    expect(await prisma.xeroSyncOperation.findUnique({ where: { id: operation.id } })).toMatchObject({
      status: "SUCCEEDED", xeroObjectId: "race-4434-payment-1",
      responsePayload: expect.objectContaining({ paymentIds: ["race-4434-payment-1", "race-4434-payment-2"], unrecordedCents: 0 }),
    });
    expect((await receiptLinks()).map((link) => link.xeroObjectId)).toEqual(["race-4434-payment-1", "race-4434-payment-2"]);
    expect(await receipt.findAdditionalCaptureReceiptInvoiceId(INTENT)).toBe(CHANGE);
  });

  it("the second leg's response lost: the Retry adopts its payment by reference and amount and sends nothing new", async () => {
    const invoices: Invoices = { [CHANGE]: { amountDueCents: CHANGE_CENTS, payments: [] }, [PRIMARY]: { amountDueCents: 10_000, payments: [] } };
    const xero = fakeXero(invoices, { [PRIMARY]: "lost" });
    const operation = await queueTwoLegReceipt();

    await expect(worker.recordAdditionalCaptureReceipt({ syncOperation: await claimRow(operation.id) }, xero.providers)).rejects.toThrow(/lost/);
    await expect(worker.recordAdditionalCaptureReceipt({ syncOperation: await officerRetries(operation.id) }, xero.providers)).resolves.toBe("race-4434-payment-1");

    expect(xero.createPayment).toHaveBeenCalledTimes(2);
    expect(invoices[PRIMARY].payments).toHaveLength(1);
    expect(await prisma.xeroSyncOperation.findUnique({ where: { id: operation.id } })).toMatchObject({
      status: "SUCCEEDED",
      responsePayload: expect.objectContaining({ paymentIds: ["race-4434-payment-1", "race-4434-payment-2"], recoveredExisting: true }),
    });
  });

  it("the first leg's response lost: the Retry adopts it, sends the second, and a refund still names the first leg's invoice", async () => {
    const invoices: Invoices = { [CHANGE]: { amountDueCents: CHANGE_CENTS, payments: [] }, [PRIMARY]: { amountDueCents: 10_000, payments: [] } };
    const xero = fakeXero(invoices, { [CHANGE]: "lost" });
    const operation = await queueTwoLegReceipt();

    await expect(worker.recordAdditionalCaptureReceipt({ syncOperation: await claimRow(operation.id) }, xero.providers)).rejects.toThrow(/lost/);
    expect(await receiptLinks()).toEqual([]);
    await expect(worker.recordAdditionalCaptureReceipt({ syncOperation: await officerRetries(operation.id) }, xero.providers)).resolves.toBe("race-4434-payment-1");

    expect(xero.createPayment.mock.calls.map(([call]) => call.invoiceId)).toEqual([CHANGE, PRIMARY]);
    expect(invoices[CHANGE].payments).toHaveLength(1);
    // The adopted first leg is linked before the second leg's create writes its own.
    expect((await receiptLinks()).map((link) => link.xeroObjectId)).toEqual(["race-4434-payment-1", "race-4434-payment-2"]);
    expect(await receipt.findAdditionalCaptureReceiptInvoiceId(INTENT)).toBe(CHANGE);
  });

  it("a later leg never adopts the credit-release sweep's payment of the same reference and amount", async () => {
    const reference = worker.additionalCapturePaymentReference(INTENT);
    const invoices: Invoices = {
      [CHANGE]: { amountDueCents: CHANGE_CENTS, payments: [] },
      [PRIMARY]: { amountDueCents: 10_000, payments: [{ paymentID: SWEEP_PAYMENT, reference, amount: PRIMARY_CENTS / 100, status: "AUTHORISED" }] },
    };
    await prisma.xeroObjectLink.create({ data: {
      localModel: "PaymentTransaction", localId: SWEEP_ASK, xeroObjectType: "PAYMENT",
      xeroObjectId: SWEEP_PAYMENT, role: sweep.CREDIT_RELEASE_PAYMENT_ROLE, active: true,
    } });
    const xero = fakeXero(invoices);
    const operation = await queueTwoLegReceipt();

    await expect(worker.recordAdditionalCaptureReceipt({ syncOperation: await claimRow(operation.id) }, xero.providers)).resolves.toBe("race-4434-payment-1");

    expect(xero.createPayment.mock.calls.map(([call]) => [call.invoiceId, call.amountCents])).toEqual([[CHANGE, CHANGE_CENTS], [PRIMARY, PRIMARY_CENTS]]);
    expect(await prisma.xeroSyncOperation.findUnique({ where: { id: operation.id } })).toMatchObject({
      status: "SUCCEEDED",
      responsePayload: expect.objectContaining({ paymentIds: ["race-4434-payment-1", "race-4434-payment-2"], recoveredExisting: false }),
    });
    expect(await prisma.xeroObjectLink.count({
      where: { localId: CAPTURE, role: receipt.ADDITIONAL_CAPTURE_PAYMENT_ROLE, xeroObjectId: SWEEP_PAYMENT },
    })).toBe(0);
  });
});
