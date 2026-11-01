import { describe, expect, it } from "vitest";

import { isSwitchableToInternetBanking } from "@/lib/booking-payment-flow";
import { resolveBookingDetailPayment } from "../_lib/booking-detail-payment";

/*
  #4019 — the switch-to-Internet-Banking door on an approved
  member whole-lodge booking.

  The approval leaves the payment method to the member when the Internet
  Banking and Xero modules are both on: the booking is CONFIRMED and held, owes
  its whole price, and carries NO Payment row. The booking page must therefore
  offer it the ordinary Complete Payment card AND the switch button, which it
  used to withhold from every status but PAYMENT_PENDING. The rule is shared
  with the switch route (`isSwitchableToInternetBanking`), so this suite pins
  the rule once and the page's use of it once.
*/

const modulesOn = {
  xeroIntegration: true,
  internetBankingPayments: true,
} as unknown as Parameters<typeof resolveBookingDetailPayment>[0]["modules"];

const ownerViewer = {
  canManageBooking: true,
  isBookingOwner: true,
  nonOwnerAdminViewer: false,
  canSeeOwnerCredit: true,
} as unknown as Parameters<typeof resolveBookingDetailPayment>[0]["viewer"];

const liveAccess = { isDeleted: false } as unknown as Parameters<
  typeof resolveBookingDetailPayment
>[0]["access"];

const noLinkedParty = {
  hasProvisionalChildren: false,
  isProvisionalChild: false,
  isFlaggedProvisional: false,
} as unknown as Parameters<typeof resolveBookingDetailPayment>[0]["party"];

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-wl",
    status: "CONFIRMED",
    wholeLodgeHold: true,
    organiserSettled: false,
    finalPriceCents: 30000,
    payment: null,
    creditsFromCancellation: [],
    refundRequests: [],
    manualRefundTasks: [],
    parentBooking: null,
    deletedAt: null,
    ...overrides,
  } as unknown as Parameters<typeof resolveBookingDetailPayment>[0]["booking"];
}

describe("isSwitchableToInternetBanking", () => {
  it("admits PAYMENT_PENDING, and CONFIRMED only with a whole-lodge hold", () => {
    expect(isSwitchableToInternetBanking({ status: "PAYMENT_PENDING" })).toBe(true);
    expect(
      isSwitchableToInternetBanking({ status: "CONFIRMED", wholeLodgeHold: true }),
    ).toBe(true);
    expect(
      isSwitchableToInternetBanking({ status: "CONFIRMED", wholeLodgeHold: false }),
    ).toBe(false);
    expect(isSwitchableToInternetBanking({ status: "CONFIRMED" })).toBe(false);
    for (const status of ["PENDING", "DRAFT", "PAID", "CANCELLED", "AWAITING_REVIEW"]) {
      expect(
        isSwitchableToInternetBanking({ status, wholeLodgeHold: true }),
        status,
      ).toBe(false);
    }
  });
});

describe("the booking page's pay doors on an approved whole-lodge booking", () => {
  it("opens the Complete Payment card and the Internet Banking switch", () => {
    const payment = resolveBookingDetailPayment({
      booking: booking(),
      modules: modulesOn,
      viewer: ownerViewer,
      access: liveAccess,
      party: noLinkedParty,
      amountOwed: { owedCents: 30000, dueCents: 30000, appliedCreditCents: 0 },
    });
    expect(payment.showCompletePaymentCard).toBe(true);
    expect(payment.canSwitchToInternetBanking).toBe(true);
    expect(payment.internetBankingPayment).toBeNull();
  });

  it("closes the switch once the member has chosen Internet Banking", () => {
    const payment = resolveBookingDetailPayment({
      booking: booking({
        payment: {
          source: "INTERNET_BANKING",
          status: "PENDING",
          amountCents: 30000,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          transactions: [],
          _count: { transactions: 0 },
          recoveryOperations: [],
          refunds: [],
          manualRefundTasks: [],
          changeFeeCents: 0,
        },
      }),
      modules: modulesOn,
      viewer: ownerViewer,
      access: liveAccess,
      party: noLinkedParty,
      amountOwed: { owedCents: 30000, dueCents: 30000, appliedCreditCents: 0 },
    });
    expect(payment.showCompletePaymentCard).toBe(false);
    expect(payment.canSwitchToInternetBanking).toBe(false);
    expect(payment.internetBankingPayment).not.toBeNull();
  });

  it("keeps the switch closed on a CONFIRMED booking without a hold, and with either module off", () => {
    const noHold = resolveBookingDetailPayment({
      booking: booking({ wholeLodgeHold: false }),
      modules: modulesOn,
      viewer: ownerViewer,
      access: liveAccess,
      party: noLinkedParty,
      amountOwed: { owedCents: 30000, dueCents: 30000, appliedCreditCents: 0 },
    });
    expect(noHold.canSwitchToInternetBanking).toBe(false);

    for (const modules of [
      { xeroIntegration: false, internetBankingPayments: true },
      { xeroIntegration: true, internetBankingPayments: false },
    ]) {
      const payment = resolveBookingDetailPayment({
        booking: booking(),
        modules: modules as unknown as typeof modulesOn,
        viewer: ownerViewer,
        access: liveAccess,
        party: noLinkedParty,
        amountOwed: { owedCents: 30000, dueCents: 30000, appliedCreditCents: 0 },
      });
      expect(payment.canSwitchToInternetBanking, JSON.stringify(modules)).toBe(false);
    }
  });

  it("never offers the switch to a non-owner admin viewing the booking", () => {
    const payment = resolveBookingDetailPayment({
      booking: booking(),
      modules: modulesOn,
      viewer: {
        canManageBooking: false,
        isBookingOwner: false,
        nonOwnerAdminViewer: true,
        canSeeOwnerCredit: false,
      } as unknown as typeof ownerViewer,
      access: liveAccess,
      party: noLinkedParty,
      amountOwed: { owedCents: 30000, dueCents: 30000, appliedCreditCents: 0 },
    });
    expect(payment.canSwitchToInternetBanking).toBe(false);
    expect(payment.showCompletePaymentCard).toBe(false);
  });
});
