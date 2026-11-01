"use client";

import Link from "next/link";
import { useRef, useState, type ComponentType, type ReactNode } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import { calendarDateOfDateOnlyInstant, formatStayDate } from "@/lib/club-time";
import {
  ChangeRequestGuestEntry,
  changeRequestGuestsPayload,
} from "@/components/booking/change-request-guest-entry";
import { adminMemberGuestFindEndpoints } from "@/components/book/member-guest-find-panel";
import type { NewGuest } from "@/components/edit-booking/types";
import type { AgeTierOption } from "@/lib/use-age-tier-options";
import type {
  ChangeRequestStay,
  OfficerEnteredGuest,
} from "@/lib/booking-change-request-guests";
import type { ChangeRequestPromoChange } from "@/lib/booking-change-request-promo";
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
  /** #4030 / #4533: the officer's entry (guests and promo, as sent) the figures were computed for. */
  forOfficerEntry: string;
  confirmOverCapacity: boolean;
  overCapacityNights: OverCapacityNight[] | null;
  loading: boolean;
};

const EMPTY_QUOTE: FinishedStayQuote = {
  figures: null,
  forSettlementMethod: "",
  forOfficerEntry: "",
  confirmOverCapacity: false,
  overCapacityNights: null,
  loading: false,
};

/**
 * #4030 Part B: the guests an officer has entered on one card — and, #4533, the
 * promo code — as the approval and its quote send them ("" when none). The
 * same string keys the quote, so figures computed for one entry never arm an
 * approval of another.
 */
export function officerEntryKey(
  guests: readonly OfficerEnteredGuest[] | null,
  promo: ChangeRequestPromoChange | null = null,
): string {
  const hasGuests = Boolean(guests && guests.length > 0);
  if (!hasGuests && !promo) return "";
  return JSON.stringify({ guests: hasGuests ? guests : null, promo });
}

/**
 * Per-card quotes, keyed by request id like the decision drafts, so one card's
 * figures or overbooking warning never arm another card's approval.
 */
