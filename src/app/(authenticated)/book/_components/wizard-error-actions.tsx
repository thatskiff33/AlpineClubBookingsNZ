"use client";

import Link from "next/link";
import { ExternalLink, UserMinus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useClubFormat } from "@/components/club-format-provider";
import {
  describeBookingMemberNightConflictBooking,
  describeBookingMemberNightConflictNextStep,
  describeBookingMemberNightConflictNights,
} from "@/lib/booking-member-night-conflict-messages";
import type { useBookingWizard } from "../_hooks/use-booking-wizard";
import {
  BOOKING_EXCEPTION_REQUEST_ID,
  PROFILE_FAMILY_GROUP_RETURN_TO_BOOK,
} from "./types";

type Wizard = ReturnType<typeof useBookingWizard>;

/**
 * Whether the box has anything to offer beyond its sentence. The page asks this
 * to decide whether to render the action slot at all (an always-truthy slot
 * would add an empty gap under every message), so it sits beside the sections
 * it counts: a new action is added to both in one file.
 */
export function hasWizardErrorActions({
  lodgeUnresolved,
  guestProfileBlocks,
  memberNightConflicts,
  errorPaymentTargets,
  exceptionOffered,
}: Pick<
  Wizard,
  | "lodgeUnresolved"
  | "guestProfileBlocks"
  | "memberNightConflicts"
  | "errorPaymentTargets"
> & { exceptionOffered: boolean }): boolean {
  return (
    lodgeUnresolved ||
    guestProfileBlocks.length > 0 ||
    memberNightConflicts.length > 0 ||
    errorPaymentTargets.length > 0 ||
    exceptionOffered
  );
}

/**
 * What a refused booking offers the member to do about it (#4945): retry the
 * lodge lookup, fix a guest's profile, deal with a member-night conflict, or
 * pay a subscription. It is the body of the wizard's one error box
 * (`FocusedActionError` in `page.tsx`), moved here so the page stays the shell
 * that wires the wizard together. The box owns the `role="alert"` region and
 * the focus; nothing here is a live region of its own.
 */
