import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentSource, PaymentStatus } from "@prisma/client";

// -----------------------------------------------------------------------------
// F5 (#1353): repairRefundedPaymentBusinessState must treat the local ledger as
// Stripe-truth for source=STRIPE payments — raise-only, alert on divergence,
// never un-refund — while keeping Xero authoritative for Internet Banking.
// -----------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  paymentFindMany: vi.fn(),
  paymentUpdate: vi.fn(),
  xeroObjectLinkFindMany: vi.fn(),
  memberCreditFindMany: vi.fn(),
  notifyXeroSyncError: vi.fn(),
  xeroSyncOperationFindMany: vi.fn(),
  paymentRefundAggregate: vi.fn(),
  paymentTransactionFindMany: vi.fn(),
  paymentUpdateMany: vi.fn(),
  paymentFindUnique: vi.fn(),
  manualRefundTaskFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: {
      findMany: mocks.paymentFindMany,
      findUnique: mocks.paymentFindUnique,
      update: mocks.paymentUpdate,
      updateMany: mocks.paymentUpdateMany,
    },
    xeroObjectLink: {
      findMany: mocks.xeroObjectLinkFindMany,
    },
    memberCredit: {
      findMany: mocks.memberCreditFindMany,
    },
    xeroSyncOperation: {
      findMany: mocks.xeroSyncOperationFindMany,
    },
    paymentRefund: {
      aggregate: mocks.paymentRefundAggregate,
    },
    paymentTransaction: {
      findMany: mocks.paymentTransactionFindMany,
    },
    manualRefundTask: {
      findMany: mocks.manualRefundTaskFindMany,
    },
  },
}));

