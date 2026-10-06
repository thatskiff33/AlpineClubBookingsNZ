"use client";

import type { ReactNode } from "react";

import { Label } from "@/components/ui/label";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import { formatStayDate } from "@/lib/club-time";
import type { ClubFormat } from "@/lib/club-format";

/**
 * #3750: the parts of a locked-period change-request card that exist because
 * approving a request on a FINISHED stay applies it (owner decision, 6 Oct
 * 2026) rather than acknowledging it. Kept beside the panel rather than in it so
 * the panel's own decision flow stays readable.
 */

/** The nights an executed approval would overbook, awaiting the officer's confirmation. */
export type OverCapacityNight = { date: string; availableBeds: number };

/** Where a reduction goes when the policy offers a choice; "card" is back the way it was paid. */
export type FinishedStaySettlementMethod = "card" | "credit";

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
        onChange={(event) => onChange(event.target.value === "credit" ? "credit" : "card")}
      >
        <option value="card">Refund the way it was paid</option>
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
