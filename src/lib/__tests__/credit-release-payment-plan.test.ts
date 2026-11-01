import { PaymentSource, PaymentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { planCreditReleasePayments, type AskLedgerRow } from "@/lib/credit-release-payment-plan";
import {
  CREDIT_RELEASE_ASK_REASON,
} from "@/lib/credit-release-ask-keys";

/*
  #4253 (`INV-ADDPAY-045`): which card captures paid for credit-release money, and
  how much of each. Synthetic amounts only; every assertion is over integer cents.
*/

let counter = 0;
function row(over: Partial<AskLedgerRow> & { amountCents: number }): AskLedgerRow {
  counter += 1;
  return {
    id: `row-${counter}`,
    source: PaymentSource.STRIPE,
    status: PaymentStatus.PENDING,
    reason: CREDIT_RELEASE_ASK_REASON,
    carriedAskCents: 0,
    withdrawnAt: null,
    stripePaymentIntentId: `pi_${counter}`,
    ...over,
  };
}

describe("planCreditReleasePayments", () => {
  it("records a captured credit-release request in full", () => {
    const captured = row({ amountCents: 4000, status: PaymentStatus.SUCCEEDED });
    expect(planCreditReleasePayments([captured]).items).toEqual([
      { askRowId: captured.id, ownCents: 4000, capturedByRowId: captured.id, capturedByIntentId: captured.stripePaymentIntentId },
    ]);
  });

  it("records nothing for a request that has not been paid", () => {
    expect(planCreditReleasePayments([row({ amountCents: 4000 })])).toEqual({ items: [], unexplainedRowIds: [], unexplainedCaptureIntentIds: [] });
  });

  it("records nothing for a withdrawn or fully refunded request", () => {
    const withdrawn = row({ amountCents: 4000, status: PaymentStatus.FAILED, withdrawnAt: new Date("2026-07-01") });
    const refunded = row({ amountCents: 4000, status: PaymentStatus.REFUNDED });
    expect(planCreditReleasePayments([withdrawn, refunded]).items).toEqual([]);
  });

  it("does not guess at a partly refunded capture: it is held for an officer", () => {
    const captured = row({ amountCents: 4000, status: PaymentStatus.PARTIALLY_REFUNDED });
    expect(planCreditReleasePayments([captured])).toEqual({
      items: [],
      unexplainedRowIds: [captured.id],
      unexplainedCaptureIntentIds: [captured.stripePaymentIntentId],
    });
  });

  it("leaves a plain edit request to its own supplementary invoice", () => {
    const edit = row({ amountCents: 4000, status: PaymentStatus.SUCCEEDED, reason: null });
    expect(planCreditReleasePayments([edit])).toEqual({ items: [], unexplainedRowIds: [], unexplainedCaptureIntentIds: [] });
  });

  it("an edit after the release absorbs it: only the released part is recorded against the booking invoice", () => {
    // Release asks 4000; an edit then asks 3000 of its own and carries the unpaid 4000: the card pays 7000.
    const release = row({ amountCents: 4000 });
    const edit = row({ amountCents: 7000, carriedAskCents: 4000, reason: null, status: PaymentStatus.SUCCEEDED });
    const plan = planCreditReleasePayments([release, edit]);
    expect(plan.items).toEqual([
      { askRowId: release.id, ownCents: 4000, capturedByRowId: edit.id, capturedByIntentId: edit.stripePaymentIntentId },
    ]);
    // The edit's own 3000 is not in the plan: its supplementary invoice carries it.
    expect(plan.items.reduce((sum, item) => sum + item.ownCents, 0)).toBe(4000);
  });

  it("a release after an edit carries the edit's unpaid ask: only its own money is recorded", () => {
    const edit = row({ amountCents: 3000, reason: null });
    const release = row({ amountCents: 7000, carriedAskCents: 3000, status: PaymentStatus.SUCCEEDED });
    const plan = planCreditReleasePayments([edit, release]);
    expect(plan.items.map((item) => [item.askRowId, item.ownCents])).toEqual([[release.id, 4000]]);
  });

  it("#4491: a merged request (a release carrying an edit) partly refunded is held for an officer, never guessed at", () => {
    const edit = row({ amountCents: 3000, reason: null, status: PaymentStatus.FAILED });
    const release = row({ amountCents: 7000, carriedAskCents: 3000, status: PaymentStatus.PARTIALLY_REFUNDED });
    expect(planCreditReleasePayments([edit, release])).toEqual({
      items: [],
      unexplainedRowIds: [release.id],
      unexplainedCaptureIntentIds: [release.stripePaymentIntentId],
    });
  });

  it("a second release absorbing the first records each release's own money once", () => {
    const first = row({ amountCents: 4000 });
    const second = row({ amountCents: 6500, carriedAskCents: 4000, status: PaymentStatus.SUCCEEDED });
    const plan = planCreditReleasePayments([first, second]);
    expect(plan.items.map((item) => [item.askRowId, item.ownCents])).toEqual([
      [first.id, 4000],
      [second.id, 2500],
    ]);
  });

  it("does not guess when a later request did not carry the earlier one in full", () => {
    const release = row({ amountCents: 4000 });
    const edit = row({ amountCents: 5000, carriedAskCents: 1000, reason: null, status: PaymentStatus.SUCCEEDED });
    const plan = planCreditReleasePayments([release, edit]);
    expect(plan.items).toEqual([]);
    expect(plan.unexplainedRowIds).toEqual([release.id]);
    expect(plan.unexplainedCaptureIntentIds).toEqual([edit.stripePaymentIntentId]);
  });

  it("never reads bank cash as a card payment", () => {
    const release = row({ amountCents: 4000 });
    const cash = row({ amountCents: 4000, source: PaymentSource.INTERNET_BANKING, status: PaymentStatus.SUCCEEDED, stripePaymentIntentId: null, reason: null });
    expect(planCreditReleasePayments([release, cash]).items).toEqual([]);
  });

  it("a capture ends the chain: a later release is planned on its own", () => {
    const paid = row({ amountCents: 4000, status: PaymentStatus.SUCCEEDED });
    const later = row({ amountCents: 1500, status: PaymentStatus.SUCCEEDED });
    expect(planCreditReleasePayments([paid, later]).items.map((item) => [item.askRowId, item.ownCents])).toEqual([
      [paid.id, 4000],
      [later.id, 1500],
    ]);
  });
});