vi.mock("@/lib/xero-error-alert", () => ({
  notifyXeroSyncError: mocks.notifyXeroSyncError,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { repairRefundedPaymentBusinessState } from "@/lib/xero-inbound/credit-note-repairs";
import { resolveModificationRefundAmountsByPaymentId } from "@/lib/xero-inbound/modification-note-refunds";
import { COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE } from "@/lib/manual-refund-task-settlement-rules";

// #3979: the repair writes through a claim on what it read
// (`updateMany` keyed on id, status and refunded total). These suites assert the
// data written through `paymentUpdate`; the claim itself is pinned below.
beforeEach(() => {
  mocks.paymentUpdateMany.mockImplementation(async ({ where, data }: { where: { id: string }; data: unknown }) => {
    await mocks.paymentUpdate({ where: { id: where.id }, data });
    return { count: 1 };
  });
  mocks.paymentTransactionFindMany.mockResolvedValue([]);
  // #4215: no refund request paid back unless a suite says so.
  mocks.manualRefundTaskFindMany.mockResolvedValue([]);
});

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    amountCents: 10000,
    refundedAmountCents: 0,
    status: PaymentStatus.SUCCEEDED,
    source: PaymentSource.STRIPE,
    booking: { organiserSettled: false },
    ...overrides,
  };
}

/**
 * Drive the repair with a single directly-linked payment and the CURRENT
 * inbound credit note as the only Xero-side contribution: derived total =
 * creditNote.total (dollars) when the status is included, else 0.
 */
async function runRepair(input: {
  paymentRow: ReturnType<typeof payment>;
  creditNote: {
    status: string;
    total: number | null;
    appliedAmount?: number | null;
    remainingCredit?: number | null;
  };
}) {
  mocks.paymentFindMany.mockResolvedValue([input.paymentRow]);
  // No OTHER credit-note links contribute; only the current inbound note.
  mocks.xeroObjectLinkFindMany.mockResolvedValue([]);

  return repairRefundedPaymentBusinessState({
    creditNoteId: "cn-current",
    creditNote: {
      status: input.creditNote.status,
      total: input.creditNote.total,
      appliedAmount: input.creditNote.appliedAmount ?? null,
      remainingCredit: input.creditNote.remainingCredit ?? null,
    } as never,
    directPaymentIds: [input.paymentRow.id as string],
    modificationRefundAmountsByPaymentId: new Map(),
  });
}

describe("repairRefundedPaymentBusinessState raise-only Stripe ledger floor (#1353)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.paymentUpdate.mockResolvedValue({});
    mocks.notifyXeroSyncError.mockResolvedValue(undefined);
  });

  it("never lowers refundedAmountCents for a STRIPE payment; alerts instead", async () => {
    // Local Stripe ledger says 5000c refunded; Xero only shows a 20.00 note.
    const result = await runRepair({
      paymentRow: payment({
        refundedAmountCents: 5000,
        status: PaymentStatus.PARTIALLY_REFUNDED,
      }),
      creditNote: { status: "AUTHORISED", total: 20 },
    });

    // Ledger kept: no write at all (amount floored to local; status already
    // consistent with the floored amount).
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ matchedPayments: 1, updatedPayments: 0 });
    // The divergence is surfaced through the deduped Xero sync alert.
    expect(mocks.notifyXeroSyncError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "refund-ledger-divergence",
        operation: "inbound-credit-note-repair:cn-current",
        errorMessage: expect.stringMatching(/\$20\.00.*pay-1.*\$50\.00/),
      })
    );
  });

  it("still raises refundedAmountCents for a STRIPE payment when Xero shows more", async () => {
    const result = await runRepair({
      paymentRow: payment({
        refundedAmountCents: 1000,
        status: PaymentStatus.PARTIALLY_REFUNDED,
      }),
      creditNote: { status: "AUTHORISED", total: 30 },
    });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 3000 },
    });
    expect(result).toEqual({ matchedPayments: 1, updatedPayments: 1 });
    expect(mocks.notifyXeroSyncError).not.toHaveBeenCalled();
  });

  it("never downgrades a REFUNDED STRIPE payment to SUCCEEDED (voided-note un-refund)", async () => {
    // An operator voided the refund credit note in Xero: the derived total is
    // 0 (VOIDED notes are excluded), and the local mirror already shows 0
    // refunded with a REFUNDED status. Pre-#1353 this "repair" flipped the
    // payment back to SUCCEEDED even though Stripe paid the money out.
    const result = await runRepair({
      paymentRow: payment({
        refundedAmountCents: 0,
        status: PaymentStatus.REFUNDED,
      }),
      creditNote: { status: "VOIDED", total: 100 },
    });

    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ matchedPayments: 1, updatedPayments: 0 });
  });

  it("keeps Xero authoritative for INTERNET_BANKING payments (lower write still applies)", async () => {
    const result = await runRepair({
      paymentRow: payment({
        source: PaymentSource.INTERNET_BANKING,
        refundedAmountCents: 5000,
        status: PaymentStatus.PARTIALLY_REFUNDED,
      }),
      creditNote: { status: "AUTHORISED", total: 20 },
    });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 2000 },
    });
    expect(result).toEqual({ matchedPayments: 1, updatedPayments: 1 });
    expect(mocks.notifyXeroSyncError).not.toHaveBeenCalled();
  });

  it("repairs a lagging status upward from the floored local ledger", async () => {
    // Local ledger fully refunded but the status mirror lags at SUCCEEDED;
    // Xero derives 0. The floor keeps 10000c and the status is corrected
    // UPWARD to REFUNDED — upgrades from the floored value stay allowed.
    const result = await runRepair({
      paymentRow: payment({
        refundedAmountCents: 10000,
        status: PaymentStatus.SUCCEEDED,
      }),
      creditNote: { status: "VOIDED", total: 100 },
    });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { status: PaymentStatus.REFUNDED },
    });
    expect(result).toEqual({ matchedPayments: 1, updatedPayments: 1 });
    expect(mocks.notifyXeroSyncError).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// #4215 (`INV-PAY-118`): a refund request paid back by bank transfer moved the
