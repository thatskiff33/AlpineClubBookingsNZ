"use client";

import type { ComponentType } from "react";

import type { ButtonProps } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import { BookingNoEmailsNotice } from "@/components/booking-no-emails-notice";
import {
  FinishedStaySettlementField,
  OfficerGuestEntry,
  officerGuestsPayload,
  requestStay,
} from "@/components/admin/booking-requests/booking-change-request-finished-stay";
import type {
  BookingChangeRequestData,
  DecisionDraft,
} from "@/components/admin/booking-requests/booking-change-request-panel-model";
import type { AgeTierOption } from "@/lib/use-age-tier-options";
import type { OfficerEnteredGuest } from "@/lib/booking-change-request-guests";
import type { ChangeRequestPromoChange } from "@/lib/booking-change-request-promo";

/**
 * What the officer enters on a finished stay's change-request card before
 * approving it: the guests a free-text request described (#4030 Part B), the
 * promo code the member should have had (#4533), whether a promo-only
 * correction emails the member, and where a reduction goes. Split out of
 * `booking-change-requests-panel.tsx` so that file holds the decision flow.
 */

/**
 * One card's entry as the approval and its quote send it: the guests and the
 * promo code (each null when none), and whether approving would be a
 * promo-only correction — the request's own promo change is its one change, or
 * it names nothing and the officer entered only a code — the one shape whose
 * email the officer may withhold. The executor asks the same question under its
 * locks and refuses otherwise.
 */
export function officerEntryOf(
  request: BookingChangeRequestData,
  draft: DecisionDraft,
): {
  officerGuests: OfficerEnteredGuest[] | null;
  officerPromo: ChangeRequestPromoChange | null;
  promoOnly: boolean;
  /** What an applying approval adds to its body for this entry. */
  approvalFields: {
    officerGuests?: OfficerEnteredGuest[];
    officerPromo?: ChangeRequestPromoChange;
    notifyMember?: false;
  };
} {
  const officerGuests = request.acceptsOfficerGuests
    ? officerGuestsPayload(draft.officerGuests, requestStay(request.booking))
    : null;
  const officerPromo = request.acceptsOfficerPromo ? officerPromoPayload(draft.officerPromoCode) : null;
  const promoOnly = request.promoCorrection
    ? request.promoCorrection.onlyChange
    : Boolean(request.acceptsOfficerGuests && officerPromo && !officerGuests);
  // #2259: with the booking's "No emails" switch on there is no choice to
  // send — the mailer withholds the email and records it on the withheld list,
  // which `notifyMember: false` would skip. Otherwise the choice travels only
  // where the executor honours it, a promo-only correction.
  const notifyMember = request.booking.noEmails ? undefined : promoOnly && !draft.notifyMember ? false : undefined;
  return {
    officerGuests,
    officerPromo,
    promoOnly,
    approvalFields: {
      ...(officerGuests ? { officerGuests } : {}),
      ...(officerPromo ? { officerPromo } : {}),
      ...(notifyMember === false ? { notifyMember } : {}),
    },
  };
}

/**
 * The card's entry fields, in order. `onDraftChange` patches this card's own
 * draft; `clearsFigures` says the change makes the checked figures stale, as a
 * changed guest list or code does (#4030 review M1).
 */
