"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { renderExistingGuestConsentHelper } from "@/components/edit-booking/guest-consent-notes";
import { shiftDateOnly } from "@/components/edit-booking/stay-nights";
import type { Guest } from "@/components/edit-booking/types";
import { getAgeTierLabel, type AgeTierOption } from "@/lib/use-age-tier-options";
import type { MemberGuestCandidate } from "@/lib/member-guest-find";
import { formatCents } from "@/lib/utils";
import { useClubFormat } from "@/components/club-format-provider";

/**
 * One guest already on the booking.
 *
 * Moved out of `edit-booking-panel.tsx` (#2690). The row still decides its own
 * five gates from the values handed to it, exactly as the map callback did:
 * whether the name is editable, whether only a typo may be fixed, whether a
 * placeholder may be linked to a member, and what the remove control is called.
 */
export function ExistingGuestRow({
  guest,
  isRemoved,
  linkedMember,
  memberLinkEnabled,
  nonMemberGuestNamesEditable,
  canEditNonMemberGuestNames,
  canFixNonMemberGuestNameTypos,
  overrideEnabled,
  isInProgressEdit,
  perGuestDatesEnabled,
  canRemove,
  nameEdit,
  range,
  checkIn,
  checkOut,
  bookingCheckIn,
  bookingCheckOut,
  ageTierOptions,
  onUpdateName,
  onUpdateRange,
  onRemove,
  onUndoRemove,
  onStartLink,
  onUnlink,
  otherLodgeRate,
  quotedPriceCents,
}: {
  guest: Guest;
  isRemoved: boolean;
  linkedMember: MemberGuestCandidate | undefined;
  memberLinkEnabled: boolean;
  nonMemberGuestNamesEditable: boolean;
  canEditNonMemberGuestNames: boolean;
  canFixNonMemberGuestNameTypos: boolean;
  overrideEnabled: boolean;
  isInProgressEdit: boolean;
  perGuestDatesEnabled: boolean;
  /** False under an override, and on the last remaining person on the booking. */
  canRemove: boolean;
  nameEdit: { firstName: string; lastName: string };
  range: { stayStart: string; stayEnd: string };
  checkIn: string;
  checkOut: string;
  bookingCheckIn: string;
  bookingCheckOut: string;
  ageTierOptions: AgeTierOption[];
  onUpdateName: (field: "firstName" | "lastName", value: string) => void;
  onUpdateRange: (field: "stayStart" | "stayEnd", value: string) => void;
  onRemove: () => void;
  onUndoRemove: () => void;
  /**
   * Other Lodges epic: this row's other-club rate tick. Undefined when the
   * viewer is not offered the control at all (a member, an override edit, an
   * in-progress edit), which is what keeps their row byte-identical to before.
   * `offered: false` is the other half — a MEMBER row inside an offered card,
   * which gets an empty tick column so the names stay in one line.
   */
  otherLodgeRate?: {
    offered: boolean;
    enabled: boolean;
    checked: boolean;
    onChange: (checked: boolean) => void;
  };
  /**
   * The fee the pending edit would write for this guest, from the quote.
   * Undefined until a quote lands, and on an in-progress edit — the row then
   * shows the stored fee, which is what it always showed.
   */
  quotedPriceCents?: number;
  onStartLink: () => void;
  onUnlink: () => void;
}) {
  const format = useClubFormat();
  // #2337: this placeholder's pending member link, if any.
  const isLinked = Boolean(linkedMember);
  // Only an unlinked, unremoved placeholder on a member whole-lodge
  // booking may be linked — the same fence the server enforces.
  const canLinkGuest =
    memberLinkEnabled && !guest.isMember && !isRemoved && !isLinked;
  const canEditGuestName =
    nonMemberGuestNamesEditable &&
    !guest.isMember &&
    !isRemoved &&
    !isLinked &&
    !overrideEnabled;
  // Fully paid: the field is open only for a spelling correction; a
  // change of who the booking is for must go through the office (#1386).
  const showTypoOnlyHint =
    canEditGuestName &&
    !canEditNonMemberGuestNames &&
    canFixNonMemberGuestNameTypos;

  return (
    <div
      className={`flex items-center justify-between py-2 ${
        isRemoved ? "opacity-40 line-through" : ""
      }`}
    >
      {/*
        Other Lodges epic: the other-club rate tick, in its own column to the
        LEFT of the name so the ticks line up down the list rather than hiding
        at the end of names of different lengths.

        A MEMBER row renders the column EMPTY rather than skipping it: dropping
        the box would shift that one name left and break the column the ticks
        are here to form. `aria-label` names the person, because a bare
        checkbox in a list of people is unreadable to a screen reader.
      */}
      {otherLodgeRate ? (
        <div className="flex w-8 shrink-0 items-center justify-center self-start pt-1">
          {otherLodgeRate.offered ? (
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={otherLodgeRate.checked}
              disabled={!otherLodgeRate.enabled}
              onChange={(e) => otherLodgeRate.onChange(e.target.checked)}
              aria-label={`Price ${guest.firstName} ${guest.lastName} at the other-lodge member rate`}
            />
          ) : null}
        </div>
      ) : null}
      {/*
        `flex-1` so the name block takes the space the new tick column leaves,
        keeping the fee hard against the right edge. Without it `justify-between`
        spreads THREE children and the name drifts into the middle of the row.
      */}
      <div className="flex-1">
        {canEditGuestName ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor={`guest-${guest.id}-first`} className="text-xs">
                First Name
              </Label>
              <Input
                id={`guest-${guest.id}-first`}
                value={nameEdit.firstName}
                onChange={(e) => onUpdateName("firstName", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`guest-${guest.id}-last`} className="text-xs">
                Last Name
              </Label>
              <Input
                id={`guest-${guest.id}-last`}
                value={nameEdit.lastName}
                onChange={(e) => onUpdateName("lastName", e.target.value)}
              />
            </div>
            {showTypoOnlyHint ? (
              <p className="col-span-2 text-xs text-muted-foreground">
                Only spelling corrections are allowed after payment.
                To change who this booking is for, contact the office.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="font-medium">
            {guest.firstName} {guest.lastName}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {getAgeTierLabel(ageTierOptions, guest.ageTier)} &middot; {guest.isMember ? "Member" : "Non-member"}
        </p>
        {/* #2337: what saving this link will do, before it is saved. */}
        {isLinked && linkedMember ? (
          <p className="text-sm text-success-11">
            Linking to {linkedMember.firstName} {linkedMember.lastName} —
            re-rated at the member rate. The price change is shown below
            before you save.
          </p>
        ) : null}
        {/*
          MG4 (#2309): the two helper sentences the signed-off mockup
          draws under a member-guest row, and the reason they are not
          decoration. The first tells the booker what pressing the
          control WILL DO before they press it — a still-unanswered
          request is withdrawn, the person is told, and the bed they
          were holding goes back — which is a different act from
          taking a settled guest off, and the person on the other end
          gets a different email for each. The second states both
          halves of MG4-D-a on a row the club placed, including the
          half an officer is most likely to assume away: the member
          was not asked, and they were told anyway.
        */}
        {!isRemoved && renderExistingGuestConsentHelper(guest)}
        {(guest.stayStart && guest.stayStart !== bookingCheckIn) ||
        (guest.stayEnd && guest.stayEnd !== bookingCheckOut) ? (
          <p className="text-xs text-muted-foreground">
            Stay: {guest.stayStart ?? bookingCheckIn} to{" "}
            {guest.stayEnd ?? bookingCheckOut}
          </p>
        ) : null}
        {perGuestDatesEnabled && !isRemoved && !overrideEnabled ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor={`guest-${guest.id}-stay-start`} className="text-xs">
                Date In
              </Label>
              <Input
                id={`guest-${guest.id}-stay-start`}
                type="date"
                value={range.stayStart}
                min={checkIn}
                max={shiftDateOnly(range.stayEnd, -1)}
                onChange={(e) => onUpdateRange("stayStart", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`guest-${guest.id}-stay-end`} className="text-xs">
                Date Out
              </Label>
              <Input
                id={`guest-${guest.id}-stay-end`}
                type="date"
                value={range.stayEnd}
                min={shiftDateOnly(range.stayStart, 1)}
                max={checkOut}
                onChange={(e) => onUpdateRange("stayEnd", e.target.value)}
              />
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        {/*
          The stored fee, or — once the quote has priced this edit — what this
          person WILL be charged, with the old figure struck through beside it.
          Read straight off the quote (never recomputed here), so the number in
          the row and the total in the summary can never disagree.
        */}
        {quotedPriceCents !== undefined &&
        quotedPriceCents !== guest.priceCents ? (
          <span className="text-sm">
            <span className="text-muted-foreground line-through">
              {formatCents(guest.priceCents, format)}
            </span>{" "}
            <span className="font-medium text-success-11">
              {formatCents(quotedPriceCents, format)}
            </span>
          </span>
        ) : (
          <span className="text-sm">{formatCents(guest.priceCents, format)}</span>
        )}
        {/* #2337: link an unnamed placeholder to a member (admin, member
            whole-lodge only). Unlink reverts to the placeholder. */}
        {isLinked ? (
          <Button variant="outline" size="sm" onClick={onUnlink}>
            Unlink
          </Button>
        ) : canLinkGuest ? (
          <Button variant="outline" size="sm" onClick={onStartLink}>
            Link to member
          </Button>
        ) : null}
        {isRemoved ? (
          <Button variant="outline" size="sm" onClick={onUndoRemove}>
            Undo
          </Button>
        ) : (
          canRemove && (
            /*
              DECLARED DIVERGENCE FROM THE SIGNED-OFF MOCKUP (MG4
              #2309), recorded here and stated to the owner in the PR
              rather than left for a reader to notice.

              The mockup draws TWO controls on an unanswered row —
              "Cancel request", which notifies, beside a plain
              "Remove", which does not. This ships ONE control that
              always notifies. A non-notifying Remove on a PENDING row
              would be a silent-disappearance path: the member has an
              email in their inbox asking them a question, a bed is
              held in their name, and the row would vanish with no
              word to them at all. That directly contradicts the
              plan's own §7.1 trigger, which owes a withdrawal notice
              for "a still-PENDING request cancelled by the booker or
              an admin", and it would leave the one population the
              epic exists to protect worse off than before.

              What the mockup's second control was really buying — the
              booker understanding what the first one does — is
              delivered by the helper sentence above instead.
            */
            <Button
              variant="ghost"
              size="sm"
              className="text-danger-11 hover:text-danger-11"
              onClick={onRemove}
            >
              {guest.consent?.tone === "pending"
                ? "Cancel request"
                : isInProgressEdit
                  ? "Remove Future"
                  : "Remove"}
            </Button>
          )
        )}
      </div>
    </div>
  );
}
