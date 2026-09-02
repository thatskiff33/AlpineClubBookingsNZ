"use client";

import type {
  HostingCoverageLinkedMoveChoice,
  HostingCoverageLinkedMovePromptData,
} from "@/lib/hosting-coverage-linked-move-client";

/**
 * #3232's linked-move offer, as the member sees it.
 *
 * TWO CHOICES AND NO DEFAULT, which is the whole design. Pre-selecting either one
 * would answer a money question on the member's behalf: pre-selecting "move both"
 * charges them for a second booking they may not want moved, and pre-selecting
 * "move only this one" strands a booking on a click they did not think about. So
 * the save button stays disabled until they pick, and the panel enforces that.
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
 */
function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}$${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

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
              Another of your bookings needs an adult on these nights
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
                <span className="font-semibold">Move both bookings</span>
                {prompt.linkedMoveAvailable ? (
                  <span className="block text-xs text-muted-foreground">
                    {prompt.combinedRefundCents > 0
                      ? `${money(prompt.combinedRefundCents)} comes back to you across both bookings.`
                      : prompt.combinedAmountDueCents > 0
                        ? `${money(prompt.combinedAmountDueCents)} payable across both bookings.`
                        : "Nothing more to pay and nothing to come back."}
                    {prompt.bothChangeFeesCharged
                      ? ` Includes the change fee on both bookings (${money(prompt.combinedChangeFeeCents)} in all).`
                      : " The change fee on the second booking has been waived by the club."}
                    {prompt.settlementMethodRequired
                      ? " Your card-or-credit choice above covers both bookings."
                      : null}
                  </span>
                ) : (
                  <span className="block text-xs text-muted-foreground">
                    Not available: there are not enough beds free on the new
                    nights for both bookings.
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
                  The booking above will be left without adult supervision on
                  those nights. A Booking Officer will be told and will be in
                  touch if anything needs to change.
                </span>
              </span>
            </label>
          </fieldset>
        </>
      ) : null}
    </div>
  );
}
