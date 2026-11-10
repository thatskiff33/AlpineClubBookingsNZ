/**
 * #4851: the sentences Stuck States shows for a dead refund out of the group
 * organiser's card. One home, so the list, the routes and the closes agree.
 */

/** The old whole-group refund has no Try the card again. */
export const LEGACY_GROUP_CARD_REFUND_TRY_AGAIN_REFUSAL =
  "This is an old refund of the whole group, one card payment, and it is not sent to the card again from here. Settle it with Paid another way.";

/** The list of refunds on the intent could not be read, so nothing is written. */
export const GROUP_CARD_REFUND_STRIPE_UNREADABLE =
  "Stripe could not be read, so neither a record nor a bank payment was written, and the card was not asked again.";

/**
 * A live refund of this row's amount with no joiner key. It cannot be told
 * apart from this refund. Do not point the officer at the other button.
 */
export const GROUP_CARD_REFUND_UNKEYED_SAME_AMOUNT =
  "Stripe holds a refund for this amount on the organiser's card that cannot be told apart from this refund. Ask a developer to reconcile it.";

/** A live refund on the old whole-group intent that is not the frozen plan's one refund. */
export const GROUP_CARD_REFUND_LEGACY_OTHER_LIVE =
  "Stripe holds another refund on the organiser's card, so this old whole-group refund cannot be settled from here. Ask a developer to reconcile it.";

/** Try the card again found this row's refund already live on the intent. */
export const GROUP_CARD_REFUND_ALREADY_ON_STRIPE =
  "Stripe already has this refund. Paid another way records it and pays nobody again.";