export function WizardErrorActions({
  lodgeUnresolved,
  retryLodgeOptions,
  guestProfileBlocks,
  getGuestProfileBlockMessage,
  getGuestProfileActionLabel,
  memberNightConflicts,
  handleRemoveConflictGuest,
  removingConflictGuestId,
  errorPaymentTargets,
  exceptionOffered,
}: {
  lodgeUnresolved: Wizard["lodgeUnresolved"];
  retryLodgeOptions: Wizard["retryLodgeOptions"];
  guestProfileBlocks: Wizard["guestProfileBlocks"];
  getGuestProfileBlockMessage: Wizard["getGuestProfileBlockMessage"];
  getGuestProfileActionLabel: Wizard["getGuestProfileActionLabel"];
  memberNightConflicts: Wizard["memberNightConflicts"];
  handleRemoveConflictGuest: Wizard["handleRemoveConflictGuest"];
  removingConflictGuestId: Wizard["removingConflictGuestId"];
  errorPaymentTargets: Wizard["errorPaymentTargets"];
  /** The refusal is one a Booking Officer can allow, so the request card is on the review step. */
  exceptionOffered: boolean;
}) {
  const format = useClubFormat();
  return (
    <div className="space-y-3">
      {/*
        #4945: a reviewable refusal puts its reason here and its remedy, the
        request form, further down the review step. Without a pointer the
        member reads the reason and has no sign that anything can be done.
      */}
      {exceptionOffered && (
        <p>
          You can ask a Booking Officer to allow this.{" "}
          <a
            href={`#${BOOKING_EXCEPTION_REQUEST_ID}`}
            className="font-medium underline underline-offset-4"
          >
            Go to the request
          </a>
        </p>
      )}
      {/*
        #2701: the booking was refused because no lodge could be determined.
        The lodge selector is NOT on screen in that state — an empty list
        makes `LodgeSelect` render nothing — so "try again" needs something
        to try again with, or it is advice the member cannot act on.
      */}
      {lodgeUnresolved && (
        <div>
          <Button variant="outline" onClick={retryLodgeOptions}>
            Try again
          </Button>
        </div>
      )}
      {guestProfileBlocks.length > 0 && (
        <div className="space-y-3">
          {guestProfileBlocks.map((block) => {
            const actionLabel = getGuestProfileActionLabel(block);
            return (
              <div
                key={block.memberId}
                className="rounded-md border border-danger-6 bg-card p-3"
              >
                <p className="font-medium text-danger-11">{block.name}</p>
                <p className="mt-1">{getGuestProfileBlockMessage(block)}</p>
                {block.missingFields.length > 0 && (
                  <p className="mt-1 text-danger-11">
                    Missing: {block.missingFields.join(", ")}
                  </p>
                )}
                {actionLabel && (
                  block.action === "complete_details" && block.canCurrentUserResolve ? (
                    <Link
                      href={PROFILE_FAMILY_GROUP_RETURN_TO_BOOK}
                      className="mt-2 inline-flex text-sm font-medium text-danger-11 underline underline-offset-4"
                    >
                      {actionLabel}
                    </Link>
                  ) : (
                    <p className="mt-2 font-medium text-danger-11">{actionLabel}</p>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
      {memberNightConflicts.length > 0 && (
        <div className="space-y-3">
          {memberNightConflicts.map((conflict) => (
            <div
              // #2250: an unentitled row carries no booking or guest id, so
              // the key falls back to what every row always has.
              key={
                conflict.guestId ??
                `${conflict.memberId}-${conflict.conflictingNights[0]}`
              }
              className="rounded-md border border-danger-6 bg-card p-3"
            >
              <p className="font-medium text-danger-11">
                {conflict.memberName}
              </p>
              {/* #2250: which nights, and — only for a viewer the server
                  marked canOpenBooking — whose booking it is. A member
                  adding a guest who turns out to be on a stranger's
                  booking learns the nights are taken, not whose booking
                  took them. */}
              <p className="mt-1">
                {[
                  describeBookingMemberNightConflictNights(conflict, format),
                  describeBookingMemberNightConflictBooking(conflict),
                ]
                  .filter(Boolean)
                  .join(" ")}
              </p>
              {/* #2250: the next step is always stated, not only when no
                  button is available — a member who has never seen "Remove
                  me from this booking" needs telling what it does, so it
                  sits ABOVE the buttons it describes. This is the booking
                  wizard, the one surface whose reader is actually choosing
                  the dates, so it is also the one place allowed to offer
                  "choose different dates" (the admin booking-request routes
                  return the same 409 and cannot). */}
              <p className="mt-2 text-danger-11">
                {describeBookingMemberNightConflictNextStep(conflict, {
                  canChooseDifferentDates: true,
                })}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {conflict.canOpenBooking && conflict.bookingId && (
                  <Button
                    asChild
                    size="sm"
                    variant="outline"
                    className="border-danger-6 text-danger-11 hover:bg-danger-3"
                  >
                    <Link href={`/bookings/${conflict.bookingId}`}>
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Open booking
                    </Link>
                  </Button>
                )}
                {conflict.canSelfRemove && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="border-danger-6 text-danger-11 hover:bg-danger-3"
                    onClick={() => void handleRemoveConflictGuest(conflict)}
                    disabled={removingConflictGuestId === conflict.guestId}
                  >
                    <UserMinus className="mr-2 h-4 w-4" />
                    {removingConflictGuestId === conflict.guestId
                      ? "Removing..."
                      : "Remove me from this booking"}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {errorPaymentTargets.length > 0 && (
        <div className="space-y-2">
          {errorPaymentTargets.map((target) => (
            <div key={`${target.name}-${target.invoiceNumber ?? target.invoiceUrl ?? "none"}`}>
              {target.invoiceUrl ? (
                <a
                  href={target.invoiceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="app-button-brand"
                >
                  {target.name === "Your subscription"
                    ? "Pay Your Subscription"
                    : `Pay ${target.name}'s Subscription`}
                </a>
              ) : target.invoiceNumber ? (
                <p className="text-sm">
                  {target.name}: invoice reference{" "}
                  <strong>{target.invoiceNumber}</strong> — check your email from Xero for the payment link.
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