// refunded total by its own amount and carries its own note, never the
// canonical one. A recount triggered by the canonical note keeps that cash,
// read from the request's completed hand-back - however its note stands.
// -----------------------------------------------------------------------------
describe("#4215: a refund request's paid-back cash survives a canonical-note recount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.paymentUpdate.mockResolvedValue({});
  });

  const bankPayment = payment({
    source: PaymentSource.INTERNET_BANKING,
    amountCents: 20000,
    refundedAmountCents: 15000,
    status: PaymentStatus.PARTIALLY_REFUNDED,
  });

  it("MUTATION: keeps the request's $50 beside the canonical note's $100 - no write", async () => {
    mocks.manualRefundTaskFindMany.mockResolvedValue([{ paymentId: "pay-1", amountCents: 5000 }]);

    const result = await runRepair({ paymentRow: bankPayment, creditNote: { status: "PAID", total: 100 } });

    // Before #4215 this wrote 10000: the request's cash dropped out.
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ matchedPayments: 1, updatedPayments: 0 });
  });

  it("reads the completed refund-request hand-backs of the repaired payments, and no other task", async () => {
    await runRepair({ paymentRow: bankPayment, creditNote: { status: "PAID", total: 100 } });

    expect(mocks.manualRefundTaskFindMany).toHaveBeenCalledWith({
      where: { paymentId: { in: ["pay-1"] }, ...COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE },
      select: { paymentId: true, amountCents: true },
    });
    expect(COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE).toEqual({
      kind: "CANCELLED_BOOKING_HAND_BACK",
      status: "COMPLETED",
      occurrenceKey: { startsWith: "refund-request-hand-back:" },
    });
  });

  it("reads the requests after the payment row, so a completion between the reads loses the claim instead of being dropped", async () => {
    await runRepair({ paymentRow: bankPayment, creditNote: { status: "PAID", total: 100 } });

    const paymentRead = mocks.paymentFindMany.mock.invocationCallOrder[0]!;
    const requestRead = mocks.manualRefundTaskFindMany.mock.invocationCallOrder[0]!;
    expect(requestRead).toBeGreaterThan(paymentRead);
  });

  it("sums every request on the payment, and never one on another payment", async () => {
    mocks.manualRefundTaskFindMany.mockResolvedValue([
      { paymentId: "pay-1", amountCents: 3000 },
      { paymentId: "pay-1", amountCents: 2000 },
      { paymentId: "pay-other", amountCents: 4000 },
    ]);

    await runRepair({ paymentRow: bankPayment, creditNote: { status: "PAID", total: 100 } });

    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
  });

  it("an edit's note reconciled on the payment's invoice keeps the request's cash too", async () => {
    mocks.manualRefundTaskFindMany.mockResolvedValue([{ paymentId: "pay-1", amountCents: 5000 }]);
    mocks.paymentFindMany.mockResolvedValue([{ ...bankPayment, refundedAmountCents: 7000 }]);
    mocks.xeroObjectLinkFindMany.mockResolvedValue([]);

    await repairRefundedPaymentBusinessState({
      creditNoteId: "cn-edit",
      creditNote: { status: "AUTHORISED", total: 20 } as never,
      directPaymentIds: [],
      modificationRefundAmountsByPaymentId: new Map([["pay-1", 2000]]),
    });

    // Before #4215 this wrote 2000: the edit's $20 alone.
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
  });

  it("the canonical note voided: only the request's cash stays (INV-ADDPAY-041)", async () => {
    mocks.manualRefundTaskFindMany.mockResolvedValue([{ paymentId: "pay-1", amountCents: 5000 }]);

    await runRepair({ paymentRow: bankPayment, creditNote: { status: "VOIDED", total: 100 } });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({ where: { id: "pay-1" }, data: { refundedAmountCents: 5000 } });
  });

  it("a total past the amount paid is clamped and reads REFUNDED", async () => {
    mocks.manualRefundTaskFindMany.mockResolvedValue([{ paymentId: "pay-1", amountCents: 15000 }]);

    await runRepair({ paymentRow: bankPayment, creditNote: { status: "PAID", total: 100 } });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 20000, status: PaymentStatus.REFUNDED },
    });
  });
});

