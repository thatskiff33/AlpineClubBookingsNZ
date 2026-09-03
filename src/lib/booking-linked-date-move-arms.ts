import type { HostingCoverageLinkedMoveInput } from "@/lib/adult-member-hosting-linked-move";
import { SameOwnerCoverageWouldBreakError } from "@/lib/adult-member-hosting-same-owner";
import {
  modifyBookingBatch,
  type BatchModificationResponse,
} from "@/lib/booking-batch-modification-service";
import {
  modifyBookingDates,
  type DateModificationResponse,
  type ModifyBookingDatesInput,
} from "@/lib/booking-date-modification-service";
import {
  applyLinkedDateMove,
  offerLinkedDateMove,
  type LinkedDateMoveArgs,
} from "@/lib/booking-linked-date-move-service";
import type { BatchModifyInput } from "@/lib/booking-modify-validation";

/** How a caller says what the member answered, if anything. */
export interface LinkedDateMoveAnswer {
  linkedMove?: HostingCoverageLinkedMoveInput | null;
}

/**
 * What a linked move is allowed to see of a save request: the dates, and where the
 * money goes. ONE definition, for both doors (`INV-SSOT-001`, #3232).
 *
 * EVERYTHING ELSE IS DROPPED, and dropping it is the point rather than tidiness.
 * `/modify` accepts admin-only fields — `adminOverride`, `confirmOverCapacity`,
 * `notifyMember`, guest and promo edits — and it was passing its whole parsed body
 * into the quote. `adminOverride` then travelled into `modifyBookingBatch` inside a
 * caller transaction, which that service refuses outright (its conservative Xero
 * lock-date guard has no pre-resolved form), so the member got an unexplained 500
 * instead of the offer. Reachable: the answer is deliberately NOT admin-gated,
 * because the person entitled to answer it is the booking's own member, admin or
 * not.
 *
 * An over-capacity CONFIRMATION is also the opposite of what the `NO_CAPACITY` arm
 * is for, and a guest or promo edit is not part of a two-booking date move at all.
 * Deriving the same input for the quote and for the apply is what keeps the figure
 * the member accepted the figure they are charged.
 */
export function linkedMoveQuoteInput(input: {
  checkIn?: string;
  checkOut?: string;
  settlementMethod?: BatchModifyInput["settlementMethod"];
}): BatchModifyInput {
  return {
    ...(input.checkIn !== undefined ? { checkIn: input.checkIn } : {}),
    ...(input.checkOut !== undefined ? { checkOut: input.checkOut } : {}),
    ...(input.settlementMethod
      ? { settlementMethod: input.settlementMethod }
      : {}),
  };
}

/**
 * The three arms of the offer, ONCE, over whichever single-booking edit the
 * surface performs (#3232 D1).
 *
 * WHY THE ARMS ARE HERE AND NOT IN THE ROUTES. Which refusals become an offer,
 * which stay a refusal, and what accepting means are a POLICY, not a rendering
 * concern. Two date-capable member surfaces exist (`/modify` and `/modify-dates`)
 * and they run different single-booking writers, so a route that assembled the
 * policy itself would be a second copy of it — and the arm that got copied wrong
 * would be the one that either deadlocks a member or silently strands a booking
 * (`INV-SSOT-001`). The surfaces therefore differ ONLY in the writer they hand in.
 *
 * WHAT IT DOES, in order:
 *
 *  - `MOVE_BOTH` answered → the atomic two-booking move, on one settlement.
 *  - otherwise → the surface's own ordinary single-booking edit. A
 *    `LEAVE_UNCOVERED` answer travels with it, which is what turns the stranded
 *    refusal into an escalation.
 *  - and if that edit is refused because it would strand a booking the member
 *    cannot reach, the refusal is priced and re-thrown as the OFFER.
 *
 * A refusal NOT marked `linkedMoveWouldAnswer` propagates untouched, because there
 * the member has real remedies on the affected booking and today's refusal is the
 * right answer. Deciding that here rather than at the throw site is deliberate:
 * the hosting engine knows which shape of stranding it found, and this module knows
 * what can be done about it.
 */
