"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import { formatStayDate } from "@/lib/club-time";
import type { ClubFormat } from "@/lib/club-format";
import type { OverCapacityNight } from "@/lib/over-capacity-confirmation";
import { formatCents } from "@/lib/utils";

/**
 * #3750: the parts of a locked-period change-request card that exist because
 * approving a request on a FINISHED stay applies it (owner decision, 6 Oct
 * 2026) rather than acknowledging it. Kept beside the panel rather than in it so
 * the panel's own decision flow stays readable.
 */

export type { OverCapacityNight };

/**
 * Where a reduction goes. "" is the default — back the way the booking was
 * paid, decided by the server from the payment (P2 on #3955); the officer may
 * choose card or credit instead.
 */
export type FinishedStaySettlementMethod = "" | "card" | "credit";

/** The dry-run figures the quote route returns (P2 on #3955). */
export type FinishedStayQuoteFigures = {
  priceDiffCents: number;
  changeFeeCents: number;
  additionalAmountCents: number;
  refundAmountCents: number;
  accountCreditAmountCents: number;
  capacityOverridden: boolean;
  settlementMethod: "card" | "credit";
};

/** One card's quote: the figures, and the answers they were computed for. */
export type FinishedStayQuote = {
  figures: FinishedStayQuoteFigures | null;
  forSettlementMethod: FinishedStaySettlementMethod;
  confirmOverCapacity: boolean;
  overCapacityNights: OverCapacityNight[] | null;
  loading: boolean;
};

const EMPTY_QUOTE: FinishedStayQuote = {
  figures: null,
  forSettlementMethod: "",
  confirmOverCapacity: false,
  overCapacityNights: null,
  loading: false,
};

/**
 * Per-card quotes, keyed by request id like the decision drafts, so one card's
 * figures or overbooking warning never arm another card's approval.
 */
