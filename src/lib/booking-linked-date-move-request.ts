import type { Role } from "@prisma/client";

import {
  SameOwnerCoverageLinkedMoveRequiredError,
  buildSameOwnerCoverageLinkedMoveBody,
} from "@/lib/adult-member-hosting-linked-move";
import type { HostingCoverageOverrideInput } from "@/lib/adult-member-hosting-same-owner";
import type { BatchModifyInput } from "@/lib/booking-modify-validation";
import type { ClubFormat } from "@/lib/club-format";
import type { CalendarDate } from "@/lib/club-time";
import {
  EditFiguresRequiredError,
  EditPriceChangedError,
  type EditQuotedFigures,
  type LinkedQuotedFigures,
} from "@/lib/edit-quoted-figures";

/**
 * What a linked move (#3232) is asked to do, and the figures an acceptance
 * binds each booking to (#5238, `INV-MOD-062`). Moved out of
 * `booking-linked-date-move-service.ts`, which keeps the transaction, to hold
 * that file inside its size budget.
 */
export interface LinkedDateMoveArgs {
  bookingId: string;
  actor: { id: string; role: Role };
  input: BatchModifyInput;
  /**
   * #5238: the figures the offer showed for each OTHER booking it moves,
   * echoed on `MOVE_BOTH` beside the primary's `input.quotedFigures`.
   */
  linkedQuotedFigures?: LinkedQuotedFigures;
  ipAddress: string;
  todayAtClub: CalendarDate;
  /**
   * The club's format (#3565), resolved by the route before any transaction,
   * like `todayAtClub`: both moves price inside one transaction, and the offer
   * renders its figures into the refusal it throws.
   */
  format: ClubFormat;
  hostingCoverageOverride?: HostingCoverageOverrideInput | null;
}

/**
 * The figures a booking's save is bound to. `"apply"` binds each booking to the
 * figure the offer showed for it, echoed by the acceptance, so a moved price
 * refuses inside the one transaction before anything is written for either
 * booking; `"quote"` prices the move afresh and binds none.
 */
export function acceptedLinkedMoveFigures(
  args: LinkedDateMoveArgs,
  mode: "quote" | "apply",
  bookingId: string,
): EditQuotedFigures | undefined {
  if (mode === "quote") return undefined;
  if (bookingId === args.bookingId) return args.input.quotedFigures;
  return args.linkedQuotedFigures?.find((row) => row.bookingId === bookingId)?.figures;
}

/**
 * An acceptance that matches the offer but echoed no figure for a booking it
 * moves compared nothing for that booking, so it is refused, still inside the
 * transaction, rather than committed.
 */
export function requireLinkedMoveFigures(args: LinkedDateMoveArgs, movedBookingIds: string[]): void {
  if (movedBookingIds.some((bookingId) => !acceptedLinkedMoveFigures(args, "apply", bookingId))) {
    throw new EditFiguresRequiredError();
  }
}

/**
 * A booking's price moved since the offer, so nothing was committed. Re-price
 * through `reoffer` and refuse with the fresh offer inside the
 * `EDIT_PRICE_CHANGED` refusal: the member answers the new figures, never a
 * silent substitute for the old ones. A real refusal the re-pricing hits
 * instead propagates as itself. A fresh offer that moves no other booking is
 * no offer to answer, so the plain refusal goes back and the member re-previews
 * a single-booking edit.
 */
export async function refuseWithFreshOffer(
  error: EditPriceChangedError,
  reoffer: () => Promise<never>,
): Promise<never> {
  try {
    await reoffer();
  } catch (offer) {
    if (offer instanceof SameOwnerCoverageLinkedMoveRequiredError && offer.quote.linked.length > 0) {
      throw new EditPriceChangedError(error.figures, buildSameOwnerCoverageLinkedMoveBody(offer));
    }
    if (offer instanceof SameOwnerCoverageLinkedMoveRequiredError) throw error;
    throw offer;
  }
  throw error;
}
