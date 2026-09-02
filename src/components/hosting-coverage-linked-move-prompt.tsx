"use client";

import {
  formatLinkedMoveMoneySentence,
  linkedMoveAllBookingsPhrase,
  linkedMoveDeclineConsequence,
  linkedMoveHeading,
  type HostingCoverageLinkedMoveChoice,
  type HostingCoverageLinkedMovePromptData,
} from "@/lib/hosting-coverage-linked-move-client";

/**
 * #3232's linked-move offer, as the member sees it.
 *
 * TWO CHOICES AND NO DEFAULT, which is the whole design. Pre-selecting either one
 * would answer a money question on the member's behalf: pre-selecting "move both"
 * charges them for a second booking they may not want moved, and pre-selecting
 * "move only this one" strands a booking on a click they did not think about. So
 * the save button stays disabled until they pick — genuinely, on
 * `activeLinkedMoveState && !linkedMoveChoice` in the panel's `disabled`
 * expression, matching its officer-override arm. This docblock asserted that
 * mechanism before it existed: Save gated on the override state only, and an
 * unanswered offer instead set the panel's BOTTOM error slot, below Save, while
 * the radios sat above it — and that slot had no `role="alert"`, no focus move and
 * no scroll, so a member using a screen reader pressed Save and nothing was
 * announced at all. Save is now gated and that slot is announced.
 *
 * THE PRICE IS ON THE CHOICE THAT COSTS IT, not in a summary somewhere else. A
 * member reading "Move both bookings" needs the figure beside those words, and the
 * other option needs the consequence beside its own — that is what makes the two
 * comparable at the moment of deciding.
 *
 * WHERE THERE ARE NOT BEDS FOR BOTH the first option is not offered at all rather
 * than offered and refused: the owner's "cannot" arm says to state that plainly
 * and offer the warn-and-continue path, and a disabled radio button with a reason
 * is a clearer statement of it than a button that fails when pressed.
 *
 * NO PERSON IS NAMED anywhere in here — not the qualifying adult, not a guest.
 * Every booking listed is the member's own; the server established that before it
 * built the body (see `buildSameOwnerCoverageLinkedMoveBody`).
 *
 * EVERY SENTENCE WITH A NUMBER IN IT COMES FROM
 * `hosting-coverage-linked-move-client.ts`, including the money. This component
 * used to hand-roll its own dollar formatter and its own copy of the
 * refund/payable/waiver decision tree, beside the server's — so a club on a
 * non-dollar currency got a `$` on the one figure it legally accepts, a five-digit
 * total lost its thousands separator on one line and kept it on the next, and the
 * two waiver sentences had already drifted apart (`INV-SSOT-001`,
 * `INV-CONFIG-001`).
 */

export function HostingCoverageLinkedMovePrompt({
  prompt,
  choice,
  disabled = false,
  busy = false,
  idPrefix,
  onChoiceChange,
}: {
  prompt: HostingCoverageLinkedMovePromptData | null;
  choice: HostingCoverageLinkedMoveChoice | null;
  disabled?: boolean;
  busy?: boolean;
  idPrefix: string;
  onChoiceChange: (choice: HostingCoverageLinkedMoveChoice) => void;
}) {
  // Permanently mounted live region, for the reason its override sibling carries:
  // inserting an already-populated role=alert is missed by some screen-reader and
  // browser pairs. The radio group sits OUTSIDE the assertive region so choosing
  // an option does not re-announce the whole offer.
  return (
    <div
      className={
        prompt
          ? "space-y-3 rounded-md border border-warning-7 bg-warning-2 p-3 text-sm"
          : undefined
      }
    >
      <div role="alert" aria-atomic="true" aria-busy={busy}>
        {prompt ? (
          <div className="space-y-1">
            <p className="font-semibold text-warning-11">
              {linkedMoveHeading(prompt.linkedBookings.length)}
            </p>
            <p>{prompt.message}</p>
          </div>
        ) : null}
      </div>
      {prompt ? (
        <>
          <ul className="space-y-2">
            {prompt.linkedBookings.map((booking) => (
              <li
                key={booking.bookingId}
                className="rounded border border-warning-6 bg-background p-2"
              >
                <span className="font-semibold">{booking.reference}</span>
                {` at ${booking.lodgeName}`}
                <div className="text-xs text-muted-foreground">
                  {`Now ${booking.currentCheckIn} to ${booking.currentCheckOut}`}
                  {prompt.linkedMoveAvailable
                    ? ` · would move to ${booking.proposedCheckIn} to ${booking.proposedCheckOut}`
                    : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  {`Nights without an adult if it stays: ${booking.uncoveredNights.join(", ")}`}
                </div>
              </li>
            ))}
          </ul>
          <fieldset
            className="space-y-2"
            aria-describedby={`${idPrefix}-linked-move-help`}
          >
            <legend className="font-semibold">What would you like to do?</legend>
            <p
              id={`${idPrefix}-linked-move-help`}
              className="text-xs text-muted-foreground"
            >
              Choose one. Nothing is saved until you do.
            </p>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                className="mt-1"
                name={`${idPrefix}-linked-move`}
                value="MOVE_BOTH"
                checked={choice === "MOVE_BOTH"}
                disabled={disabled || !prompt.linkedMoveAvailable}
                onChange={() => onChoiceChange("MOVE_BOTH")}
              />
              <span>
                <span className="font-semibold">
                  {`Move ${linkedMoveAllBookingsPhrase(prompt.linkedBookings.length)}`}
                </span>
                {prompt.linkedMoveAvailable ? (
                  <span className="block text-xs text-muted-foreground">
                    {formatLinkedMoveMoneySentence({
                      combinedAmountDueCents: prompt.combinedAmountDueCents,
                      combinedRefundCents: prompt.combinedRefundCents,
                      combinedChangeFeeCents: prompt.combinedChangeFeeCents,
                      settlementMethodRequired: prompt.settlementMethodRequired,
                      bothChangeFeesCharged: prompt.bothChangeFeesCharged,
                      linkedCount: prompt.linkedBookings.length,
                    })}
                  </span>
                ) : (
                  <span className="block text-xs text-muted-foreground">
                    {`Not available: there are not enough beds free on the new nights for ${linkedMoveAllBookingsPhrase(prompt.linkedBookings.length)}.`}
                  </span>
                )}
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                className="mt-1"
                name={`${idPrefix}-linked-move`}
                value="LEAVE_UNCOVERED"
                checked={choice === "LEAVE_UNCOVERED"}
                disabled={disabled}
                onChange={() => onChoiceChange("LEAVE_UNCOVERED")}
              />
              <span>
                <span className="font-semibold">
                  Move only this booking
                </span>
                <span className="block text-xs text-muted-foreground">
                  {linkedMoveDeclineConsequence(prompt.linkedBookings.length)}
                </span>
              </span>
            </label>
          </fieldset>
        </>
      ) : null}
    </div>
  );
}
