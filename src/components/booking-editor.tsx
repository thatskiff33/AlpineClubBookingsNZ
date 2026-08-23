"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EditBookingPanel } from "@/components/edit-booking-panel";
import { formatCents } from "@/lib/utils";
import { bookingStatusClass, bookingStatusLabel } from "@/lib/status-colors";
import { formatNZDate } from "@/lib/nzst-date";
import { parseDateOnly } from "@/lib/date-only";
import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";

// Not one of the shared `nzst-date` helpers (#2264): the two headline stay dates
// are spelled out in full — long weekday, long month — because they are the
// thing the member checks before agreeing to a change, and "Friday 12 June 2026"
// is harder to misread than "Fri, 12 Jun 2026". Zone pinned to club time; the
// values are NZ date-only lodge nights handed over at UTC midnight, so the
// calendar day can no longer slide for a member browsing from overseas.
const STAY_DATE_LONG = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: APP_TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  memberId?: string | null;
  stayStart?: string | null;
  stayEnd?: string | null;
  nights?: string[] | null;
  priceCents: number;
  // Other Lodges epic: true when this NON-MEMBER guest is priced at the club's
  // own member rate as a recognised member of the booking's partner lodge.
  // Optional so pre-existing fixtures stay valid.
  otherLodgeMember?: boolean;
  // #2307 (owner decision MG2-M-2): the member-guest consent badge, composed
  // server-side (`describeMemberGuestConsentBadge`). Absent — not null-valued —
  // for family and non-member rows, which get no badge and no layout change.
  consent?: {
    tone: "pending" | "ok" | "blocked";
    label: string;
    // MG4 (#2309): the classified sub-state, threaded through for the edit
    // panel's helper sentences. Not rendered here — the read view shows only
    // the label — but carried so the panel does not have to guess "the club put
    // this person here" from a tone that also covers an ordinary consent.
    subState?: string | null;
  };
}

const consentBadgeToneClasses: Record<"pending" | "ok" | "blocked", string> = {
  pending: "border-warning-6 bg-warning-3 text-warning-11",
  ok: "border-success-6 bg-success-3 text-success-11",
  blocked: "border-danger-6 bg-danger-3 text-danger-11",
};

interface PromoInfo {
  code: string;
  type: string;
  description: string | null;
  // Set when this discount came from a work party (working bee) event's
  // internal promo rather than a manually entered code.
  workPartyEventName?: string | null;
}

interface EditPolicyInfo {
  mode: "future" | "in-progress" | null;
  today: string;
  editableFrom: string | null;
  checkInEditable: boolean;
  // Issue #1668: an admin may override the date-window locks for this booking.
  // Optional so pre-existing fixtures/serialisers stay valid; the booking page
  // always sets it.
  adminOverrideAvailable?: boolean;
}

