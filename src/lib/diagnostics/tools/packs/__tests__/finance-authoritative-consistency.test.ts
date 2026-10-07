/**
 * AID-6C: does the diagnostic AGREE with the screen? (#2377)
 *
 * #2377's "Authoritative consistency" requirement is a claim about two pieces of
 * code saying the same thing — "diagnostic state matches the application's payment
 * and reconciliation logic", "Xero linkage results match the application" — and
 * every other test in this pack asserts the diagnostic against HAND-WRITTEN
 * expectations. A hand-written expectation cannot notice that the screen moved,
 * and it cannot notice that the diagnostic was reading a different column all
 * along. Both of those happened:
 *
 *  - `invoiceLinked` read `Payment."xeroInvoiceId"` alone, where the screen ORs it
 *    with an active `PRIMARY_INVOICE` `XeroObjectLink`. A booking that HAS an
 *    invoice was reported as having none, and the operator's next move from
 *    "invoice missing" is to raise a second one.
 *  - `invoiceExpected` used the booking's lifecycle where the screen uses the
 *    payment's status, and the operation scope was `Booking` + `Payment` where the
 *    screen keys `Payment:{id}`.
 *
 * SO THIS SUITE RUNS BOTH. It drives `listAdminPayments` — the real Admin >
 * Payments service, not a reimplementation of it — and
 * `readBookingFinanceStateEvidence` over the SAME fixture rows through one Prisma
 * mock, and asserts the two agree on `xeroState` and `settlementKind`. Neither
 * side's expected value is written down here: the assertion is equality between
 * two independent pieces of production code.
 *
 * The Prisma mock serves both callers because they read the same rows by different
 * methods — the screen takes `payment.findMany` twice, the diagnostic takes
 * `booking.findUnique` and `payment.findUnique` — so one fixture describes one
 * real row and both sides see it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ONE SET OF DOUBLES, REACHED TWO WAYS — which is what makes this comparison mean
 * anything (#2786).
 *
 * The whole point of this file is that the diagnostic and `/admin/payments` agree
 * about ONE fixture row. Since #2786 the diagnostic reads inside the shared
 * read-only seam and the admin service still reads on the global client, so the
 * transaction client the seam hands out has to be backed by exactly the same
 * `vi.fn()` instances — otherwise the two sides would be reading two fixtures and
 * an agreement between them would prove nothing. It is a distinct OBJECT (a
 * `Prisma.TransactionClient` is not the global client, and it has no
 * `$transaction`, so a nested transaction throws here) holding identical functions.
 */
