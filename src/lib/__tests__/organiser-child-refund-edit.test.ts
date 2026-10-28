import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PaymentSource, PaymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { requireCalendarDate } from "@/lib/club-time";
import {
  applyPaymentAdjustments,
  calculateFullReductionSettlementOptions,
  calculateModificationSettlementOptions,
  organiserChildChargeRefusal,
} from "@/lib/booking-modify-settlement";
import { paymentEligibleForPaidCancelPath, paymentHasCaptureEvidence } from "@/lib/booking-cancel";
import { ORGANISER_CHILD_CHARGE_REFUSAL } from "@/lib/group-organiser-paid";
import { GROUP_CANCEL_IN_PROGRESS_PRICE_MESSAGE, organiserBankChildPriceChangeRefusal } from "@/lib/group-cancel-in-progress";
import type { BookingModificationSettlementOptions } from "@/lib/booking-modify-settlement";
import { noReductionAgainstUnpaidAsk } from "@/lib/additional-ask-reduction";
import type { LoadedBookingForModify } from "@/lib/booking-modify-validation";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/** #3809: the club's day and format the shared settlement now takes, resolved before its transaction. */
const SETTLEMENT_DAY = { todayAtClub: requireCalendarDate("2026-07-01"), format: CLUB_FORMAT_TEST };
import { OrganiserChildRefundRefusedError } from "@/lib/organiser-child-refund";
import { reopenedRetryAt } from "@/lib/organiser-child-refund-executor";

// `booking-modify-settlement` reaches `@/lib/cancellation`, which constructs the
// Prisma adapter at import time; nothing here touches the module client.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

/*
  #3653 (`INV-PAY-114`): an edit that reduces a booking the group organiser paid
  for returns the reduction to the organiser's card, from the group's combined
  payment. These pin the edit-door half: one disposition (no account credit),
  and a refusal BEFORE the edit commits when the combined payment cannot pay it.
  The provider half is proved against PostgreSQL in
  `organiser-child-refund.realdb.test.ts`.
*/

const REPO_ROOT = resolve(__dirname, "../../..");

function child(overrides: Record<string, unknown> = {}) {
  return {
    id: "child_1",
    status: "PAID",
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    lodgeId: "lodge_1",
    memberId: "joiner_1",
    organiserSettled: true,
    parentBookingId: "organiser_booking",
    payment: {
      id: "payment_1",
      status: PaymentStatus.SUCCEEDED,
      source: PaymentSource.STRIPE,
      amountCents: 4500,
      refundedAmountCents: 0,
      creditAppliedCents: 0,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
      xeroInvoiceId: null,
    },
    ...overrides,
  } as unknown as LoadedBookingForModify;
}

const ORGANISER_OPTIONS: BookingModificationSettlementOptions = {
  basisAmountCents: 1500,
  cardRefundAmountCents: 1500,
  cardRefundPercentage: 100,
  accountCreditAmountCents: 0,
  accountCreditPercentage: 0,
  daysUntilCheckIn: 30,
  requiresSettlementMethod: false,
  returnsToOrganiser: true,
  organiserRefundByBankTransfer: false,
};

function txWithSettlement(settlement: Record<string, unknown> | null, groupStatus = "OPEN") {
  return {
    // #3980: an edit that read no invoice link claims the payment row.
    payment: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    // #3949 review round 5: the organiser's group, read by the mid-cancel price-change refusal.
    groupBooking: { findUnique: vi.fn(async () => ({ status: groupStatus,
      organiserBookingId: "organiser_booking", organiserMemberId: "organiser",
      organiserMember: { id: "organiser" },
      settlement: { id: "bank-settlement", source: "INTERNET_BANKING", xeroInvoiceId: "combined-invoice" },
    })) },
    groupBookingSettlement: { findFirst: vi.fn().mockResolvedValue(settlement) },
    // #3809: no applied credit, so a reduction gives none back.
    memberCredit: { aggregate: vi.fn().mockResolvedValue({ _sum: { amountCents: null } }) },
    // #3827 (composed by #3829): no open by-hand refund task on file.
    // #3954: no increase is waiting on its mint's recovery for a reduction to net off.
    paymentRecoveryOperation: { findMany: vi.fn(async () => []) },
    manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })) },
  } as unknown as Parameters<typeof applyPaymentAdjustments>[0];
}