export function useFinishedStayQuotes(onError: (message: string) => void) {
  const [quotes, setQuotes] = useState<Record<string, FinishedStayQuote>>({});
  const patch = (id: string, next: Partial<FinishedStayQuote>) =>
    setQuotes((current) => ({
      ...current,
      [id]: { ...(current[id] ?? EMPTY_QUOTE), ...next },
    }));
  async function requestQuote(
    id: string,
    answers: { settlementMethod: FinishedStaySettlementMethod; confirmOverCapacity: boolean },
  ) {
    patch(id, { loading: true, figures: null });
    try {
      const response = await fetch(`/api/admin/booking-change-requests/${id}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(answers.settlementMethod ? { settlementMethod: answers.settlementMethod } : {}),
          ...(answers.confirmOverCapacity ? { confirmOverCapacity: true } : {}),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        patch(id, {
          loading: false,
          overCapacityNights:
            data.needsCapacityConfirmation === true && Array.isArray(data.nightDetails)
              ? data.nightDetails
              : null,
        });
        onError(data.error || "Could not work out the figures for this change");
        return;
      }
      patch(id, {
        loading: false,
        figures: data.quote as FinishedStayQuoteFigures,
        forSettlementMethod: answers.settlementMethod,
        confirmOverCapacity: answers.confirmOverCapacity,
        overCapacityNights: null,
      });
    } catch {
      patch(id, { loading: false });
      onError("Could not work out the figures for this change");
    }
  }
  return {
    quoteFor: (id: string): FinishedStayQuote | undefined => quotes[id],
    requestQuote,
    /** An approval answered over capacity after its quote: ask again. */
    needsCapacity: (id: string, nights: OverCapacityNight[]) =>
      patch(id, { figures: null, overCapacityNights: nights }),
    clear: (id: string) =>
      setQuotes((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      }),
  };
}

/** Whether a card's quote still describes what approving would do. */
export function quoteIsCurrent(
  quote: FinishedStayQuote | undefined,
  settlementMethod: FinishedStaySettlementMethod,
): quote is FinishedStayQuote & { figures: FinishedStayQuoteFigures } {
  return Boolean(quote?.figures) && quote?.forSettlementMethod === settlementMethod;
}

/** The figures, shown before the officer approves (P2 on #3955). */
export function FinishedStayQuoteSummary({
  quote,
  current,
  format,
  canEdit,
  onCheck,
}: {
  quote: FinishedStayQuote | undefined;
  current: boolean;
  format: ClubFormat;
  canEdit: boolean;
  onCheck: () => void;
}) {
  const figures = current ? quote?.figures : null;
  const money = (cents: number) => formatCents(cents, format);
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted p-3 text-sm">
      {figures ? (
        <ul className="space-y-1" aria-label="What approving will do">
          <li>Price change: {money(figures.priceDiffCents)}</li>
          <li>Change fee: {money(figures.changeFeeCents)}</li>
          {figures.additionalAmountCents > 0 ? (
            <li>The member will be asked for {money(figures.additionalAmountCents)}</li>
          ) : null}
          {figures.refundAmountCents > 0 ? (
            <li>
              Refund {money(figures.refundAmountCents)}{" "}
              {figures.settlementMethod === "credit" ? "" : "the way it was paid"}
            </li>
          ) : null}
          {figures.accountCreditAmountCents > 0 ? (
            <li>Account credit {money(figures.accountCreditAmountCents)}</li>
          ) : null}
          {figures.capacityOverridden ? <li>Overbooks the lodge on a past night</li> : null}
        </ul>
      ) : (
        <p className="text-muted-foreground">
          Check the figures before approving: the change fee, and the refund or
          amount due, worked out exactly as approving will.
        </p>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!canEdit || quote?.loading === true}
        title={canEdit === false ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
        onClick={onCheck}
      >
        {figures ? "Check again" : "Check the figures"}
      </Button>
    </div>
  );
}

/**
 * Owner D1 (7 Oct 2026): the guests a request adds, with a link to any member
 * among them, so the officer sees who the member rules will be applied to.
 */
export function RequestedGuestAdds({
  guests,
  returnTo,
}: {
  guests: ReadonlyArray<{ firstName: string; lastName: string; memberId?: string | null }> | undefined;
  returnTo: (href: string) => string;
}) {
  if (!guests || guests.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-muted-foreground" aria-label="Guests this request adds">
      {guests.map((guest, index) => (
        <li key={`${guest.firstName}-${guest.lastName}-${index}`}>
          Adds {guest.firstName} {guest.lastName}
          {guest.memberId ? (
            <>
              {" "}
              — member (
              <Link
                className="text-info-11 hover:underline"
                href={returnTo(`/admin/members/${guest.memberId}`)}
              >
                open member
              </Link>
              ); the member guest rules and any consent step apply
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const selectClasses =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/** What approving does, said before the officer clicks. */
export function FinishedStayApprovalNotice() {
  return (
    <p className="text-xs text-muted-foreground">
      This stay has finished, so approving applies the request to the booking:
      the guests and dates it asks for are changed, added guests are priced at
      the stay&rsquo;s season rates, and the member is emailed the change with
      any amount due (card or internet banking). Adding guests carries no change
      fee. A removal is refunded at the cancellation policy&rsquo;s same-day
      tier; a swap is charged that tier&rsquo;s share of the removed guests as a
      change fee, as if they had been removed on their own, and the added guests
      in full. Any refund goes back the way it was paid unless you choose
      account credit below. If the booking has changed since the
      request was made, nothing is applied and the request stays pending.
    </p>
  );
}

export function FinishedStaySettlementField({
  requestId,
  value,
  canEdit,
  onChange,
}: {
  requestId: string;
  value: FinishedStaySettlementMethod;
  canEdit: boolean;
  onChange: (value: FinishedStaySettlementMethod) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={`settlement-method-${requestId}`}>If the change lowers the price</Label>
      <select
        id={`settlement-method-${requestId}`}
        className={selectClasses}
        value={value}
        disabled={!canEdit}
        title={canEdit === false ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
        onChange={(event) =>
          onChange(
            event.target.value === "credit" ? "credit" : event.target.value === "card" ? "card" : "",
          )
        }
      >
        <option value="">The way the booking was paid (default)</option>
        <option value="card">Refund to the card, or by bank transfer</option>
        <option value="credit">Hold it as account credit</option>
      </select>
    </div>
  );
}

/**
 * Decision 3: an over-capacity past night is applied only once the officer
 * confirms it. The confirming button is the panel's own `ViewOnlyActionButton`,
 * passed in, so the section banner that covers every gated control on the panel
 * covers it too.
 */
export function OverCapacityConfirmation({
  nights,
  format,
  confirmButton,
}: {
  nights: OverCapacityNight[];
  format: ClubFormat;
  confirmButton: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="space-y-2 rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11"
    >
      <p>
        Applying this change puts the lodge over capacity
        {nights.length > 0
          ? ` on ${nights.map((night) => formatStayDate(night.date, format)).join(", ")}`
          : ""}
        . Confirm only if these guests really stayed those nights.
      </p>
      {confirmButton}
    </div>
  );
}

/**
 * An approved request with no linked modification on a finished stay predates
 * approvals that apply the change; the booking page cannot apply it either.
 */
export function FinishedStayUnlinkedNote() {
  return (
    <p className="mt-2 text-warning-11">
      No booking modification linked. This request was acknowledged without
      changing the booking, and the stay has finished, so the booking page cannot
      apply it. A correction now has to be handled outside this queue.
    </p>
  );
}

/** The toast after a successful decision. */
export function decisionToastMessage(args: {
  status: "APPROVED" | "REJECTED";
  execution: { executed?: boolean; followUpFailed?: boolean } | undefined;
  linkedModificationId: string;
}): string {
  if (args.status !== "APPROVED") return "Request rejected";
  if (args.execution?.executed) {
    return args.execution.followUpFailed
      ? "Request approved and applied to the booking, but some follow-up work (the payment request, the member's email or Xero) did not complete. Check the booking."
      : "Request approved and applied to the booking. The member is emailed the change and any amount due.";
  }
  return args.linkedModificationId
    ? "Request approved and linked to the booking modification."
    : "Request acknowledged as approved. Apply the actual change on the booking page if it is still required.";
}