export interface BookingEditorData {
  id: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  status: string;
  guests: Guest[];
  viewerRole: string;
  totalPriceCents: number;
  discountCents: number;
  promoAdjustmentCents: number;
  finalPriceCents: number;
  promo: PromoInfo | null;
  hasNonMembers: boolean;
  nonMemberHoldUntil: string | null;
  canEditNonMemberGuestNames: boolean;
  canFixNonMemberGuestNameTypos: boolean;
  editPolicy: EditPolicyInfo;
  // #2104: threaded so the edit panel can skip the proactive justification field
  // for a booking that is already flagged/reviewed (the server only demands a
  // reason on the FIRST no-adult trip).
  requiresAdminReview: boolean;
  adminReviewStatus: string | null;
  // #2259: threaded so the edit panel's admin notify dialog stops offering an
  // email choice the mailer will not honour. Optional so pre-existing fixtures
  // stay valid. Nothing on this member-facing editor renders from it — only
  // the panel's admin-only dialog reads it.
  noEmails?: boolean;
  // #2266: the edit panel's account-credit card. Null when the booking cannot
  // carry a credit election (settled, organiser-settled, or a status no
  // pay-time consumer would honour) — the panel then renders no credit card.
  // Optional so pre-existing fixtures stay valid.
  credit?: {
    availableCents: number;
    electionCents: number | null;
    appliedCents: number;
  } | null;
  // #2266: booking OWNER's member id, for on-behalf promo validation in the
  // shared PromoCodeInput. Optional so pre-existing fixtures stay valid.
  memberId?: string;
  // #2266: the booking's lodge, so promo lodge restrictions validate against
  // the right lodge. Optional so pre-existing fixtures stay valid.
  lodgeId?: string | null;
  // MG4 (#2309): the member-guest add surface's server-computed shape, read on
  // the booking page and threaded here so the edit panel never guesses whether
  // the module is on. Absent — not false-valued — for a club with the module
  // off, so their payload is unchanged.
  memberGuest?: {
    enabled: boolean;
    openSearchEnabled: boolean;
    approvalRequired: boolean;
  };
  // #2337: true for an admin/officer viewing a MEMBER whole-lodge booking — the
  // audience and booking class the placeholder→member link is fenced to.
  // Server-computed on the booking page and threaded through unchanged.
  memberWholeLodge?: boolean;
  // Other Lodges epic: the partner lodge this booking claims, or null. Optional
  // so pre-existing fixtures stay valid.
  otherLodgeId?: string | null;
  // Other Lodges epic: the partner-lodge registry the officer picks from, in
  // name order. ADMIN-ONLY and absent — not empty-valued — for every other
  // viewer, so a member's payload never carries the club list. Its presence is
  // what offers the "Member of Other Lodge" control at all.
  otherLodges?: Array<{ id: string; name: string }>;
  /**
   * #2978: the guests an officer may tick as an other-lodge member - resolved
   * server-side by `resolveOtherLodgeRateEligibleGuestIds`, which is also what
   * the save fences on, so the screen can never offer a tick the save refuses.
   *
   * ADMIN-ONLY, and a conditional spread for the same reason `otherLodges` is:
   * ineligibility can mean "this member's unpaid subscription has repriced
   * them", so shipping it to every viewer would leak subscription standing over
   * the RSC wire.
   */
  otherLodgeRateEligibleGuestIds?: string[];
}