// -----------------------------------------------------------------------------
// #3809 (review M2): an edit's invoice-allocated note for applied credit GIVEN
// BACK moves no cash. The inbound fold of modification notes into
// `Payment.refundedAmountCents` (Xero-authoritative for internet banking) must
// count only the notes that returned money - here the $30 bank hand-back of a
// $100 bank + $100 credit booking reduced by $150 at 50% less $20, not the $25
// of credit given back beside it.
// -----------------------------------------------------------------------------
describe("#3809: a give-back's account-credit note is not a cash refund", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.paymentUpdate.mockResolvedValue({});
    mocks.paymentFindMany.mockResolvedValue([
      payment({ source: PaymentSource.INTERNET_BANKING, refundedAmountCents: 3000, status: PaymentStatus.PARTIALLY_REFUNDED }),
    ]);
    mocks.xeroObjectLinkFindMany.mockImplementation(async ({ where }: { where: { role?: unknown; xeroObjectType?: string } }) => {
      if (where.role === "MODIFICATION_CREDIT_NOTE_ALLOCATION") {
        return [
          { localId: "pay-1", xeroObjectId: "alloc-hand-back", metadata: { creditNoteId: "cn-hand-back", invoiceId: "inv-1", amountCents: 3000 } },
          { localId: "pay-1", xeroObjectId: "alloc-give-back", metadata: { creditNoteId: "cn-give-back", invoiceId: "inv-1", amountCents: 2500 } },
        ];
      }
      if (where.role === "MODIFICATION_CREDIT_NOTE") {
        return [
          { xeroObjectId: "cn-hand-back", metadata: { status: "AUTHORISED" } },
          { xeroObjectId: "cn-give-back", metadata: { status: "AUTHORISED" } },
        ];
      }
      return [];
    });
    mocks.xeroSyncOperationFindMany.mockResolvedValue([
      { xeroObjectId: "cn-hand-back", requestPayload: { refundMethod: "internet-banking" } },
      { xeroObjectId: "cn-give-back", requestPayload: { refundMethod: "account-credit", reviewTaskId: "applied-credit-give-back" } },
    ]);
  });

  it("MUTATION: an unrelated inbound note leaves the bank payment's refunded total at the $30 actually handed back", async () => {
    await repairRefundedPaymentBusinessState({
      creditNoteId: "cn-current",
      creditNote: { status: "AUTHORISED", total: 0 } as never,
      directPaymentIds: [],
      modificationRefundAmountsByPaymentId: new Map([["pay-1", 0]]),
    });

    // Before #3809's fix this wrote 5500: the $25 of credit folded in as cash.
    expect(mocks.paymentUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ refundedAmountCents: 5500 }) }));
    const writes = mocks.paymentUpdate.mock.calls.map((call) => call[0].data.refundedAmountCents).filter((cents) => cents !== undefined);
    expect(writes.every((cents) => cents === 3000)).toBe(true);
  });
});

// #3954 (owner decision 10 Oct 2026, "Auto credit note"): a reduction's
// invoice-correction note for the part of an unpaid ask the primary invoice had
// billed credits money the member never paid, so it moves no cash either.
describe("#3954: a billed-offset invoice-correction note is not a cash refund", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.paymentUpdate.mockResolvedValue({});
    mocks.paymentFindMany.mockResolvedValue([
      payment({ source: PaymentSource.INTERNET_BANKING, refundedAmountCents: 3000, status: PaymentStatus.PARTIALLY_REFUNDED }),
    ]);
    mocks.xeroObjectLinkFindMany.mockImplementation(async ({ where }: { where: { role?: unknown; xeroObjectType?: string } }) => {
      if (where.role === "MODIFICATION_CREDIT_NOTE_ALLOCATION") {
        return [
          { localId: "pay-1", xeroObjectId: "alloc-hand-back", metadata: { creditNoteId: "cn-hand-back", invoiceId: "inv-1", amountCents: 3000 } },
          { localId: "pay-1", xeroObjectId: "alloc-billed-offset", metadata: { creditNoteId: "cn-billed-offset", invoiceId: "inv-1", amountCents: 2000 } },
        ];
      }
      if (where.role === "MODIFICATION_CREDIT_NOTE") {
        return [
          { xeroObjectId: "cn-hand-back", metadata: { status: "AUTHORISED" } },
          { xeroObjectId: "cn-billed-offset", metadata: { status: "AUTHORISED" } },
        ];
      }
      return [];
    });
    mocks.xeroSyncOperationFindMany.mockResolvedValue([
      { xeroObjectId: "cn-hand-back", requestPayload: { refundMethod: "internet-banking" } },
      { xeroObjectId: "cn-billed-offset", requestPayload: { noteWording: "invoice-correction", reviewTaskId: "unpaid-ask-billed-offset" } },
    ]);
  });

  it("MUTATION: the bank payment's refunded total stays at the $30 actually handed back", async () => {
    await repairRefundedPaymentBusinessState({
      creditNoteId: "cn-current",
      creditNote: { status: "AUTHORISED", total: 0 } as never,
      directPaymentIds: [],
      modificationRefundAmountsByPaymentId: new Map([["pay-1", 0]]),
    });

    expect(mocks.paymentUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ refundedAmountCents: 5000 }) }));
    const writes = mocks.paymentUpdate.mock.calls.map((call) => call[0].data.refundedAmountCents).filter((cents) => cents !== undefined);
    expect(writes.every((cents) => cents === 3000)).toBe(true);
  });
});