const CARD_SETTLEMENT = {
  id: "settlement_1",
  stripePaymentIntentId: "pi_combined",
  amountCents: 9000,
  status: PaymentStatus.SUCCEEDED,
  refundPlan: null,
};

describe("an organiser child's reduction at the edit door (#3653)", () => {
  it("returns the reduction to the organiser's card from the combined payment, with no method chosen", async () => {
    const tx = txWithSettlement(CARD_SETTLEMENT);
    const result = await applyPaymentAdjustments(tx, { reduction: noReductionAgainstUnpaidAsk(-1500),
      ...SETTLEMENT_DAY,
      booking: child(),
      priceDiffCents: -1500,
      changeFeeCents: 0,
      settlementOptions: ORGANISER_OPTIONS,
    });
    expect(result.settlementMethod).toBe("card");
    expect(result.accountCreditAmountCents).toBe(0);
    expect(result.pendingRefundAmountCents).toBe(1500);
    expect(result.organiserChildRefund).toEqual({
      settlement: CARD_SETTLEMENT,
      amountCents: 1500,
    });
  });

  it("refuses account credit for a booking the organiser paid for, before the edit commits", async () => {
    await expect(
      applyPaymentAdjustments(txWithSettlement(CARD_SETTLEMENT), { reduction: noReductionAgainstUnpaidAsk(-1500),
        ...SETTLEMENT_DAY,
        booking: child(),
        priceDiffCents: -1500,
        changeFeeCents: 0,
        settlementOptions: ORGANISER_OPTIONS,
        settlementMethod: "credit",
      }),
    ).rejects.toThrow("cannot be held as account credit");
  });

  it("refuses the reduction when the organiser's card payment is gone or fully refunded", async () => {
    for (const settlement of [null, { ...CARD_SETTLEMENT, status: PaymentStatus.REFUNDED }]) {
      await expect(
        applyPaymentAdjustments(txWithSettlement(settlement), { reduction: noReductionAgainstUnpaidAsk(-1500),
          ...SETTLEMENT_DAY,
          booking: child(),
          priceDiffCents: -1500,
          changeFeeCents: 0,
          settlementOptions: ORGANISER_OPTIONS,
        }),
      ).rejects.toBeInstanceOf(OrganiserChildRefundRefusedError);
    }
  });

  it("leaves an ordinary booking's refund on the ordinary path", async () => {
    const tx = txWithSettlement(CARD_SETTLEMENT);
    const result = await applyPaymentAdjustments(tx, { reduction: noReductionAgainstUnpaidAsk(-1500),
      ...SETTLEMENT_DAY,
      booking: child({ organiserSettled: false, parentBookingId: null }),
      priceDiffCents: -1500,
      changeFeeCents: 0,
      settlementOptions: { ...ORGANISER_OPTIONS, returnsToOrganiser: false, requiresSettlementMethod: true },
      settlementMethod: "card",
    });
    expect(result.organiserChildRefund).toBeNull();
    expect(result.pendingRefundAmountCents).toBe(1500);
  });

  /** A policy db for `calculateModificationSettlementOptions`: one 100% card, 100% credit tier. */
  const POLICY_DB = {
    // #3827 (composed by #3829): no open by-hand refund task on file.
    // #3954: no increase is waiting on its mint's recovery for a reduction to net off.
    paymentRecoveryOperation: { findMany: vi.fn(async () => []) },
    manualRefundTask: { aggregate: vi.fn(async () => ({ _sum: { amountCents: null } })) },
    lodge: { findFirst: vi.fn().mockResolvedValue({ id: "lodge_1" }) },
    bookingPeriod: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    bookingDefaults: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null) },
    cancellationPolicy: {
      findMany: vi.fn().mockResolvedValue([
        { lodgeId: "lodge_1", daysBeforeStay: 0, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 0, creditFixedFeeCents: 0 },
      ]),
    },
  } as unknown as Parameters<typeof calculateModificationSettlementOptions>[0]["db"];

  function ibChild() {
    const booking = child();
    return {
      ...booking,
      payment: { ...booking.payment!, source: PaymentSource.INTERNET_BANKING },
    } as unknown as LoadedBookingForModify;
  }

  it("quotes the organiser's card only for a child the organiser paid for BY CARD", async () => {
    const todayAtClub = requireCalendarDate("2026-07-01");
    const card = await calculateModificationSettlementOptions({ reduction: noReductionAgainstUnpaidAsk(-1500),
      booking: child(),
      netChargeCents: -1500,
      db: POLICY_DB,
      todayAtClub,
    });
    expect(card).toMatchObject({ returnsToOrganiser: true, organiserRefundByBankTransfer: false, requiresSettlementMethod: false, accountCreditAmountCents: 0 });

    // #3949 review round 5: an organiser who settled by Internet Banking has the
    // same one disposition - back to the organiser, by a bank-transfer hand-back,
    // on the card tier - and never the joiner's account credit.
    const ib = await calculateModificationSettlementOptions({ reduction: noReductionAgainstUnpaidAsk(-1500),
      booking: ibChild(),
      netChargeCents: -1500,
      db: POLICY_DB,
      todayAtClub,
    });
    expect(ib).toMatchObject({ returnsToOrganiser: true, organiserRefundByBankTransfer: true, requiresSettlementMethod: false, accountCreditAmountCents: 0, accountCreditPercentage: 0 });
    expect(ib?.cardRefundAmountCents).toBe(card?.cardRefundAmountCents);
    // The untiered options (a guest's acceptance) answer the same way.
    const full = calculateFullReductionSettlementOptions({ booking: ibChild(), netChargeCents: -1500, refundableCashCents: 4500, todayAtClub });
    expect(full).toMatchObject({ returnsToOrganiser: true, organiserRefundByBankTransfer: true, requiresSettlementMethod: false, accountCreditAmountCents: 0, cardRefundAmountCents: 1500 });
  });

  it("#3949 review round 5: an Internet Banking organiser child's reduction goes to the organiser by hand - never a card, never the joiner's credit", async () => {
    const IB_OPTIONS = { ...ORGANISER_OPTIONS, organiserRefundByBankTransfer: true };
    const result = await applyPaymentAdjustments(txWithSettlement(CARD_SETTLEMENT), { reduction: noReductionAgainstUnpaidAsk(-1500),
      ...SETTLEMENT_DAY,
      booking: ibChild(),
      priceDiffCents: -1500,
      changeFeeCents: 0,
      settlementOptions: IB_OPTIONS,
    });
    // No Stripe refund and no organiser card reservation: the door raises the
    // organiser's bank-transfer hand-back for `refundAmountCents`
    // (`raiseEditRefundHandBackIfOwed`, payee the organiser).
    expect(result).toMatchObject({ refundAmountCents: 1500, accountCreditAmountCents: 0, pendingRefundAmountCents: 0, hasSucceededPayment: false, organiserChildRefund: null,
      settledAgainstPrimaryInvoice: false, hasIssuedXeroInvoice: true });

    // Electing credit is refused, as on the card twin.
    await expect(
      applyPaymentAdjustments(txWithSettlement(CARD_SETTLEMENT), { reduction: noReductionAgainstUnpaidAsk(-1500),
        ...SETTLEMENT_DAY,
        booking: ibChild(),
        priceDiffCents: -1500,
        changeFeeCents: 0,
        settlementOptions: IB_OPTIONS,
        settlementMethod: "credit",
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("cannot be held as account credit") });
  });

  it("#3949 review round 5: no price change of an Internet Banking organiser child while the group cancel is part-way through, whatever settlement was chosen", async () => {
    for (const [priceDiffCents, settlementMethod] of [[-1500, "credit"], [-1500, "card"], [-1500, undefined], [1000, undefined]] as const) {
      await expect(
        applyPaymentAdjustments(txWithSettlement(null, "CANCELLED"), { reduction: noReductionAgainstUnpaidAsk(priceDiffCents),
          ...SETTLEMENT_DAY,
          booking: ibChild(),
          priceDiffCents,
          changeFeeCents: 0,
          settlementOptions: priceDiffCents < 0 ? { ...ORGANISER_OPTIONS, organiserRefundByBankTransfer: true } : null,
          ...(settlementMethod ? { settlementMethod } : {}),
        }),
        `${priceDiffCents} ${settlementMethod}`,
      ).rejects.toMatchObject({ status: 409, message: GROUP_CANCEL_IN_PROGRESS_PRICE_MESSAGE });
    }
    // Review round 6: each part on its own - a $20 cut with a $20 change fee nets to nothing but is still refused.
    await expect(
      applyPaymentAdjustments(txWithSettlement(null, "CANCELLED"), { reduction: noReductionAgainstUnpaidAsk(0),
        ...SETTLEMENT_DAY, booking: ibChild(), priceDiffCents: -2000, changeFeeCents: 2000 }),
    ).rejects.toMatchObject({ status: 409, message: GROUP_CANCEL_IN_PROGRESS_PRICE_MESSAGE });
    // Once the cancel has claimed the child, or on a live group, it is not this refusal's to answer.
    await expect(
      applyPaymentAdjustments(txWithSettlement(null, "OPEN"), { reduction: noReductionAgainstUnpaidAsk(1000), ...SETTLEMENT_DAY, booking: ibChild(), priceDiffCents: 1000, changeFeeCents: 0 }),
    ).resolves.toBeDefined();
    // Nor is a card-paid child's: its refunds are reserved on the organiser's card, under its own rules.
    await expect(
      applyPaymentAdjustments(txWithSettlement(CARD_SETTLEMENT, "CANCELLED"), { reduction: noReductionAgainstUnpaidAsk(-1500), ...SETTLEMENT_DAY, booking: child(), priceDiffCents: -1500, changeFeeCents: 0, settlementOptions: ORGANISER_OPTIONS }),
    ).resolves.toBeDefined();
  });

  it("refuses a price increase on a child the organiser paid for by card, before the edit commits", async () => {
    // An ask here would charge the JOINER for a booking the organiser paid for,
    // and its transaction row would make the next reconcile wipe the child's
    // refunded total - the 10000 paid / 4000 refunded / +1000 sequence that
    // re-promised the 4000 to a later cancellation.
    await expect(
      applyPaymentAdjustments(txWithSettlement(CARD_SETTLEMENT), { reduction: noReductionAgainstUnpaidAsk(1000),
        ...SETTLEMENT_DAY,
        booking: child(),
        priceDiffCents: 1000,
        changeFeeCents: 0,
      }),
    ).rejects.toBeInstanceOf(OrganiserChildRefundRefusedError);

    // The Internet Banking child keeps its supplementary-invoice path.
    const ib = await applyPaymentAdjustments(txWithSettlement(null), { reduction: noReductionAgainstUnpaidAsk(1000),
      ...SETTLEMENT_DAY,
      booking: ibChild(),
      priceDiffCents: 1000,
      changeFeeCents: 0,
    });
    expect(ib.additionalAsk.amountCents).toBe(0);
    expect(ib.additionalAmountCents).toBe(1000);
    expect(ib.settledAgainstPrimaryInvoice).toBe(false);
  });

  it("refuses an organiser bank edit with no combined invoice before mutating its payment", async () => {
    const tx = txWithSettlement(null);
    vi.mocked(tx.groupBooking.findUnique).mockResolvedValue(null);
    await expect(applyPaymentAdjustments(tx, { reduction: noReductionAgainstUnpaidAsk(1000),
      ...SETTLEMENT_DAY, booking: ibChild(), priceDiffCents: 1000, changeFeeCents: 0,
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("combined invoice is not on record") });
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
  });

  it("the quote shows the refusal the save would meet for an increase, and only for an organiser card child (fix round 2, F3)", () => {
    expect(organiserChildChargeRefusal({ booking: child(), netChargeCents: 1000 })).toBe(ORGANISER_CHILD_CHARGE_REFUSAL);
    expect(organiserChildChargeRefusal({ booking: child(), netChargeCents: -1000 })).toBeNull();
    expect(organiserChildChargeRefusal({ booking: child(), netChargeCents: 0 })).toBeNull();
    expect(organiserChildChargeRefusal({ booking: ibChild(), netChargeCents: 1000 })).toBeNull();
    expect(
      organiserChildChargeRefusal({
        booking: child({ organiserSettled: false, parentBookingId: null }),
        netChargeCents: 1000,
      }),
    ).toBeNull();
    // The quote route answers with the SAME predicate the save refuses on.
    const quote = readFileSync(resolve(REPO_ROOT, "src/app/api/bookings/[id]/modify-quote/route.ts"), "utf8");
    expect(quote).toContain("chargeRefusal: organiserChildChargeRefusal({ booking, netChargeCents }),");
  });

  it("#3949 review round 6: the quote shows the mid-group-cancel refusal the save would meet, from the save's own answer", async () => {
    const store = (groupStatus: string) => ({ groupBooking: { findUnique: vi.fn(async () => ({ status: groupStatus })) } }) as never;
    const change = { priceDiffCents: -1500, changeFeeCents: 0 };
    expect(await organiserBankChildPriceChangeRefusal(store("CANCELLED"), ibChild(), change)).toBe(GROUP_CANCEL_IN_PROGRESS_PRICE_MESSAGE);
    expect(await organiserBankChildPriceChangeRefusal(store("CANCELLED"), ibChild(), { priceDiffCents: -2000, changeFeeCents: 2000 })).toBe(GROUP_CANCEL_IN_PROGRESS_PRICE_MESSAGE);
    expect(await organiserBankChildPriceChangeRefusal(store("CANCELLED"), ibChild(), { priceDiffCents: 0, changeFeeCents: 0 })).toBeNull();
    expect(await organiserBankChildPriceChangeRefusal(store("OPEN"), ibChild(), change)).toBeNull();
    expect(await organiserBankChildPriceChangeRefusal(store("CANCELLED"), child(), change)).toBeNull();
    // The quote answers with that function, and the edit panel keeps Save off while it is set.
    const quote = readFileSync(resolve(REPO_ROOT, "src/app/api/bookings/[id]/modify-quote/route.ts"), "utf8");
    expect(quote).toContain("priceChangeRefusal: await organiserBankChildPriceChangeRefusal(prisma, booking, { priceDiffCents, changeFeeCents })");
    const panel = readFileSync(resolve(REPO_ROOT, "src/components/edit-booking-panel.tsx"), "utf8");
    expect(panel).toContain("Boolean(quote.priceChangeRefusal)");
  });

  it("a joiner's organiser-card booking a reduction partly refunded still takes the paid cancel path (fix round 2, F1)", async () => {
    // The executor writes an organiser child's refunds onto its mirror; the
    // child has NO transaction row. Without the organiser rule the gate asks the
    // ledger, finds nothing and sends the cancel down the no-refund branch.
    const noLedger = {
      paymentTransaction: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as Parameters<typeof paymentEligibleForPaidCancelPath>[1];
    const partlyRefunded = {
      id: "payment_1",
      status: PaymentStatus.PARTIALLY_REFUNDED,
      source: PaymentSource.STRIPE,
      // The mirror the pre-ledger STRIPE half of the capture evidence would trust; this gate never does (#1491).
      refundedAmountCents: 1_000,
    };
    await expect(
      paymentEligibleForPaidCancelPath(
        { organiserSettled: true, parentBookingId: "organiser_booking", payment: partlyRefunded },
        noLedger,
      ),
    ).resolves.toBe(true);
    // An ordinary booking in that shape is the mirror-only legacy row (#1491).
    await expect(
      paymentEligibleForPaidCancelPath(
        { organiserSettled: false, parentBookingId: null, payment: partlyRefunded },
        noLedger,
      ),
    ).resolves.toBe(false);
    // #3949 review H1: nor does one the organiser paid for by Internet Banking, whose
    // mirror a paid-back hand-back left partly refunded: read as unpaid, the cancel
    // would flip the organiser's share FAILED.
    await expect(
      paymentEligibleForPaidCancelPath(
        {
          organiserSettled: true,
          parentBookingId: "organiser_booking",
          payment: { ...partlyRefunded, source: PaymentSource.INTERNET_BANKING },
        },
        noLedger,
      ),
    ).resolves.toBe(true);
    // An ordinary Internet Banking booking in that shape is still the ledger's to answer.
    await expect(
      paymentEligibleForPaidCancelPath(
        { organiserSettled: false, parentBookingId: null, payment: { ...partlyRefunded, source: PaymentSource.INTERNET_BANKING } },
        noLedger,
      ),
    ).resolves.toBe(false);
    // Fully refunded is never eligible, organiser child or not.
    await expect(
      paymentEligibleForPaidCancelPath(
        { organiserSettled: true, parentBookingId: "organiser_booking", payment: { ...partlyRefunded, status: PaymentStatus.REFUNDED } },
        noLedger,
      ),
    ).resolves.toBe(false);
  });

  it("#3949 review H1: an Internet Banking organiser child's mirror is capture evidence, refunded in full or not; an ordinary one's is not", async () => {
    const noLedger = { paymentTransaction: { findFirst: vi.fn().mockResolvedValue(null) } } as unknown as Parameters<typeof paymentHasCaptureEvidence>[1];
    const child = (status: PaymentStatus, organiserSettled = true) => ({
      organiserSettled,
      parentBookingId: organiserSettled ? "organiser_booking" : null,
      payment: { id: "payment_1", source: PaymentSource.INTERNET_BANKING, status, refundedAmountCents: 1500 },
    });
    for (const status of [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED]) {
      await expect(paymentHasCaptureEvidence(child(status), noLedger), status).resolves.toBe(true);
    }
    await expect(paymentHasCaptureEvidence(child(PaymentStatus.PENDING), noLedger)).resolves.toBe(false);
    // The folded never-paid Internet Banking mirror (#3630) is still not cash.
    await expect(paymentHasCaptureEvidence(child(PaymentStatus.PARTIALLY_REFUNDED, false), noLedger)).resolves.toBe(false);
  });

  it("every door that settles an edit through applyPaymentAdjustments writes the child's refund debt before it commits", () => {
    for (const door of [
      "src/lib/booking-batch-modification-service.ts",
      "src/lib/booking-date-modification-service.ts",
      "src/lib/booking-guest-removal-service.ts",
    ]) {
      const source = readFileSync(resolve(REPO_ROOT, door), "utf8");
      expect(source, door).toContain("await applyPaymentAdjustments(tx,");
      expect(source, door).toMatch(/await reserveOrganiserChildModificationRefund\(tx, \{\s+plan: \w+\.organiserChildRefund,/);
      expect(source, door).toMatch(/organiserChildRefund: \w+\.organiserChildRefund,/);
    }
  });
});

describe("a reopened organiser child refund waits out Stripe's key window (fix round 2, F2)", () => {
  // The retry re-sends the SAME idempotency key, and inside its 24 hours Stripe
  // answers with the original, now-failed refund: a retry there can only fail
  // and spend the budget. So the reopened debt is next due after the window.
  const created = Date.parse("2026-07-01T00:00:00.000Z") / 1000;

  it("is not due until the key has left the 24-hour window, with a margin", () => {
    const now = new Date("2026-07-01T00:05:00.000Z");
    const due = reopenedRetryAt({ created }, now);
    expect(due.getTime()).toBeGreaterThan(created * 1000 + 24 * 60 * 60 * 1000);
    expect(due.toISOString()).toBe("2026-07-02T01:00:00.000Z");
  });

  it("is due now once the window has already passed", () => {
    const now = new Date("2026-07-05T00:00:00.000Z");
    expect(reopenedRetryAt({ created }, now)).toEqual(now);
  });
});
