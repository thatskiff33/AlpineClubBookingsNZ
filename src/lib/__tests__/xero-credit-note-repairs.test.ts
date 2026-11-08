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
  paymentTransactionAggregate: vi.fn(),
  paymentUpdateMany: vi.fn(),
  paymentFindUnique: vi.fn(),
  manualRefundTaskFindMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
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
      // #4162: the bank-transfer floor reads the payment's own refund detail.
      aggregate: mocks.paymentTransactionAggregate,
    },
    manualRefundTask: {
      findMany: mocks.manualRefundTaskFindMany,
    },
  },
}));

vi.mock("@/lib/xero-error-alert", () => ({
  notifyXeroSyncError: mocks.notifyXeroSyncError,
}));

const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: logger }));

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
  // No refund detail by default, so the #4162 floor has nothing to keep.
  mocks.paymentTransactionAggregate.mockResolvedValue({ _sum: { refundedAmountCents: 0 } });
});

// #4786: the recount reads a payment's allocations with the note's own role,
// and by its invoice the role-less one too; each link carries its role.
const NOTE_ALLOCATION_ROLE = "MODIFICATION_CREDIT_NOTE_ALLOCATION";
const ROLELESS_ALLOCATION_ROLE = "CREDIT_NOTE_ALLOCATION";
function readsNoteAllocations(role: unknown): boolean {
  if (role === NOTE_ALLOCATION_ROLE) return true;
  const roles = (role as { in?: unknown } | null)?.in;
  return Array.isArray(roles) && roles.includes(NOTE_ALLOCATION_ROLE);
}
const withNoteRole = <T extends object>(links: T[]) => links.map((link) => ({ role: NOTE_ALLOCATION_ROLE, ...link }));

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    bookingId: "booking-1",
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
    creditNoteNumber?: string;
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
      creditNoteNumber: input.creditNote.creditNoteNumber,
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

  it("#4162 MUTATION (INV-ADDPAY-021): never lowers a bank-transfer total below its own detail - it alerts instead", async () => {
    mocks.paymentTransactionAggregate.mockResolvedValue({ _sum: { refundedAmountCents: 5000 } });
    const result = await runRepair({
      paymentRow: payment({ source: PaymentSource.INTERNET_BANKING, refundedAmountCents: 5000, status: PaymentStatus.PARTIALLY_REFUNDED }),
      creditNote: { status: "VOIDED", total: 50, creditNoteNumber: "CN-0042" },
    });

    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ matchedPayments: 1, updatedPayments: 0 });
    expect(mocks.notifyXeroSyncError).toHaveBeenCalledWith(expect.objectContaining({ errorType: "refund-ledger-divergence" }));
    // #4230: where to look (payment, booking, note), the recount's total against the recorded refunds, and what to do.
    const { BANK_TRANSFER_REFUND_SHORTFALL_ADVICE } = await import("@/lib/xero-inbound/credit-note-bank-transfer-floor");
    expect(mocks.notifyXeroSyncError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: `Bank-transfer payment pay-1 on booking booking-1: the refunds Xero accounts for on it add up to $0.00, less than the refunds the club recorded on it ($50.00). The recorded refunds were kept. Found when credit note CN-0042 changed in Xero. ${BANK_TRANSFER_REFUND_SHORTFALL_ADVICE}`,
      }),
    );
    expect(BANK_TRANSFER_REFUND_SHORTFALL_ADVICE).toMatch(/no Xero credit note of its own.*raise a credit note by hand only for a refund whose credit note was never raised\. Never raise one by hand for a refund whose credit note was voided/);
    expect(BANK_TRANSFER_REFUND_SHORTFALL_ADVICE).not.toMatch(/#\d/);
  });

  it("#4230: with no note number from Xero, the alert names the payment and booking and leaves the note out", async () => {
    mocks.paymentTransactionAggregate.mockResolvedValue({ _sum: { refundedAmountCents: 5000 } });
    await runRepair({
      paymentRow: payment({ source: PaymentSource.INTERNET_BANKING, refundedAmountCents: 5000, status: PaymentStatus.PARTIALLY_REFUNDED }),
      creditNote: { status: "AUTHORISED", total: 30 },
    });
    expect(mocks.notifyXeroSyncError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: expect.stringMatching(/^Bank-transfer payment pay-1 on booking booking-1: the refunds Xero accounts for on it add up to \$30\.00, less than the refunds the club recorded on it \(\$50\.00\)\. The recorded refunds were kept\. A refund/),
      }),
    );
  });

  it("#4162: lowers a bank-transfer total to its detail, never below it", async () => {
    mocks.paymentTransactionAggregate.mockResolvedValue({ _sum: { refundedAmountCents: 3000 } });
    await runRepair({
      paymentRow: payment({ source: PaymentSource.INTERNET_BANKING, refundedAmountCents: 5000, status: PaymentStatus.PARTIALLY_REFUNDED }),
      creditNote: { status: "AUTHORISED", total: 10 },
    });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({ where: { id: "pay-1" }, data: { refundedAmountCents: 3000 } });
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
    mocks.manualRefundTaskFindMany.mockResolvedValue([{ paymentId: "pay-1", amountCents: 5000, kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "refund-request-hand-back:rr_1" }]);

    const result = await runRepair({ paymentRow: bankPayment, creditNote: { status: "PAID", total: 100 } });

    // Before #4215 this wrote 10000: the request's cash dropped out.
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ matchedPayments: 1, updatedPayments: 0 });
  });

  it("reads the completed refund-request hand-backs of the repaired payments, and no other task", async () => {
    await runRepair({ paymentRow: bankPayment, creditNote: { status: "PAID", total: 100 } });

    expect(mocks.manualRefundTaskFindMany).toHaveBeenCalledWith({
      where: { paymentId: { in: ["pay-1"] }, ...COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE },
      select: { paymentId: true, amountCents: true, kind: true, occurrenceKey: true },
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
      { paymentId: "pay-1", amountCents: 3000, kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "refund-request-hand-back:rr_2" },
      { paymentId: "pay-1", amountCents: 2000, kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "refund-request-hand-back:rr_3" },
      { paymentId: "pay-other", amountCents: 4000, kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "refund-request-hand-back:rr_4" },
    ]);

    await runRepair({ paymentRow: bankPayment, creditNote: { status: "PAID", total: 100 } });

    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
  });

  it("an edit's note reconciled on the payment's invoice keeps the request's cash too", async () => {
    mocks.manualRefundTaskFindMany.mockResolvedValue([{ paymentId: "pay-1", amountCents: 5000, kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "refund-request-hand-back:rr_5" }]);
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

  it("the canonical note voided with no refund detail recorded: the Xero-derived figure is the request's cash alone, never the note's", async () => {
    mocks.manualRefundTaskFindMany.mockResolvedValue([{ paymentId: "pay-1", amountCents: 5000, kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "refund-request-hand-back:rr_6" }]);

    await runRepair({ paymentRow: bankPayment, creditNote: { status: "VOIDED", total: 100 } });

    // The default detail is $0, so the #4162 floor has nothing to keep: this pins the recount's own sum.
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({ where: { id: "pay-1" }, data: { refundedAmountCents: 5000 } });
  });

  it("the canonical note voided beside a recorded detail: the #4162 floor keeps the detail for the nightly follow-up", async () => {
    mocks.manualRefundTaskFindMany.mockResolvedValue([{ paymentId: "pay-1", amountCents: 5000, kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "refund-request-hand-back:rr_6" }]);
    mocks.paymentTransactionAggregate.mockResolvedValue({ _sum: { refundedAmountCents: 15000 } });

    await runRepair({ paymentRow: bankPayment, creditNote: { status: "VOIDED", total: 100 } });

    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
  });

  it("a total past the amount paid is clamped and reads REFUNDED", async () => {
    mocks.manualRefundTaskFindMany.mockResolvedValue([{ paymentId: "pay-1", amountCents: 15000, kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "refund-request-hand-back:rr_7" }]);

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
      if (readsNoteAllocations(where.role)) {
        return withNoteRole([
          { localId: "pay-1", xeroObjectId: "alloc-hand-back", metadata: { creditNoteId: "cn-hand-back", invoiceId: "inv-1", amountCents: 3000 } },
          { localId: "pay-1", xeroObjectId: "alloc-give-back", metadata: { creditNoteId: "cn-give-back", invoiceId: "inv-1", amountCents: 2500 } },
        ]);
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
      if (readsNoteAllocations(where.role)) {
        return withNoteRole([
          { localId: "pay-1", xeroObjectId: "alloc-hand-back", metadata: { creditNoteId: "cn-hand-back", invoiceId: "inv-1", amountCents: 3000 } },
          { localId: "pay-1", xeroObjectId: "alloc-billed-offset", metadata: { creditNoteId: "cn-billed-offset", invoiceId: "inv-1", amountCents: 2000 } },
        ]);
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

// #4095 (PR #4437 review, L1): the recount adds a note's allocations up per
// note, by the rule the kept settle uses (`sumAppliedCentsByCreditNote`), and
// counts one allocation once however many links hold it.
describe("a modification note's allocations are summed per note, each allocation once (#4095 L1)", () => {
  type AllocationLink = { localId: string; xeroObjectId: string; role: string; metadata: Record<string, unknown>; updatedAt: Date };
  const allocation = (
    xeroObjectId: string,
    invoiceId: string,
    amountCents: number | undefined,
    updatedAt = "2026-06-01T00:00:00.000Z",
    role = NOTE_ALLOCATION_ROLE,
  ): AllocationLink => ({
    localId: "pay-1",
    xeroObjectId,
    role,
    metadata: { creditNoteId: "cn-refund", invoiceId, amountCents },
    updatedAt: new Date(updatedAt),
  });
  // Only the links whose role the query asked for, as Postgres returns them.
  const queriedRoles = (role: unknown): unknown[] => (Array.isArray((role as { in?: unknown })?.in) ? (role as { in: unknown[] }).in : [role]);
  let paymentLinks: AllocationLink[] = [];
  let invoiceLinks: AllocationLink[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    paymentLinks = [];
    invoiceLinks = [];
    mocks.paymentUpdate.mockResolvedValue({});
    mocks.xeroObjectLinkFindMany.mockImplementation(async ({ where }: { where: { role?: unknown; localModel?: string } }) => {
      if (readsNoteAllocations(where.role)) {
        return (where.localModel === "Payment" ? paymentLinks : invoiceLinks).filter((link) => queriedRoles(where.role).includes(link.role));
      }
      if (where.role === "MODIFICATION_CREDIT_NOTE") return [{ xeroObjectId: "cn-refund", metadata: { status: "AUTHORISED" } }];
      return [];
    });
    // A cash refund note, so no no-cash or correction rule applies.
    mocks.xeroSyncOperationFindMany.mockResolvedValue([
      { xeroObjectId: "cn-refund", requestPayload: { refundMethod: "internet-banking" } },
    ]);
  });

  const recount = () =>
    repairRefundedPaymentBusinessState({
      creditNoteId: "cn-current",
      creditNote: { status: "AUTHORISED", total: 0 } as never,
      directPaymentIds: [],
      modificationRefundAmountsByPaymentId: new Map([["pay-1", 0]]),
    });
  const refundedWrites = () =>
    mocks.paymentUpdate.mock.calls.map((call) => call[0].data.refundedAmountCents).filter((cents) => cents !== undefined);

  it("MUTATION: a note applied as $60 and $40 counts 6000 + 4000 = 10000, never one part", async () => {
    // Two allocations, one per invoice, on the payment's own (older) links: the
    // sync writes one link per note and invoice, its parts already summed.
    mocks.paymentFindMany.mockResolvedValue([payment({ source: PaymentSource.INTERNET_BANKING, amountCents: 30_000 })]);
    paymentLinks = [allocation("alloc-60", "inv-1", 6000), allocation("alloc-40", "inv-2", 4000)];

    await recount();
    expect(refundedWrites()).toEqual([10_000]);
  });

  it("one allocation held by the payment's link and found by its invoice too counts once", async () => {
    mocks.paymentFindMany.mockResolvedValue([payment({ source: PaymentSource.INTERNET_BANKING, amountCents: 30_000, xeroInvoiceId: "inv-1" })]);
    paymentLinks = [allocation("alloc-60", "inv-1", 6000)];
    invoiceLinks = [{ ...allocation("alloc-60", "inv-1", 6000), localId: "mod-1" }];

    await recount();
    expect(refundedWrites()).toEqual([6000]);
  });

  it("MUTATION: an older amount left active beside the re-synced allocation counts the newest only, never both", async () => {
    // Applied at $60 by the app, then raised to $100 in Xero: the sync writes a
    // new link (its id carries the amount) and the $60 one stays active.
    mocks.paymentFindMany.mockResolvedValue([payment({ source: PaymentSource.INTERNET_BANKING, amountCents: 30_000 })]);
    paymentLinks = [allocation("alloc-100", "inv-1", 10_000, "2026-06-15T00:00:00.000Z"), allocation("alloc-60", "inv-1", 6000)];

    await recount();
    expect(refundedWrites()).toEqual([10_000]);
  });

  // #4786: an older repair could link a note's allocation role-less
  // (`CREDIT_NOTE_ALLOCATION`) on the note's own anchor, which the recount
  // finds by the payment's invoice. Each allocation counts once, by whichever
  // links record it (`distinctClearingAllocations`).
  describe("a role-less allocation link found by the payment's invoice (#4786)", () => {
    const BANK_PAYMENT = () => payment({ source: PaymentSource.INTERNET_BANKING, amountCents: 30_000, xeroInvoiceId: "inv-1" });
    const onEdit = (link: AllocationLink): AllocationLink => ({ ...link, localId: "mod-1" });

    it("an allocation linked with the note's own role only counts", async () => {
      mocks.paymentFindMany.mockResolvedValue([BANK_PAYMENT()]);
      invoiceLinks = [onEdit(allocation("alloc-60", "inv-1", 6000))];

      await recount();
      expect(refundedWrites()).toEqual([6000]);
    });

    it("MUTATION: an allocation linked only role-less counts too", async () => {
      mocks.paymentFindMany.mockResolvedValue([BANK_PAYMENT()]);
      invoiceLinks = [onEdit(allocation("alloc-60", "inv-1", 6000, undefined, ROLELESS_ALLOCATION_ROLE))];

      await recount();
      expect(refundedWrites()).toEqual([6000]);
      expect(mocks.xeroObjectLinkFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ role: { in: [NOTE_ALLOCATION_ROLE, ROLELESS_ALLOCATION_ROLE] }, xeroObjectType: "ALLOCATION" }),
        }),
      );
    });

    it("MUTATION: the inbound mirror's own-role link and the role-less one for the same allocation count once", async () => {
      mocks.paymentFindMany.mockResolvedValue([BANK_PAYMENT()]);
      invoiceLinks = [
        onEdit(allocation("alloc-60", "inv-1", 6000, "2026-06-01T00:00:00.000Z", ROLELESS_ALLOCATION_ROLE)),
        onEdit(allocation("alloc-60", "inv-1", 6000, "2026-06-02T00:00:00.000Z")),
      ];

      await recount();
      expect(refundedWrites()).toEqual([6000]);
    });

    it("a role-less link for another amount is another allocation, and the per-invoice newest rule (#4095 L1) still counts one", async () => {
      // Never both: the re-synced own-role link already sums the note's
      // allocations to this invoice.
      mocks.paymentFindMany.mockResolvedValue([BANK_PAYMENT()]);
      invoiceLinks = [
        onEdit(allocation("alloc-40", "inv-1", 4000, "2026-06-01T00:00:00.000Z", ROLELESS_ALLOCATION_ROLE)),
        onEdit(allocation("alloc-100", "inv-1", 10_000, "2026-06-15T00:00:00.000Z")),
      ];

      await recount();
      expect(refundedWrites()).toEqual([10_000]);
    });

    it("MUTATION: a role-less link with no amount recorded counts nothing (fail closed)", async () => {
      mocks.paymentFindMany.mockResolvedValue([BANK_PAYMENT()]);
      invoiceLinks = [onEdit(allocation("alloc-x", "inv-1", undefined, undefined, ROLELESS_ALLOCATION_ROLE))];

      await recount();
      expect(refundedWrites()).toEqual([]);
    });

    it("MUTATION: a payment's own role-less links are not read - they mirror its refund and account notes, which the direct total counts", async () => {
      mocks.paymentFindMany.mockResolvedValue([BANK_PAYMENT()]);
      paymentLinks = [allocation("alloc-60", "inv-1", 6000, undefined, ROLELESS_ALLOCATION_ROLE)];

      await recount();
      expect(refundedWrites()).toEqual([]);
      expect(mocks.xeroObjectLinkFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ localModel: "Payment", role: NOTE_ALLOCATION_ROLE, xeroObjectType: "ALLOCATION" }) }),
      );
    });
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
      if (readsNoteAllocations(where.role)) {
        return withNoteRole([{ localId: "mod-1", xeroObjectId: "alloc-correction", metadata: { creditNoteId: "cn-correction", invoiceId: "inv-1", amountCents: 10_000 } }]);
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

// #4095 review, item 2: the kept settle's recount passes no note of its own.
// Every note, the correction included, counts from its links as the repair
// reads them, after the payment rows: nothing read before the repair is used.
describe("a recount with no note being synced (#4095 review, item 2)", () => {
  const keptReceipt = (overrides: Record<string, unknown> = {}) =>
    payment({ source: PaymentSource.INTERNET_BANKING, amountCents: 30_000, xeroInvoiceId: "inv-1", updatedAt: new Date("2026-07-01T00:00:00.000Z"), ...overrides });
  let correctionStatus = "AUTHORISED";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.paymentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.paymentTransactionAggregate.mockResolvedValue({ _sum: { refundedAmountCents: 0 } });
    mocks.manualRefundTaskFindMany.mockResolvedValue([]);
    // The receipt the keep captured at the stored figure.
    mocks.paymentTransactionFindMany.mockResolvedValue([
      { paymentId: "pay-1", kind: "PRIMARY", source: PaymentSource.INTERNET_BANKING, status: PaymentStatus.SUCCEEDED, reason: "internet_banking_booking_payment", createdAt: new Date("2026-06-01T00:00:00.000Z") },
    ]);
    mocks.xeroSyncOperationFindMany.mockResolvedValue([
      { xeroObjectId: "cn-correction", localModel: "BookingModification", requestPayload: { noteWording: "invoice-correction" } },
    ]);
    correctionStatus = "AUTHORISED";
    mocks.xeroObjectLinkFindMany.mockImplementation(async ({ where }: { where: { role?: unknown } }) => {
      if (readsNoteAllocations(where.role)) {
        return withNoteRole([{ localId: "mod-1", xeroObjectId: "alloc-correction", metadata: { creditNoteId: "cn-correction", invoiceId: "inv-1", amountCents: 10_000 } }]);
      }
      if (where.role === "MODIFICATION_CREDIT_NOTE") return [{ xeroObjectId: "cn-correction", metadata: { status: correctionStatus } }];
      return [];
    });
  });

  const recount = () =>
    repairRefundedPaymentBusinessState({
      creditNoteId: null,
      // Read as live if it counted: a recount with no note must ignore it.
      creditNote: { status: "AUTHORISED", total: 50 } as never,
      directPaymentIds: ["pay-1"],
      modificationRefundAmountsByPaymentId: new Map(),
    });

  it("counts a synced correction from its links against the kept receipt", async () => {
    mocks.paymentFindMany.mockResolvedValue([keptReceipt()]);

    await expect(recount()).resolves.toEqual({ matchedPayments: 1, updatedPayments: 1 });
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { refundedAmountCents: 10_000, status: PaymentStatus.PARTIALLY_REFUNDED } }),
    );
    // No current note: no refund-note row of its own is read, nor any lock taken.
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("a correction voided before the recount reads its link counts nothing, so the void is never overwritten", async () => {
    mocks.paymentFindMany.mockResolvedValue([keptReceipt({ refundedAmountCents: 10_000, status: PaymentStatus.PARTIALLY_REFUNDED })]);
    correctionStatus = "VOIDED";

    await recount();
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { refundedAmountCents: 0, status: PaymentStatus.SUCCEEDED } }),
    );
  });

  it("MUTATION: the creditNote passed adds nothing as a current note", async () => {
    mocks.paymentFindMany.mockResolvedValue([keptReceipt()]);
    mocks.xeroObjectLinkFindMany.mockResolvedValue([]);

    await expect(recount()).resolves.toEqual({ matchedPayments: 1, updatedPayments: 0 });
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
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

describe("#4288: the claim and the re-read of the note's own row, under the Payment row lock", () => {
  const NOTE_ROW = (status: string, active = status !== "VOIDED") => ({ localId: "pay-1", xeroObjectId: "cn-current", active, metadata: { status, total: 100 } });
  /** The recount's reads: the note's own refund-note row live on the payment, no other link. */
  const linkReads = (where: { xeroObjectId?: string; role?: string }) =>
    where.xeroObjectId === "cn-current" && where.role === "REFUND_CREDIT_NOTE" ? [NOTE_ROW("AUTHORISED")] : [];
  /** The transaction's client: the row re-read under the lock answers `rowNow`. */
  function lockedTx(rowNow: () => unknown[], findFirst: () => unknown = () => ({ id: "pay-1" })) {
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      xeroObjectLink: { findMany: vi.fn(async () => rowNow()) },
      payment: { findFirst: vi.fn(async () => findFirst()), updateMany: mocks.paymentUpdateMany },
    };
    return tx;
  }
  const repair = () =>
    repairRefundedPaymentBusinessState({
      creditNoteId: "cn-current",
      creditNote: { status: "AUTHORISED", total: 100, appliedAmount: null, remainingCredit: null } as never,
      directPaymentIds: ["pay-1"],
      modificationRefundAmountsByPaymentId: new Map(),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.paymentUpdate.mockResolvedValue({});
    mocks.notifyXeroSyncError.mockResolvedValue(undefined);
    mocks.xeroObjectLinkFindMany.mockImplementation(async ({ where }: { where: { xeroObjectId?: string; role?: string } }) => linkReads(where));
  });

  it("MUTATION (bounded): a note that stops counting under the lock on every pass is retried once, then handed back unsettled (#4095)", async () => {
    mocks.paymentFindMany.mockResolvedValue([payment({ refundedAmountCents: 5000, status: PaymentStatus.PARTIALLY_REFUNDED })]);
    let passes = 0;
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      passes += 1;
      // An unbounded retry would never stop: fail it here, not by overflowing the stack.
      if (passes > 5) throw new Error("the recount retried without bound");
      return callback(lockedTx(() => [NOTE_ROW("VOIDED")]));
    });

    await expect(repair()).resolves.toEqual({ matchedPayments: 1, updatedPayments: 0, unsettledPaymentIds: ["pay-1"] });
    expect(passes).toBe(2);
    // Nothing is written on a pass whose note stopped counting.
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ paymentIds: ["pay-1"] }), expect.stringContaining("fails its event so it is retried"));
  });

  it("a claim lost on both passes is handed back unsettled, so the caller fails its event to be retried (#4095 item 6)", async () => {
    mocks.paymentFindMany.mockResolvedValue([payment({ refundedAmountCents: 5000, status: PaymentStatus.PARTIALLY_REFUNDED })]);
    mocks.paymentUpdateMany.mockResolvedValue({ count: 0 });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      if (mocks.transaction.mock.calls.length > 5) throw new Error("the recount retried without bound");
      return callback(lockedTx(() => [NOTE_ROW("AUTHORISED")]));
    });

    await expect(repair()).resolves.toEqual({ matchedPayments: 1, updatedPayments: 0, unsettledPaymentIds: ["pay-1"] });
    expect(mocks.paymentUpdateMany).toHaveBeenCalledTimes(2);
  });

  it("a claim lost once and won on the retry settles: nothing is handed back", async () => {
    mocks.paymentFindMany.mockResolvedValue([payment({ refundedAmountCents: 5000, status: PaymentStatus.PARTIALLY_REFUNDED })]);
    mocks.paymentUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(lockedTx(() => [NOTE_ROW("AUTHORISED")])));

    await expect(repair()).resolves.toEqual({ matchedPayments: 1, updatedPayments: 1 });
  });

  it("MUTATION (claim): the claim is taken under the lock after the re-read, never without it", async () => {
    mocks.paymentFindMany.mockResolvedValue([payment({ refundedAmountCents: 5000, status: PaymentStatus.PARTIALLY_REFUNDED })]);
    const order: string[] = [];
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = lockedTx(() => { order.push("re-read"); return [NOTE_ROW("AUTHORISED")]; });
      tx.$executeRaw.mockImplementation(async () => { order.push("lock"); return 1; });
      mocks.paymentUpdateMany.mockImplementationOnce(async () => { order.push("claim"); return { count: 1 }; });
      return callback(tx);
    });

    await expect(repair()).resolves.toEqual({ matchedPayments: 1, updatedPayments: 1 });
    expect(order).toEqual(["lock", "re-read", "claim"]);
  });

  it("an officer's card refund landing between the reads and the claim loses the claim; the retry finds the note voided and writes nothing - the $175 stands", async () => {
    // A read $50; an officer refunds by card and the aggregates write $175 before A's claim.
    mocks.paymentFindMany
      .mockResolvedValueOnce([payment({ amountCents: 20_000, refundedAmountCents: 5000, status: PaymentStatus.PARTIALLY_REFUNDED })])
      .mockResolvedValue([payment({ amountCents: 20_000, refundedAmountCents: 17_500, status: PaymentStatus.PARTIALLY_REFUNDED })]);
    let voided = false;
    mocks.paymentUpdateMany.mockImplementation(async ({ where }: { where: { refundedAmountCents: number } }) => ({ count: where.refundedAmountCents === 17_500 ? 1 : 0 }));
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      if (mocks.transaction.mock.calls.length > 5) throw new Error("the recount retried without bound");
      // The first pass finds the note live; the retry finds it voided meanwhile.
      const voidedNow = voided;
      voided = true;
      return callback(lockedTx(() => [NOTE_ROW(voidedNow ? "VOIDED" : "AUTHORISED")]));
    });

    // The retry's unlocked read still saw the note live, so it too stopped on the locked
    // re-read: handed back, and the event's retry reads the voided note afresh (#4095).
    await expect(repair()).resolves.toEqual({ matchedPayments: 1, updatedPayments: 0, unsettledPaymentIds: ["pay-1"] });
    // First pass: its $100 claim is on the $50 it read, so the officer's $175 loses it. Second: nothing is written.
    expect(mocks.paymentUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ refundedAmountCents: 5000 }) }));
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    // The retry's Xero-derived $100 is below the card ledger's $175: kept and alerted, never written lower.
    expect(mocks.notifyXeroSyncError).toHaveBeenCalledWith(expect.objectContaining({ errorType: "refund-ledger-divergence" }));
  });

  it("an officer's card refund landing between the reads and the claim, the note still live: the retry's locked check keeps the $175, never lowered", async () => {
    mocks.paymentFindMany
      .mockResolvedValueOnce([payment({ amountCents: 20_000, refundedAmountCents: 5000, status: PaymentStatus.PARTIALLY_REFUNDED })])
      .mockResolvedValue([payment({ amountCents: 20_000, refundedAmountCents: 17_500, status: PaymentStatus.PARTIALLY_REFUNDED })]);
    mocks.paymentUpdateMany.mockImplementation(async ({ where }: { where: { refundedAmountCents: number } }) => ({ count: where.refundedAmountCents === 17_500 ? 1 : 0 }));
    const unchangedChecks: unknown[] = [];
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      if (mocks.transaction.mock.calls.length > 5) throw new Error("the recount retried without bound");
      return callback(lockedTx(() => [NOTE_ROW("AUTHORISED")], () => {
        unchangedChecks.push(true);
        return { id: "pay-1" };
      }));
    });

    await expect(repair()).resolves.toEqual({ matchedPayments: 1, updatedPayments: 0 });
    // First pass: the $100 claim on the $50 it read is lost to the officer's $175.
    expect(mocks.paymentUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ refundedAmountCents: 5000 }) }));
    // Retry: the note still counts, its $100 is below the card ledger's $175 (kept, alerted), so nothing to write - and the
    // locked unchanged check confirms the row as read, instead of a write.
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(unchangedChecks).toHaveLength(1);
    expect(mocks.notifyXeroSyncError).toHaveBeenCalledWith(expect.objectContaining({ errorType: "refund-ledger-divergence" }));
  });
});