describe("an organiser-settled child's mirror is raised only by Stripe evidence (#3653)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.paymentUpdate.mockResolvedValue({});
    mocks.notifyXeroSyncError.mockResolvedValue(undefined);
  });

  it("does not raise the child's mirror past the refunds Stripe recorded", async () => {
    mocks.paymentRefundAggregate.mockResolvedValue({ _sum: { amountCents: 1500 } });
    await runRepair({
      paymentRow: payment({
        refundedAmountCents: 1000,
        status: PaymentStatus.PARTIALLY_REFUNDED,
        booking: { organiserSettled: true },
      }),
      creditNote: { status: "AUTHORISED", total: 30 },
    });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 1500 },
    });
  });

  it("writes nothing when Stripe recorded no more than the mirror already holds", async () => {
    mocks.paymentRefundAggregate.mockResolvedValue({ _sum: { amountCents: null } });
    const result = await runRepair({
      paymentRow: payment({
        refundedAmountCents: 1000,
        status: PaymentStatus.PARTIALLY_REFUNDED,
        booking: { organiserSettled: true },
      }),
      creditNote: { status: "AUTHORISED", total: 30 },
    });

    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ matchedPayments: 1, updatedPayments: 0 });
  });
});

// #3979 (`INV-PAY-125`): an invoice correction is not a refund, so a re-sync can
// take an older fold off a payment nothing was ever captured on. The payment
// goes back to its uncaptured state; it never reads as paid.
describe("repairRefundedPaymentBusinessState undoing a fold on a never-captured payment (#3979)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.paymentUpdate.mockResolvedValue({});
  });

  const folded = () =>
    payment({
      source: PaymentSource.INTERNET_BANKING,
      amountCents: 30_000,
      refundedAmountCents: 10_000,
      status: PaymentStatus.PARTIALLY_REFUNDED,
    });

  it("returns the payment to its PRIMARY row's PENDING, never SUCCEEDED", async () => {
    mocks.paymentTransactionFindMany.mockResolvedValue([
      { kind: "PRIMARY", status: PaymentStatus.PENDING, createdAt: new Date("2026-06-01T00:00:00.000Z") },
    ]);

    await runRepair({ paymentRow: folded(), creditNote: { status: "VOIDED", total: 100 } });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 0, status: PaymentStatus.PENDING },
    });
  });

  it("a cancelled booking's never-captured payment goes back to FAILED", async () => {
    mocks.paymentTransactionFindMany.mockResolvedValue([
      { kind: "PRIMARY", status: PaymentStatus.FAILED, createdAt: new Date("2026-06-01T00:00:00.000Z") },
    ]);

    await runRepair({ paymentRow: folded(), creditNote: { status: "VOIDED", total: 100 } });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 0, status: PaymentStatus.FAILED },
    });
  });

  it("a captured payment still un-refunds to SUCCEEDED", async () => {
    mocks.paymentTransactionFindMany.mockResolvedValue([
      { kind: "PRIMARY", status: PaymentStatus.PARTIALLY_REFUNDED, createdAt: new Date("2026-06-01T00:00:00.000Z") },
    ]);

    await runRepair({ paymentRow: folded(), creditNote: { status: "VOIDED", total: 100 } });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 0, status: PaymentStatus.SUCCEEDED },
    });
  });
});

