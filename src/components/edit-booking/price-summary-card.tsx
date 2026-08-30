"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";
import type { PromoAction } from "@/components/edit-booking/hooks/use-promo-selection";
import type { PromoInfo, QuoteResult } from "@/components/edit-booking/types";

/**
 * What this edit costs, and everything the club owes the member an explanation
 * for before they press Save.
 *
 * Moved out of `edit-booking-panel.tsx` (#2690) as pure presentation, with every
 * gate and every `role="status"` preserved exactly.
 *
 * THE CONVENTION FOR THIS CARD (#2390 review): every advisory that appears on
 * its own when a quote comes back — not in response to a click — carries
 * `role="status"`, so a screen-reader user hears it without hunting for it. That
 * covers the minimum-stay notice, the subscription-rate notice, the
 * group-discount note and both promo notices. The over-capacity block is
 * deliberately excluded: it contains the confirm checkbox the member must
 * operate, and announcing a form control as a live status reads as noise.
 */
export function PriceSummaryCard({
  quote,
  quoteLoading,
  quoteError,
  bookingFinalPriceCents,
  promo,
  promoAction,
  overCapacityConfirmActive,
  overCapacityNightList,
  confirmOverCapacity,
  showQuoteSummary,
  ledgerAppliedCreditCents,
  useCredit,
  desiredElectionCents,
  actingAsAdmin,
  settlementMethod,
  onConfirmOverCapacityChange,
  onSettlementMethodChange,
}: {
  quote: QuoteResult | null;
  quoteLoading: boolean;
  quoteError: string;
  bookingFinalPriceCents: number;
  promo: PromoInfo | null;
  promoAction: PromoAction;
  overCapacityConfirmActive: boolean;
  overCapacityNightList: { date: string; availableBeds: number }[];
  confirmOverCapacity: boolean;
  showQuoteSummary: boolean;
  ledgerAppliedCreditCents: number;
  useCredit: boolean;
  desiredElectionCents: number;
  actingAsAdmin: boolean;
  settlementMethod: "card" | "credit" | null;
  onConfirmOverCapacityChange: (checked: boolean) => void;
  onSettlementMethodChange: (method: "card" | "credit") => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Price Summary</CardTitle>
          {quoteLoading && quote && (
            <span className="text-sm font-normal text-muted-foreground">Updating…</span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {quoteLoading && !quote && (
          <p className="text-sm text-muted-foreground">Calculating price changes...</p>
        )}

        {quoteError && (
          <div className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">{quoteError}</div>
        )}

        {quote && !quote.capacityAvailable && !overCapacityConfirmActive && (
          <div className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">
            <p className="font-medium">
              {quote.partnerSharedReason ?? "Not enough beds available"}
            </p>
            {quote.nightDetails && (
              <ul className="mt-1 list-disc pl-4">
                {quote.nightDetails
                  .filter((n) => n.availableBeds < 0)
                  .map((n) => (
                    <li key={n.date}>
                      {n.date}: {Math.abs(n.availableBeds)} bed(s) short
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}

        {/* #2124: advisory whole-stay minimum-stay warning — an early,
            client-side heads-up that never gates Save. #2363: the hard
            block is on the server. PUT /api/bookings/[id]/modify now
            refuses a non-admin save that breaks the rule and returns the
            frozen review, which handleSave surfaces in the save-error slot
            below; an admin edit (including on-behalf) is not blocked. Save
            stays enabled here on purpose — the server is authoritative, so
            a stale or missing quote can never decide the outcome. */}
        {quote && quote.minimumStayValid === false && (
          <div
            className="rounded-md bg-warning-3 p-3 text-sm text-warning-11"
            role="status"
          >
            <p className="font-medium">
              This change would leave your stay under a minimum-stay rule
            </p>
            <ul className="mt-1 list-disc pl-4">
              {(quote.minimumStayViolations ?? []).map((violation, i) => (
                <li key={i}>{violation.message}</li>
              ))}
            </ul>
          </div>
        )}

        {/* #2543 "tell them why": under the club's NON_MEMBER_PRICING mode a
            member on this booking has an unpaid subscription, so their
            nights are re-rated at non-member rates. Said here, above the
            totals, because the New price below is the repriced figure and a
            member who sees it move without explanation reads it as a bug.

            The sentence is the SERVER's, rendered verbatim, and is read
            straight off `quote` rather than copied into its own state — so a
            later quote that returns null (the subscription was paid, or the
            repriced guest was removed from the edit) drops the notice with
            the quote it came from, and a refused or failed quote clears it
            along with everything else via `setQuote(null)`. Gated only on
            `quote`, like the minimum-stay warning beside it, so it survives a
            render where capacity hides the money summary. */}
        {quote?.subscriptionMemberRateNotice ? (
          <div
            className="rounded-md bg-warning-3 p-3 text-sm text-warning-11"
            role="status"
            data-testid="subscription-member-rate-notice"
          >
            {quote.subscriptionMemberRateNotice}
          </div>
        ) : null}

        {/* #3170 (epic #2797) — this edit's money cannot be read from the
            booking's own stored history, so saving will commit the change and
            hold the amount for a person to confirm. Shown in the same slot and
            with the same lifecycle as the two notices around it, and rendered
            VERBATIM: the server owns this sentence, because the words are bound
            by the epic (no estimate, no `$0`, and nothing that reads as the
            member's fault). Every figure above it is the booking's stored one
            and every delta is zero, so there is no number here to explain away
            — which is exactly why the sentence has to be present. */}
        {quote?.financialReviewRequired && quote.financialReviewNotice ? (
          <div
            className="rounded-md bg-info-3 p-3 text-sm text-info-11"
            role="status"
            data-testid="financial-review-required-notice"
          >
            {quote.financialReviewNotice}
          </div>
        ) : null}

        {/* #2770 D2 — "tell them why" for the edit-time group discount
            switch, in the same slot and with the same lifecycle as the
            subscription notice above: gated on `quote` alone so it survives
            a render where capacity hides the money summary, and dropped
            whenever the quote it came from is replaced or cleared. Rendered
            as a plain note rather than a warning, because nothing is wrong
            — it is the club's policy, stated where the officer is reading
            the number it explains. */}
        {quote?.groupDiscountEditNotice ? (
          <div
            className="rounded-md bg-muted p-3 text-sm text-muted-foreground"
            role="status"
            data-testid="group-discount-edit-notice"
          >
            {quote.groupDiscountEditNotice}
          </div>
        ) : null}

        {overCapacityConfirmActive && (
          <div className="space-y-2 rounded-md bg-warning-3 p-3 text-sm text-warning-11">
            <p className="font-medium">
              These nights are over lodge capacity
            </p>
            {overCapacityNightList.length > 0 && (
              <ul className="list-disc pl-4">
                {overCapacityNightList.map((night) => (
                  <li key={night.date}>
                    {night.date}: {Math.abs(night.availableBeds)} bed(s) over
                  </li>
                ))}
              </ul>
            )}
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={confirmOverCapacity}
                onChange={(e) => onConfirmOverCapacityChange(e.target.checked)}
                className="mt-1 h-4 w-4"
              />
              <span>
                Book over capacity anyway — I understand this overbooks the
                lodge.
              </span>
            </label>
          </div>
        )}

        {showQuoteSummary && quote && (
          <div className="space-y-3">
            {/* Itemized changes */}
            <div className="space-y-1">
              {quote.itemizedChanges.map((item, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{item.label}</span>
                  <span
                    className={`font-medium ${
                      item.amountCents > 0
                        ? "text-danger-11"
                        : item.amountCents < 0
                          ? "text-success-11"
                          : ""
                    }`}
                  >
                    {item.amountCents > 0 ? "+" : ""}
                    {formatCents(item.amountCents)}
                  </span>
                </div>
              ))}
            </div>

            {/* Totals */}
            <div className="border-t pt-2 space-y-1">
              <div className="flex justify-between text-sm">
                <span>Current price</span>
                <span>{formatCents(bookingFinalPriceCents)}</span>
              </div>
              <div className="flex justify-between font-medium">
                <span>New price</span>
                <span>{formatCents(quote.newFinalPriceCents)}</span>
              </div>
              {/* #2266: the mockup's credit lines — what account credit
                  already covers, what the saved election will cover at
                  confirmation, and what is then left to pay.

                  MED-5 honesty: when this edit reprices the booking below
                  the credit already applied, the server clamps the applied
                  slice to the new price and refunds the excess to the
                  member's balance (F20, #1887) — so the panel shows the
                  CLAMPED figure and says where the excess goes, instead of
                  advertising a credit line the save will not keep.

                  LOW-6: the late-notice change fee rides the invoice /
                  additional charge, so "Remaining to pay" includes it —
                  with its own line so the sum is transparent. */}
              {(ledgerAppliedCreditCents > 0 ||
                (useCredit && desiredElectionCents > 0)) &&
                (() => {
                  const displayedAppliedCreditCents = Math.min(
                    ledgerAppliedCreditCents,
                    quote.newFinalPriceCents,
                  );
                  const creditReturnedCents =
                    ledgerAppliedCreditCents - displayedAppliedCreditCents;
                  return (
                    <>
                      {ledgerAppliedCreditCents > 0 && (
                        <div className="flex justify-between text-sm text-success-11">
                          <span>Account credit applied</span>
                          <span>
                            -{formatCents(displayedAppliedCreditCents)}
                          </span>
                        </div>
                      )}
                      {creditReturnedCents > 0 && (
                        <div className="flex justify-between text-sm text-success-11">
                          <span>
                            {actingAsAdmin
                              ? `${formatCents(creditReturnedCents)} returns to the member's account credit`
                              : `${formatCents(creditReturnedCents)} returns to your account credit`}
                          </span>
                          <span />
                        </div>
                      )}
                      {useCredit && desiredElectionCents > 0 && (
                        <div className="flex justify-between text-sm text-success-11">
                          <span>Account credit (when you confirm)</span>
                          <span>-{formatCents(desiredElectionCents)}</span>
                        </div>
                      )}
                      {quote.changeFeeCents > 0 && (
                        <div className="flex justify-between text-sm">
                          <span>Late-notice change fee</span>
                          <span>+{formatCents(quote.changeFeeCents)}</span>
                        </div>
                      )}
                      <div className="flex justify-between font-medium">
                        <span>Remaining to pay</span>
                        <span>
                          {formatCents(
                            Math.max(
                              0,
                              quote.newFinalPriceCents -
                                displayedAppliedCreditCents -
                                (useCredit ? desiredElectionCents : 0),
                            ) + quote.changeFeeCents,
                          )}
                        </span>
                      </div>
                    </>
                  );
                })()}
            </div>

            {/* Net charge/refund */}
            {quote.netChargeCents !== 0 && (
              <div
                className={`rounded-md p-3 text-sm ${
                  quote.netChargeCents > 0
                    ? "bg-danger-3 text-danger-11"
                    : "bg-success-3 text-success-11"
                }`}
              >
                {quote.netChargeCents > 0 ? (
                  <p className="font-medium">
                    Additional charge: {formatCents(quote.netChargeCents)}
                  </p>
                ) : (
                  <p className="font-medium">
                    Booking reduction: {formatCents(Math.abs(quote.netChargeCents))}
                  </p>
                )}
              </div>
            )}

            {quote.netChargeCents < 0 && quote.settlementOptions && (
              <div className="space-y-2 rounded-md border p-3 text-sm">
                <div className="flex items-center justify-between">
                  <p className="font-medium">Return method</p>
                  {/* #2266: direction tag pairing with the credit card's
                      "Credit → booking" — this section is money coming
                      back to the member. */}
                  <span className="rounded-full bg-info-3 px-2 py-0.5 text-xs font-medium text-info-11">
                    Booking → you
                  </span>
                </div>
                {quote.settlementOptions.requiresSettlementMethod ? (
                  <div className="space-y-2">
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="radio"
                        name="settlementMethod"
                        value="card"
                        checked={settlementMethod === "card"}
                        onChange={() => onSettlementMethodChange("card")}
                        className="mt-1"
                      />
                      <span>
                        Refund to original card:{" "}
                        <span className="font-medium">
                          {formatCents(quote.settlementOptions.cardRefundAmountCents)}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          ({quote.settlementOptions.cardRefundPercentage}%)
                        </span>
                      </span>
                    </label>
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="radio"
                        name="settlementMethod"
                        value="credit"
                        checked={settlementMethod === "credit"}
                        onChange={() => onSettlementMethodChange("credit")}
                        className="mt-1"
                      />
                      <span>
                        Hold as account credit:{" "}
                        <span className="font-medium">
                          {formatCents(quote.settlementOptions.accountCreditAmountCents)}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          ({quote.settlementOptions.accountCreditPercentage}%)
                        </span>
                      </span>
                    </label>
                  </div>
                ) : (
                  <p className="text-muted-foreground">
                    No refund or account credit is available for this reduction under the current policy.
                  </p>
                )}
              </div>
            )}

            {!quote.promoStillValid && promoAction.type === "keep" && promo && (
              <div
                className="rounded-md bg-warning-3 p-3 text-sm text-warning-11"
                role="status"
              >
                Your promo code &apos;{promo.code}&apos; is no longer valid and will be removed.
              </div>
            )}

            {/* #2390: the promotion is keeping everyone who already had it
                and simply not reaching the people this edit adds. Said
                here, before Save, because a member who adds two guests and
                silently gets a different rate for one of them reads that as
                a bug. The totals above already include it. */}
            {quote.promoCoverage && promoAction.type === "keep" && (
              <div
                className="rounded-md bg-warning-3 p-3 text-sm text-warning-11"
                role="status"
                data-testid="promo-coverage-notice"
              >
                {quote.promoCoverage.message}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