export function BookingEditor({
  booking,
  canModify,
  canAdminOverride = false,
}: {
  booking: BookingEditorData;
  canModify: boolean;
  // Issue #1668: admin override lets an admin open the editor even for a
  // fully-past booking that renders no self-service editor at all.
  canAdminOverride?: boolean;
}) {
  const searchParams = useSearchParams();
  /**
   * #2562: the open policy-exception request this visit is here to REPLACE, from
   * the `?replaceRequest=<id>` link the member's request area renders. Its presence
   * also OPENS the editor, because sending somebody to a page and asking them to
   * find the Edit button is how a replacement never gets made.
   */
  const replaceExceptionRequestId =
    searchParams?.get("replaceRequest")?.trim() || null;
  const [editing, setEditing] = useState(Boolean(replaceExceptionRequestId));
  const canOpenEditor = canModify || canAdminOverride;
  // Capture "now" once at mount so the hold banner can honestly tell a future
  // deadline (future-tense auto-confirm copy) from a lapsed one (awaiting
  // processing copy). Day-scale deadlines make a single snapshot sufficient.
  const [nowMs] = useState(() => Date.now());
  const nonMemberHoldLapsed = booking.nonMemberHoldUntil
    ? new Date(booking.nonMemberHoldUntil).getTime() <= nowMs
    : false;

  if (editing && canOpenEditor) {
    return (
      <EditBookingPanel
        booking={{
          id: booking.id,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          guests: booking.guests,
          viewerRole: booking.viewerRole,
          finalPriceCents: booking.finalPriceCents,
          totalPriceCents: booking.totalPriceCents,
          discountCents: booking.discountCents,
          promoAdjustmentCents: booking.promoAdjustmentCents,
          promo: booking.promo,
          canEditNonMemberGuestNames: booking.canEditNonMemberGuestNames,
          canFixNonMemberGuestNameTypos: booking.canFixNonMemberGuestNameTypos,
          editPolicy: booking.editPolicy,
          requiresAdminReview: booking.requiresAdminReview,
          adminReviewStatus: booking.adminReviewStatus,
          noEmails: booking.noEmails,
          credit: booking.credit,
          memberId: booking.memberId,
          lodgeId: booking.lodgeId,
          memberGuest: booking.memberGuest,
          memberWholeLodge: booking.memberWholeLodge,
          otherLodgeId: booking.otherLodgeId,
          otherLodges: booking.otherLodges,
          otherLodgeRateEligibleGuestIds: booking.otherLodgeRateEligibleGuestIds,
        }}
        canAdminOverride={canAdminOverride}
        replaceExceptionRequestId={replaceExceptionRequestId}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Stay Details */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CardTitle>Stay Details</CardTitle>
              {canOpenEditor && (
                <Button variant="outline" onClick={() => setEditing(true)}>
                  Edit Booking
                </Button>
              )}
            </div>
            <Badge variant="secondary" className={bookingStatusClass(booking.status)}>
              {bookingStatusLabel(booking.status)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Check-in</p>
              <p className="font-medium">
                {STAY_DATE_LONG.format(parseDateOnly(booking.checkIn))}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Check-out</p>
              <p className="font-medium">
                {STAY_DATE_LONG.format(parseDateOnly(booking.checkOut))}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Nights</p>
              <p className="font-medium">{booking.nights}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Guests</p>
              <p className="font-medium">{booking.guests.length}</p>
            </div>
          </div>

          {booking.status === "PENDING" && booking.nonMemberHoldUntil && (
            <div className="rounded-md bg-warning-3 p-3 text-sm text-warning-11">
              {nonMemberHoldLapsed ? (
                <>
                  This booking includes non-members. The hold period ended on{" "}
                  {formatNZDate(new Date(booking.nonMemberHoldUntil))} and it is now
                  awaiting confirmation, payment, or admin processing, subject to
                  availability. Members have priority.
                </>
              ) : (
                <>
                  This booking includes non-members. It will be auto-confirmed on{" "}
                  {formatNZDate(new Date(booking.nonMemberHoldUntil))}, subject to
                  availability. Members have priority.
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Guests */}
      <Card>
        <CardHeader>
          <CardTitle>Guests</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {booking.guests.map((guest) => (
              <div key={guest.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium">
                    {guest.firstName} {guest.lastName}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {guest.ageTier} &middot; {guest.isMember ? "Member" : "Non-member"}
                    {/*
                      Other Lodges epic: somebody the booking officer has
                      recognised as a member of the club's partner lodge, and who
                      is therefore charged this club's member rate. Said here, on
                      the rate category, because this line is the only thing on
                      the read view that explains why the fee beside it is not
                      the one their category would otherwise buy.

                      #2978: the category beside it is deliberately left alone.
                      The tick now reaches people who read "Member" here — a
                      member whose membership TYPE prices them at the non-member
                      rate — and that word is still the truth about their
                      standing in THIS club, which the tick never changes.
                    */}
                    {guest.otherLodgeMember ? " (Other Club Member)" : ""}
                  </p>
                  {(guest.stayStart && guest.stayStart !== booking.checkIn) ||
                  (guest.stayEnd && guest.stayEnd !== booking.checkOut) ? (
                    <p className="text-xs text-muted-foreground">
                      Stay: {guest.stayStart ?? booking.checkIn} to{" "}
                      {guest.stayEnd ?? booking.checkOut}
                    </p>
                  ) : null}
                  {guest.consent ? (
                    <Badge
                      variant="outline"
                      className={`mt-1 ${consentBadgeToneClasses[guest.consent.tone]}`}
                    >
                      {guest.consent.label}
                    </Badge>
                  ) : null}
                </div>
                <p className="font-medium">{formatCents(guest.priceCents)}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Payment */}
      <Card>
        <CardHeader>
          <CardTitle>Payment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span>{formatCents(booking.totalPriceCents)}</span>
          </div>
          {booking.promoAdjustmentCents !== 0 && (
            <div className={`flex justify-between ${booking.promoAdjustmentCents > 0 ? "text-warning-11" : "text-success-11"}`}>
              <span>
                {booking.promo?.workPartyEventName
                  ? "Working bee discount"
                  : "Promo adjustment"}
                {booking.promo?.workPartyEventName ? (
                  <span className="ml-1 text-xs">
                    ({booking.promo.workPartyEventName})
                  </span>
                ) : (
                  booking.promo?.code && (
                    <span className="ml-1 text-xs">({booking.promo.code})</span>
                  )
                )}
              </span>
              <span>
                {booking.promoAdjustmentCents > 0 ? "+" : "-"}
                {formatCents(Math.abs(booking.promoAdjustmentCents))}
              </span>
            </div>
          )}
          <div className="flex justify-between border-t pt-2 font-bold">
            <span>Total</span>
            <span>{formatCents(booking.finalPriceCents)}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