describe("the un-refund guard's limits and the write's claim (#3979 review C)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.paymentUpdate.mockResolvedValue({});
  });

  const folded = (overrides: Record<string, unknown> = {}) =>
    payment({
      source: PaymentSource.INTERNET_BANKING,
      amountCents: 30_000,
      refundedAmountCents: 10_000,
      status: PaymentStatus.PARTIALLY_REFUNDED,
      ...overrides,
    });

  it("a payment with no rows at all keeps today's answer: SUCCEEDED", async () => {
    mocks.paymentTransactionFindMany.mockResolvedValue([]);

    await runRepair({ paymentRow: folded(), creditNote: { status: "VOIDED", total: 100 } });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 0, status: PaymentStatus.SUCCEEDED },
    });
  });

  it("an organiser-settled child is left to the #3653 mirror, never asked", async () => {
    mocks.paymentTransactionFindMany.mockResolvedValue([
      { kind: "PRIMARY", status: PaymentStatus.PENDING, createdAt: new Date("2026-06-01T00:00:00.000Z") },
    ]);

    await runRepair({ paymentRow: folded({ booking: { organiserSettled: true } }), creditNote: { status: "VOIDED", total: 100 } });

    expect(mocks.paymentTransactionFindMany).not.toHaveBeenCalled();
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      data: { refundedAmountCents: 0, status: PaymentStatus.SUCCEEDED },
    });
  });

  it("writes only through a claim on the whole row it read", async () => {
    mocks.paymentTransactionFindMany.mockResolvedValue([]);
    const readAt = new Date("2026-06-30T00:00:00.000Z");

    await runRepair({ paymentRow: folded({ updatedAt: readAt }), creditNote: { status: "VOIDED", total: 100 } });

    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "pay-1",
        status: PaymentStatus.PARTIALLY_REFUNDED,
        refundedAmountCents: 10_000,
        amountCents: 30_000,
        updatedAt: readAt,
      },
      data: { refundedAmountCents: 0, status: PaymentStatus.SUCCEEDED },
    });
  });

  it("MUTATION: a settle that KEEPS the stored figure between the repair's read and its write is never overwritten - the repair re-runs from scratch (#3979 final review)", async () => {
    // $300 invoiced, a $100 correction already folded in, the payment never
    // captured when the repair reads it: the correction does not count there,
    // so the repair would write $0 refunded. Before it writes, the settle
    // records the receipt and KEEPS the stored $300 - status and refunded total
    // unchanged, the row touched. Writing $0 would leave a net of $300 against
    // $200 of cash.
    let settled = false;
    const receipt = () => ({
      paymentId: "pay-1",
      kind: "PRIMARY",
      source: PaymentSource.INTERNET_BANKING,
      status: settled ? PaymentStatus.SUCCEEDED : PaymentStatus.PENDING,
      reason: "internet_banking_booking_payment",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    mocks.paymentTransactionFindMany.mockImplementation(async () => [receipt()]);
    const row = (updatedAt: string) =>
      folded({ xeroInvoiceId: "inv-1", updatedAt: new Date(updatedAt) });
    mocks.paymentFindMany
      .mockResolvedValueOnce([row("2026-06-30T00:00:00.000Z")])
      .mockResolvedValueOnce([row("2026-07-01T00:00:00.000Z")]);
    mocks.xeroObjectLinkFindMany.mockImplementation(async ({ where }: { where: { role?: unknown } }) => {
      if (where.role === "MODIFICATION_CREDIT_NOTE_ALLOCATION") {
        return [{ localId: "mod-1", xeroObjectId: "alloc-correction", metadata: { creditNoteId: "cn-correction", invoiceId: "inv-1", amountCents: 10_000 } }];
      }
      if (where.role === "MODIFICATION_CREDIT_NOTE") {
        return [{ xeroObjectId: "cn-correction", metadata: { status: "AUTHORISED" } }];
      }
      return [];
    });
    mocks.xeroSyncOperationFindMany.mockResolvedValue([
      { xeroObjectId: "cn-correction", localModel: "BookingModification", requestPayload: { noteWording: "invoice-correction" } },
    ]);
    mocks.paymentUpdateMany.mockImplementationOnce(async () => {
      settled = true;
      return { count: 0 };
    });
    const recompute = vi.fn().mockResolvedValue(new Map());

    const result = await repairRefundedPaymentBusinessState({
      creditNoteId: "cn-current",
      creditNote: { status: "VOIDED", total: 100 } as never,
      directPaymentIds: ["pay-1"],
      modificationRefundAmountsByPaymentId: new Map(),
      recomputeModificationRefundAmounts: recompute,
    });

    // The first pass would have written $0; it lost its claim.
    expect(mocks.paymentUpdateMany.mock.calls[0][0].data).toMatchObject({ refundedAmountCents: 0 });
    // The re-run read everything again, the current note's share included,
    // and now counts the correction against the stored-figure receipt: the
    // $100 stays, so it writes nothing.
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(mocks.paymentFindMany).toHaveBeenCalledTimes(2);
    expect(mocks.paymentUpdateMany).toHaveBeenCalledTimes(1);
    expect(result.updatedPayments).toBe(0);
  });
});