export function FinishedStayEntryFields({
  request,
  draft,
  canEdit,
  onDraftChange,
  ageTierOptions,
  memberGuestFind,
  ActionButton,
}: {
  request: BookingChangeRequestData;
  draft: DecisionDraft;
  canEdit: boolean;
  onDraftChange: (patch: Partial<DecisionDraft>, clearsFigures: boolean) => void;
  ageTierOptions: AgeTierOption[];
  memberGuestFind: { openSearchEnabled: boolean } | null;
  /** The panel's own view-only button, so its section banner covers these controls. */
  ActionButton: ComponentType<ButtonProps>;
}) {
  const { promoOnly } = officerEntryOf(request, draft);
  return (
    <>
      {request.acceptsOfficerGuests ? (
        <OfficerGuestEntry
          requestId={request.id}
          bookingId={request.booking.id}
          stay={requestStay(request.booking)}
          guests={draft.officerGuests}
          onChange={(officerGuests) => onDraftChange({ officerGuests }, true)}
          ageTierOptions={ageTierOptions}
          memberGuestFind={memberGuestFind}
          existingMemberIds={(request.booking.guests ?? []).flatMap((guest) => (guest.memberId ? [guest.memberId] : []))}
          canEdit={canEdit}
          ActionButton={ActionButton}
        />
      ) : null}
      {request.acceptsOfficerPromo ? (
        <OfficerPromoEntry
          requestId={request.id}
          code={draft.officerPromoCode}
          canEdit={canEdit}
          onChange={(officerPromoCode) => onDraftChange({ officerPromoCode }, true)}
        />
      ) : null}
      {request.executesOnApproval && promoOnly ? (
        <FinishedStayNotifyChoice
          requestId={request.id}
          noEmails={request.booking.noEmails === true}
          notifyMember={draft.notifyMember}
          canEdit={canEdit}
          onChange={(notifyMember) => onDraftChange({ notifyMember }, false)}
        />
      ) : null}
      {request.executesOnApproval ? (
        <FinishedStaySettlementField
          requestId={request.id}
          value={draft.settlementMethod}
          canEdit={canEdit}
          onChange={(settlementMethod) => onDraftChange({ settlementMethod }, false)}
        />
      ) : null}
    </>
  );
}

/**
 * #4533: on a finished stay's request that names no promo code, the officer may
 * enter the one the member should have had — a missed free night, say. The code
 * is applied exactly as Edit Booking applies it: the same eligibility, the same
 * caps, the same refusal when it does not apply. The figures check shows the
 * reduction before approving.
 */
export function OfficerPromoEntry({
  requestId,
  code,
  onChange,
  canEdit,
}: {
  requestId: string;
  code: string;
  onChange: (code: string) => void;
  canEdit: boolean;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-sm">
      <Label htmlFor={`officer-promo-${requestId}`}>Promo code to apply (optional)</Label>
      <p className="text-xs text-muted-foreground">
        If the member should have had a promo code on this stay — a free night
        assigned to them, say — enter it here. Approving records it on the
        request as entered by you on the member&rsquo;s behalf, applies it
        exactly as Edit Booking would (who it is assigned to and its limits
        still apply), counts it as used, and settles the reduction.
      </p>
      <Input
        id={`officer-promo-${requestId}`}
        value={code}
        maxLength={50}
        disabled={!canEdit}
        title={canEdit === false ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Promo code"
        autoComplete="off"
      />
    </div>
  );
}

/** #4533: the officer's promo entry as the approval sends it, or null when none. */
export function officerPromoPayload(code: string): ChangeRequestPromoChange | null {
  const trimmed = code.trim();
  return trimmed ? { promoCode: trimmed } : null;
}

/**
 * #4533: the officer's notify-or-not choice, offered only on a promo-only
 * correction — a guest or date change always emails the member (#4030). With
 * the booking's "No emails" switch on, the choice is not offered (#2259): the
 * mailer withholds the email either way, and the shared notice says so.
 */
export function FinishedStayNotifyChoice({
  requestId,
  noEmails,
  notifyMember,
  canEdit,
  onChange,
}: {
  requestId: string;
  noEmails: boolean;
  notifyMember: boolean;
  canEdit: boolean;
  onChange: (notifyMember: boolean) => void;
}) {
  return !noEmails ? (
    <div className="flex items-start gap-2 text-sm">
      <Checkbox
        id={`notify-member-${requestId}`}
        className="mt-0.5"
        checked={notifyMember}
        disabled={!canEdit}
        title={canEdit === false ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
        onCheckedChange={onChange}
      />
      <Label htmlFor={`notify-member-${requestId}`}>Apply and email member about the correction</Label>
    </div>
  ) : (
    <BookingNoEmailsNotice />
  );
}