export function useFinishedStayQuotes(onError: (message: string) => void) {
  const [quotes, setQuotes] = useState<Record<string, FinishedStayQuote>>({});
  // Per-card generation (#4030 re-review of 72c933ffc): bumped by every new
  // quote and every `clear`, so a reply that lands after either is dropped and
  // cannot re-create figures or an overbooking confirmation for a list the
  // officer has since changed.
  const generations = useRef<Record<string, number>>({});
  const bump = (id: string) => {
    generations.current[id] = (generations.current[id] ?? 0) + 1;
    return generations.current[id];
  };
  const patch = (id: string, next: Partial<FinishedStayQuote>) =>
    setQuotes((current) => ({
      ...current,
      [id]: { ...(current[id] ?? EMPTY_QUOTE), ...next },
    }));
  async function requestQuote(
    id: string,
    answers: {
      settlementMethod: FinishedStaySettlementMethod;
      confirmOverCapacity: boolean;
      /** #4030: the officer's entry, when the card takes one. */
      officerGuests?: OfficerEnteredGuest[] | null;
      /** #4533: the officer's promo code, when the card takes one. */
      officerPromo?: ChangeRequestPromoChange | null;
    },
  ) {
    const generation = bump(id);
    const stale = () => generations.current[id] !== generation;
    patch(id, { loading: true, figures: null });
    const forOfficerEntry = officerEntryKey(answers.officerGuests ?? null, answers.officerPromo ?? null);
    try {
      const response = await fetch(`/api/admin/booking-change-requests/${id}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(answers.settlementMethod ? { settlementMethod: answers.settlementMethod } : {}),
          ...(answers.confirmOverCapacity ? { confirmOverCapacity: true } : {}),
          ...(answers.officerGuests?.length ? { officerGuests: answers.officerGuests } : {}),
          ...(answers.officerPromo ? { officerPromo: answers.officerPromo } : {}),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (stale()) return;
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
        forOfficerEntry,
        confirmOverCapacity: answers.confirmOverCapacity,
        overCapacityNights: null,
      });
    } catch {
      if (stale()) return;
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
    clear: (id: string) => {
      bump(id);
      setQuotes((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
    },
  };
}

/**
 * #4030 review C4: the money figures an approval sends as what it was shown.
 * The Approve button is enabled only with current figures, so this is never
 * undefined when it is sent; the server refuses an applying approval without it.
 */
export function expectedFiguresOf(quote: FinishedStayQuote | undefined) {
  const figures = quote?.figures;
  return figures
    ? {
        additionalAmountCents: figures.additionalAmountCents,
        refundAmountCents: figures.refundAmountCents,
        accountCreditAmountCents: figures.accountCreditAmountCents,
      }
    : undefined;
}

/** Whether a card's quote still describes what approving would do. */
export function quoteIsCurrent(
  quote: FinishedStayQuote | undefined,
  settlementMethod: FinishedStaySettlementMethod,
  /** #4030 / #4533: `officerEntryKey` of the entry on screen. */
  officerEntry: string,
): quote is FinishedStayQuote & { figures: FinishedStayQuoteFigures } {
  return (
    Boolean(quote?.figures) &&
    quote?.forSettlementMethod === settlementMethod &&
    quote?.forOfficerEntry === officerEntry
  );
}

/**
 * #4030 Part B: on a request that names no change of its own (a member's
 * free-text note), the officer enters the guests the member described — the
 * guest editor's fields, nights inside the stay — before checking the figures.
 * Approving stores them on the request as entered on the member's behalf and
 * applies them exactly as a member's own request is applied.
 */
export function OfficerGuestEntry({
  requestId,
  bookingId,
  stay,
  guests,
  onChange,
  ageTierOptions,
  memberGuestFind,
  existingMemberIds,
  canEdit,
  ActionButton,
}: {
  requestId: string;
  bookingId: string;
  stay: ChangeRequestStay;
  /** Members already on the booking: the finder disables rather than hides them. */
  existingMemberIds: readonly string[];
  guests: NewGuest[];
  onChange: (guests: NewGuest[]) => void;
  ageTierOptions: AgeTierOption[];
  memberGuestFind: { openSearchEnabled: boolean } | null;
  canEdit: boolean;
  /** The panel's own view-only button, so its section banner covers these controls. */
  ActionButton: ComponentType<ButtonProps>;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-sm">
      <p className="font-medium text-foreground">Guests the member asked to add</p>
      <p className="text-xs text-muted-foreground">
        This request names nobody, so nothing can be applied or charged from it
        as it stands. Enter the guests the member described, with the nights each
        stayed. Approving records them on the request as entered by you on the
        member&rsquo;s behalf, adds and prices them, and emails the member the
        change and the amount due.
      </p>
      <ChangeRequestGuestEntry
        idPrefix={`officer-guest-${requestId}`}
        guests={guests}
        onChange={onChange}
        ageTierOptions={ageTierOptions}
        stay={stay}
        existingMemberIds={existingMemberIds}
        memberFind={
          memberGuestFind
            ? { ...memberGuestFind, endpoints: adminMemberGuestFindEndpoints(bookingId) }
            : null
        }
        disabled={!canEdit}
        // #4030 review S6: the queue's own view-only pattern - the panel's
        // section banner explains, and its view-only button is passed in (as
        // the overbooking confirmation's is), each field carrying the reason.
        ActionButton={ActionButton}
        inputTitle={ADMIN_VIEW_ONLY_ACTION_REASON}
      />
    </div>
  );
}

/** #4030: the officer's rows as the approval sends them, or null when none. */
export function officerGuestsPayload(
  guests: readonly NewGuest[],
  stay: ChangeRequestStay,
): OfficerEnteredGuest[] | null {
  return guests.length > 0 ? changeRequestGuestsPayload(guests, stay) : null;
}

/** The calendar days a panel row's booking runs over (`yyyy-MM-dd`). */
export function requestStay(booking: { checkIn: string; checkOut: string }): ChangeRequestStay {
  return {
    checkIn: calendarDateOfDateOnlyInstant(new Date(booking.checkIn)),
    checkOut: calendarDateOfDateOnlyInstant(new Date(booking.checkOut)),
  };
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
      fee. Whatever the change removes — guests, or nights trimmed off a guest
      who stays — is charged the cancellation policy&rsquo;s same-day share as a
      change fee, paid or unpaid, and is never netted against guests added in
      its place; the rest comes back in full, the way it was paid unless you
      choose account credit below. A promo code applied this way carries no
      change fee, and its reduction comes back in full as account credit unless
      you choose a refund. Check the figures before approving. If the booking has changed since the
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
  execution:
    | {
        executed?: boolean;
        followUpFailed?: boolean;
        officerEnteredGuestCount?: number;
        promoCodesApplied?: string[];
        memberEmailWithheld?: boolean;
      }
    | undefined;
  linkedModificationId: string;
}): string {
  if (args.status !== "APPROVED") return "Request rejected";
  if (args.execution?.executed) {
    // #4533: a promo correction says what it applied and whether the member hears.
    if (args.execution.promoCodesApplied?.length && !args.execution.followUpFailed) {
      return `Promo code ${args.execution.promoCodesApplied.join(", ")} applied to the booking and the request approved.${
        args.execution.memberEmailWithheld === true
          ? " The member was not emailed."
          : " The member is emailed the change."
      }`;
    }
    if (args.execution.officerEnteredGuestCount && !args.execution.followUpFailed) {
      return "Guests recorded on the member's behalf, and the request approved and applied to the booking. The member is emailed the change and any amount due.";
    }
    return args.execution.followUpFailed
      ? "Request approved and applied to the booking, but some follow-up work (the payment request, the member's email or Xero) did not complete. Check the booking."
      : "Request approved and applied to the booking. The member is emailed the change and any amount due.";
  }
  return args.linkedModificationId
    ? "Request approved and linked to the booking modification."
    : "Request acknowledged as approved. Apply the actual change on the booking page if it is still required.";
}
