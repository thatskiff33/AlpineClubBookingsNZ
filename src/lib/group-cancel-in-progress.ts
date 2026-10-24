import { GroupBookingStatus, type Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import { ORGANISER_CANCEL_ACTIVE_CHILD_STATUSES } from "@/lib/booking-status";
import { paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";

/**
 * #3949 (`INV-PAY-137`, review rounds 3 and 4): IS THE ORGANISER'S GROUP CANCEL BETWEEN ITS PLAN AND THIS CHILD'S
 * CLAIM? The cancel fences the group CANCELLED under `lock(1)`, then freezes each child's refund outside it from the
 * payment as it stood, net of the hand-backs then open, and books that whole planned share - on the mirror, the
 * ledger and the organiser's hand-back - when it claims the child under `lock(1)`. Until that claim (or the reaper's
 * resume of it) has cancelled the child, the child is still one the cancel will claim
 * (`ORGANISER_CANCEL_ACTIVE_CHILD_STATUSES`) in a CANCELLED group.
 *
 * The ONE test for the refusals that keep a refund to the organiser off a child in that window, so it is never paid
 * twice: a hand-back's completion (`group-settlement-mirror-hand-back.ts`), the raising of a new one by any edit
 * door or an approved appeal (`edit-refund-hand-back.ts`), and (review round 5) any price change of an Internet
 * Banking organiser-paid child at all, whatever settlement it chose (`applyPaymentAdjustments`). Asked under the caller's `lock(1)` - the fence's and the
 * claim's own key - with the child's status as read under it, so the answer holds until the caller commits.
 */
export async function groupCancelInProgress(
  store: Pick<Prisma.TransactionClient, "groupBooking">,
  child: { status: string; parentBookingId: string | null },
): Promise<boolean> {
  if (!child.parentBookingId || !(ORGANISER_CANCEL_ACTIVE_CHILD_STATUSES as readonly string[]).includes(child.status)) return false;
  const group = await store.groupBooking.findUnique({ where: { organiserBookingId: child.parentBookingId }, select: { status: true } });
  return group?.status === GroupBookingStatus.CANCELLED;
}

/** #3949 review round 4: the refusal an edit or an appeal meets when it would raise a new refund to the organiser in that window. */
export const GROUP_CANCEL_IN_PROGRESS_RAISE_MESSAGE =
  "The group organiser is cancelling this group and has not finished with this booking yet, so no refund to the organiser can be raised on it now: the cancellation is working out this booking's own refund to the organiser from the price as it stood. Wait until the booking shows as cancelled, then decide whether anything more is owed.";

/**
 * #3949 review round 5: the refusal any price-changing edit of a joiner's booking the organiser paid for by Internet
 * Banking meets in that window, whatever settlement it chose (`applyPaymentAdjustments`).
 */
export const GROUP_CANCEL_IN_PROGRESS_PRICE_MESSAGE =
  "The group organiser is cancelling this group and has not finished with this booking yet, so its price cannot be changed now: the cancellation is working out this booking's refund to the organiser from the price as it stood. Wait until the booking shows as cancelled.";

/** Thrown inside the edit's or the approval's transaction, so the whole change rolls back; the doors answer 409. */
export class GroupCancelInProgressError extends ApiError {
  constructor(message: string = GROUP_CANCEL_IN_PROGRESS_RAISE_MESSAGE) {
    super(message, 409);
  }
}

/**
 * #3949 review rounds 5-6 (`INV-PAY-137`): the refusal a price change of a joiner's booking the organiser paid for by
 * Internet Banking meets while the organiser's group cancel is part-way through, whatever settlement the edit chose -
 * account credit included - because the cancel froze this child's refund from the price as it stood; or null. The
 * price change and the change fee are each tested on their own: a cut a fee nets to zero still changes the price.
 *
 * The ONE answer for the save and its quote: the save asks it through `refuseOrganiserBankChildPriceChangeInGroupCancel`
 * under the door's `lock(1)` with the booking re-read after it; the quote asks it unlocked, as advice
 * (`priceChangeRefusal`), so it does not promise a refund the save will refuse.
 */
export async function organiserBankChildPriceChangeRefusal(
  store: Pick<Prisma.TransactionClient, "groupBooking">,
  booking: Parameters<typeof paidByOrganiserInternetBanking>[0] & { status: string },
  change: { priceDiffCents: number; changeFeeCents: number },
): Promise<string | null> {
  const changes = change.priceDiffCents !== 0 || change.changeFeeCents !== 0;
  return changes && paidByOrganiserInternetBanking(booking) && (await groupCancelInProgress(store, booking)) ? GROUP_CANCEL_IN_PROGRESS_PRICE_MESSAGE : null;
}

/**
 * Throw that refusal (409). Asked once by `applyPaymentAdjustments`, which every edit door and a guest's acceptance
 * settle a price change through, and by the guest-add door, which settles itself.
 */
export async function refuseOrganiserBankChildPriceChangeInGroupCancel(
  store: Pick<Prisma.TransactionClient, "groupBooking">,
  booking: Parameters<typeof paidByOrganiserInternetBanking>[0] & { status: string },
  change: { priceDiffCents: number; changeFeeCents: number },
): Promise<void> {
  const refusal = await organiserBankChildPriceChangeRefusal(store, booking, change);
  if (refusal) throw new GroupCancelInProgressError(refusal);
}