async function withLinkedMoveArms<T>(
  args: LinkedDateMoveArgs & LinkedDateMoveAnswer,
  performSingleBookingEdit: (
    linkedMove: HostingCoverageLinkedMoveInput | null,
  ) => Promise<T>,
): Promise<T | BatchModificationResponse> {
  const { linkedMove, ...rest } = args;
  // THE LINKED MOVE SEES DATES AND THE SETTLEMENT CHOICE, AND NOTHING ELSE —
  // narrowed HERE so both doors get it rather than in the door that remembered.
  // `/modify` was handing its whole parsed request body straight through, so an
  // ADMIN who owns the booking could carry `adminOverride: true` into the quote,
  // which reaches `modifyBookingBatch` WITH a transaction and hits the bare
  // `INV-LOCK-004` throw — a raw 500 where the member was owed the offer.
  const linkedMoveArgs = { ...rest, input: linkedMoveQuoteInput(rest.input) };
  if (linkedMove?.choice === "MOVE_BOTH") {
    return applyLinkedDateMove({ ...linkedMoveArgs, linkedMove });
  }
  try {
    return await performSingleBookingEdit(linkedMove ?? null);
  } catch (error) {
    if (
      error instanceof SameOwnerCoverageWouldBreakError &&
      error.linkedMoveWouldAnswer
    ) {
      // Always throws — either the offer, or whatever real refusal the priced
      // attempt hits on the way. A minimum-stay violation on the dependent's new
      // nights must not be hidden behind an offer the member cannot take.
      await offerLinkedDateMove(linkedMoveArgs);
    }
    throw error;
  }
}

/**
 * The batch save path's entry point (`PUT /api/bookings/[id]/modify`, #3232).
 */
export async function modifyBookingWithLinkedMoveSupport(
  args: LinkedDateMoveArgs & LinkedDateMoveAnswer,
): Promise<BatchModificationResponse> {
  return withLinkedMoveArms(args, (linkedMove) =>
    modifyBookingBatch({
      bookingId: args.bookingId,
      actor: args.actor,
      input: args.input,
      ipAddress: args.ipAddress,
      todayAtClub: args.todayAtClub,
      ...(args.hostingCoverageOverride
        ? { hostingCoverageOverride: args.hostingCoverageOverride }
        : {}),
      ...(linkedMove ? { hostingCoverageLinkedMove: linkedMove } : {}),
    }),
  );
}

/**
 * The date-only save path's entry point (`PUT /api/bookings/[id]/modify-dates`,
 * #3232 D1 applied consistently).
 *
 * WHY THIS ROUTE NEEDS IT AT ALL, which is not obvious. `modifyBookingDates` is
 * one of the three writers that now hands the seam the window the booking VACATED
 * (`INV-HOST-049`), so it is one of the writers whose dependent fan-out NOTICES the
 * booking a date move leaves behind. Noticing is the fix — but on its own it turns
 * a move that used to succeed silently into a refusal, and this is precisely the
 * refusal the owner rejected: the member cannot move the affected booking either,
 * because the same rule refuses THAT edit from the other end. Widening the read
 * here without offering the move would therefore have shipped the deadlock on a
 * live member API. Both date-capable surfaces offer all three arms or neither does.
 *
 * THE QUOTE INPUT IS DATES AND THE SETTLEMENT CHOICE, AND NOTHING ELSE —
 * `linkedMoveQuoteInput`, shared with the `/modify` door rather than written here,
 * since a narrowing only one door performs is the narrowing the other door forgets.
 *
 * THE MOVE-BOTH ARM ANSWERS WITH THE BATCH WRITER, and that is a real difference
 * worth stating rather than hiding: a two-booking move must happen inside ONE
 * transaction, and `modifyBookingDates` is not transaction-aware, so the atomic arm
 * necessarily prices through `modifyBookingBatch`. The property the member is owed
 * survives it, because the QUOTE they accepted came from that same engine on that
 * same pair of moves — they are never charged a figure they were not shown. Its
 * response satisfies this route's `DateModificationResponse` contract in full,
 * which is why `policyRetainedAmountCents` and `capacityOverridden` are now on
 * `BatchModificationResponse`: an arm that dropped them would have to invent money.
 */
export async function modifyBookingDatesWithLinkedMoveSupport(
  args: Omit<LinkedDateMoveArgs, "input"> &
    LinkedDateMoveAnswer & { input: ModifyBookingDatesInput },
): Promise<DateModificationResponse> {
  return withLinkedMoveArms(
    { ...args, input: linkedMoveQuoteInput(args.input) },
    (linkedMove) =>
      modifyBookingDates({
        bookingId: args.bookingId,
        actor: args.actor,
        input: args.input,
        ipAddress: args.ipAddress,
        ...(args.hostingCoverageOverride
          ? { hostingCoverageOverride: args.hostingCoverageOverride }
          : {}),
        ...(linkedMove ? { hostingCoverageLinkedMove: linkedMove } : {}),
      }),
  );
}
