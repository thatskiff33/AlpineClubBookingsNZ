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
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: {
      findMany: mocks.paymentFindMany,
      update: mocks.paymentUpdate,
    },
    xeroObjectLink: {
      findMany: mocks.xeroObjectLinkFindMany,
    },
    memberCredit: {
      findMany: mocks.memberCreditFindMany,
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

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    amountCents: 10000,
    refundedAmountCents: 0,
    status: PaymentStatus.SUCCEEDED,
    source: PaymentSource.STRIPE,
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