describe("an invoice correction counts only against a receipt recorded at the stored figure (#3979 review A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.xeroSyncOperationFindMany.mockResolvedValue([
      { xeroObjectId: "cn-correction", localModel: "BookingModification", requestPayload: { noteWording: "invoice-correction" } },
    ]);
    mocks.paymentFindMany.mockResolvedValue([{ id: "pay-1", xeroInvoiceId: "inv-1" }]);
  });

  const resolve = () =>
    resolveModificationRefundAmountsByPaymentId({
      creditNoteId: "cn-correction",
      isModificationNote: true,
      allocationTargets: [{ invoiceId: "inv-1", amountCents: 10_000 }],
    });

  it("counts it against a payment settled at the stored figure (before #3979, or kept)", async () => {
    mocks.paymentTransactionFindMany.mockResolvedValue([
      { paymentId: "pay-1", kind: "PRIMARY", source: "INTERNET_BANKING", status: "SUCCEEDED", reason: "xero_invoice_paid_reconciliation" },
    ]);

    expect(await resolve()).toEqual(new Map([["pay-1", 10_000]]));
  });

  it("never against a payment settled from cash", async () => {
    mocks.paymentTransactionFindMany.mockResolvedValue([
      { paymentId: "pay-1", kind: "PRIMARY", source: "INTERNET_BANKING", status: "SUCCEEDED", reason: "xero_invoice_paid_cash" },
    ]);

    expect(await resolve()).toEqual(new Map());
  });

  it("never against a payment not yet captured", async () => {
    mocks.paymentTransactionFindMany.mockResolvedValue([
      { paymentId: "pay-1", kind: "PRIMARY", source: "INTERNET_BANKING", status: "PENDING", reason: null },
    ]);

    expect(await resolve()).toEqual(new Map());
  });
});

describe("a part payment recognised at cancel is cash-sized, never a stored-figure receipt (#3979 final review)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.xeroSyncOperationFindMany.mockResolvedValue([
      { xeroObjectId: "cn-correction", localModel: "BookingModification", requestPayload: { noteWording: "invoice-correction" } },
    ]);
    mocks.paymentFindMany.mockResolvedValue([{ id: "pay-1", xeroInvoiceId: "inv-1" }]);
  });

  it("MUTATION: a correction does not count against a receipt the cancel recorded at the cash paid", async () => {
    mocks.paymentTransactionFindMany.mockResolvedValue([
      { paymentId: "pay-1", kind: "PRIMARY", source: "INTERNET_BANKING", status: "PARTIALLY_REFUNDED", reason: "xero_part_payment_recognised_at_cancel" },
    ]);

    expect(
      await resolveModificationRefundAmountsByPaymentId({
        creditNoteId: "cn-correction",
        isModificationNote: true,
        allocationTargets: [{ invoiceId: "inv-1", amountCents: 10_000 }],
      }),
    ).toEqual(new Map());
  });
});