// Only `prismaMock` is returned: the transaction client is reached solely through
// the `$transaction` double below, so hoisting a second binding out to module scope
// would be an unused export of a test detail.
const { prismaMock } = vi.hoisted(() => {
  const models = {
    booking: { findUnique: vi.fn() },
    payment: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    memberCredit: { findMany: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(async (): Promise<unknown[]> => []) },
    xeroSyncOperation: { findMany: vi.fn() },
    xeroObjectLink: { findFirst: vi.fn(), findMany: vi.fn() },
    paymentRecoveryOperation: { findMany: vi.fn() },
    manualRefundTask: { count: vi.fn(), findMany: vi.fn(async (): Promise<unknown[]> => []) },
    refundRequest: { count: vi.fn() },
  };
  const txMock = { ...models, $executeRaw: vi.fn().mockResolvedValue(0) };
  return {
    prismaMock: {
      ...models,
      $transaction: vi.fn(async (run: (tx: typeof txMock) => Promise<unknown>) =>
        run(txMock),
      ),
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import { adminPaymentsQuerySchema, listAdminPayments } from "@/lib/admin-payments-service";
import { prisma } from "@/lib/prisma";

import { readBookingFinanceStateEvidence } from "../finance-evidence";

const BOOKING_ID = "clzbooking0000000000000001";
const PAYMENT_ID = "clzpayment0000000000000001";
const MEMBER_ID = "clzmember00000000000000001";

interface Fixture {
  bookingStatus: string;
  paymentStatus: string;
  amountCents?: number;
  refundedAmountCents?: number;
  /** The denormalised invoice id on the payment row. */
  xeroInvoiceId?: string | null;
  /** An ACTIVE PRIMARY_INVOICE `XeroObjectLink` for the payment. */
  primaryInvoiceLink?: boolean;
  xeroOperations?: { id: string; status: string; createdAt: Date }[];
  credits?: { amountCents: number; description: string }[];
}

function install(fixture: Fixture): void {
  const payment = {
    id: PAYMENT_ID,
    bookingId: BOOKING_ID,
    status: fixture.paymentStatus,
    source: "STRIPE",
    amountCents: fixture.amountCents ?? 10_000,
    refundedAmountCents: fixture.refundedAmountCents ?? 0,
    creditAppliedCents: 0,
    changeFeeCents: 0,
    additionalAmountCents: 0,
    additionalPaymentStatus: null,
    xeroInvoiceId: fixture.xeroInvoiceId ?? null,
    xeroInvoiceNumber: null,
    reference: null,
    manuallyMarkedPaidAt: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-02T00:00:00Z"),
    stripePaymentIntentId: null,
    // The screen's candidate query selects these two to work out when the payment
    // last moved; empty is a payment with no attempts and no refund rows.
    transactions: [] as { updatedAt: Date }[],
    refunds: [] as { updatedAt: Date }[],
    booking: {
      id: BOOKING_ID,
      status: fixture.bookingStatus,
      checkIn: new Date("2026-08-10T00:00:00Z"),
      checkOut: new Date("2026-08-12T00:00:00Z"),
      creditsFromCancellation: fixture.credits ?? [],
      member: {
        id: MEMBER_ID,
        firstName: "Fixture",
        lastName: "Member",
        email: "fixture@example.test",
      },
    },
  };

  const operations = (fixture.xeroOperations ?? []).map((operation) => ({
    ...operation,
    localModel: "Payment",
    localId: PAYMENT_ID,
  }));

  // ---- what the SCREEN reads -------------------------------------------
  vi.mocked(prisma.payment.findMany).mockResolvedValue([payment] as never);
  vi.mocked(prisma.xeroSyncOperation.findMany).mockResolvedValue(
    operations as never,
  );
  vi.mocked(prisma.xeroObjectLink.findMany).mockResolvedValue(
    (fixture.primaryInvoiceLink ? [{ localId: PAYMENT_ID }] : []) as never,
  );

  // ---- what the DIAGNOSTIC reads ---------------------------------------
  vi.mocked(prisma.booking.findUnique).mockResolvedValue({
    id: BOOKING_ID,
    memberId: MEMBER_ID,
    status: fixture.bookingStatus,
    finalPriceCents: payment.amountCents,
  } as never);
  vi.mocked(prisma.payment.findUnique).mockResolvedValue(payment as never);
  vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue(
    (fixture.primaryInvoiceLink ? { id: "link-1" } : null) as never,
  );
  vi.mocked(prisma.memberCredit.findMany).mockResolvedValue(
    (fixture.credits ?? []).map((credit) => ({
      ...credit,
      type: "CANCELLATION_REFUND",
    })) as never,
  );
  vi.mocked(prisma.memberCredit.aggregate).mockResolvedValue({
    _sum: { amountCents: 0 },
  } as never);
  vi.mocked(prisma.paymentRecoveryOperation.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.manualRefundTask.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.refundRequest.count).mockResolvedValue(0 as never);
}

/** What Admin > Payments itself says about the fixture row. */
async function screenRow(): Promise<Record<string, unknown>> {
  const result = await listAdminPayments(adminPaymentsQuerySchema.parse({}));
  const body = result.body as { data?: Record<string, unknown>[] };
  expect(body.data, "the admin payments service returned no row").toHaveLength(
    1,
  );
  return body.data![0]!;
}

/** What the diagnostic says about the same row. */
async function diagnosticRow(): Promise<Record<string, unknown>> {
  const rows = await readBookingFinanceStateEvidence({ bookingId: BOOKING_ID });
  expect(rows).toHaveLength(1);
  return rows[0] as unknown as Record<string, unknown>;
}

const OPERATION_AT = new Date("2026-08-03T00:00:00Z");

/**
 * The shapes that decide a Xero classification, each one a state an operator
 * really meets. `linkOnly` is the one that mattered: it is this platform's own
 * `XERO_LINK_MISMATCH`, which it names, detects and ships an auto-applicable
 * backfill for — so it is reachable in production, not a theoretical row.
 */
const FIXTURES: [string, Fixture][] = [
  [
    "paid with the invoice id stored on the payment",
    { bookingStatus: "CONFIRMED", paymentStatus: "SUCCEEDED", xeroInvoiceId: "inv-1" },
  ],
  [
    "paid with the LINK only and no invoice id on the payment (XERO_LINK_MISMATCH)",
    {
      bookingStatus: "CONFIRMED",
      paymentStatus: "SUCCEEDED",
      xeroInvoiceId: null,
      primaryInvoiceLink: true,
    },
  ],
  [
    "paid with neither the id nor the link",
    { bookingStatus: "CONFIRMED", paymentStatus: "SUCCEEDED", xeroInvoiceId: null },
  ],
  [
    "unpaid, so the screen expects no invoice yet",
    { bookingStatus: "PAYMENT_PENDING", paymentStatus: "PENDING", xeroInvoiceId: null },
  ],
  [
    "a failed Xero sync outranks everything else",
    {
      bookingStatus: "CONFIRMED",
      paymentStatus: "SUCCEEDED",
      xeroInvoiceId: "inv-1",
      xeroOperations: [{ id: "op-1", status: "FAILED", createdAt: OPERATION_AT }],
    },
  ],
  [
    "a partial Xero sync",
    {
      bookingStatus: "CONFIRMED",
      paymentStatus: "SUCCEEDED",
      xeroInvoiceId: null,
      xeroOperations: [{ id: "op-1", status: "PARTIAL", createdAt: OPERATION_AT }],
    },
  ],
  [
    "a queued Xero sync",
    {
      bookingStatus: "CONFIRMED",
      paymentStatus: "SUCCEEDED",
      xeroInvoiceId: null,
      xeroOperations: [
        { id: "op-1", status: "WAITING_PAYMENT", createdAt: OPERATION_AT },
      ],
    },
  ],
  [
    "cancelled and refunded to the card",
    {
      bookingStatus: "CANCELLED",
      paymentStatus: "REFUNDED",
      refundedAmountCents: 10_000,
      xeroInvoiceId: "inv-1",
    },
  ],
  [
    "cancelled and settled as account credit",
    {
      bookingStatus: "CANCELLED",
      paymentStatus: "REFUNDED",
      xeroInvoiceId: "inv-1",
      credits: [
        { amountCents: 10_000, description: "Cancellation refund for booking ABC" },
      ],
    },
  ],
  [
    "cancelled with the card refund and the credit both",
    {
      bookingStatus: "CANCELLED",
      paymentStatus: "PARTIALLY_REFUNDED",
      refundedAmountCents: 4_000,
      xeroInvoiceId: "inv-1",
      credits: [
        { amountCents: 6_000, description: "Cancellation refund for booking ABC" },
      ],
    },
  ],
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AID-6C: the diagnostic and Admin > Payments agree (#2377)", () => {
  it.each(FIXTURES)(
    "reports the same xeroState and settlementKind for a booking %s",
    async (_name, fixture) => {
      install(fixture);
      const screen = await screenRow();
      const diagnostic = await diagnosticRow();

      expect(diagnostic.xero_state).toBe(screen.xeroState);
      expect(diagnostic.settlement_kind).toBe(screen.settlementKind);
    },
  );

  it("agrees that an ACTIVE primary-invoice link IS an invoice", async () => {
    // Named separately from the table above because it is the finding, and because
    // the equality assertion alone would be satisfied by BOTH sides being wrong.
    // This pins the VALUE as well: the screen and the diagnostic must both say the
    // invoice is there, and the diagnostic must raise no missing-invoice blocker.
    install({
      bookingStatus: "CONFIRMED",
      paymentStatus: "SUCCEEDED",
      xeroInvoiceId: null,
      primaryInvoiceLink: true,
    });
    const screen = await screenRow();
    const diagnostic = await diagnosticRow();

    expect(screen.xeroState).toBe("invoiceLinked");
    expect(diagnostic.xero_state).toBe("invoiceLinked");
    expect(String(diagnostic.blocker_codes)).not.toContain(
      "xero_invoice_missing",
    );
  });

  it("agrees that neither the id nor the link means the invoice is missing", async () => {
    install({
      bookingStatus: "CONFIRMED",
      paymentStatus: "SUCCEEDED",
      xeroInvoiceId: null,
    });
    const screen = await screenRow();
    const diagnostic = await diagnosticRow();

    expect(screen.xeroState).toBe("invoiceMissing");
    expect(diagnostic.xero_state).toBe("invoiceMissing");
    expect(String(diagnostic.blocker_codes)).toContain("xero_invoice_missing");
  });
});
