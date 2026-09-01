/**
 * THE REFUSALS A REVIEW CHARGE CAN GIVE, AND WHY EACH ONE IS A REFUSAL (#3170,
 * epic #2797).
 *
 * Lifted out of `edit-financial-review-charge.ts` in the #3181 fix round. The
 * seam is worth having on its own merits and not only for the file-size ratchet:
 * these five are member- and officer-facing SENTENCES, each carrying the reason
 * it exists, and the module they came from is about deciding a route and raising
 * an ask. `edit-financial-review-settlement.ts` already imported one of them
 * across that boundary, which is the usual sign that the strings are their own
 * thing. Deliberately dependency-free - no `server-only`, no Prisma, no provider
 * client - so a surface that needs to show one of these before the click can
 * import it without dragging the charge machinery in behind it, exactly as
 * `booking-financial-review-copy.ts` is arranged for the member's side.
 */

/**
 * #3170: the officer said the CLUB is owed, on a task kind that can only ever
 * mean the club owes the MEMBER.
 *
 * The three pre-#2797 kinds are all hand-backs by definition - a cancelled
 * cash-settled booking, a late capture on a deleted booking, the record of a
 * capture Stripe already refunded. There is no shape of any of them in which the
 * member owes money, so a charge direction on one is a mistake rather than an
 * unusual case, and it is refused before anything is claimed.
 */
export const REVIEW_CHARGE_WRONG_KIND_MESSAGE =
  "This task is money the club owes the member, so it cannot be used to collect money from them. If the member owes the club for a booking change, make that change on the booking itself.";

/**
 * #3170: the officer said the club is owed, and there is no way to ask for it.
 *
 * The club collects a price increase in exactly two ways: an additional card
 * payment against a captured Stripe payment, or a supplementary invoice on a
 * booking that already has one. A booking with neither has no instrument at all -
 * inventing one here would be the fourth settlement mechanism the epic forbids,
 * and pretending the money was collected would be the "claims money moved"
 * failure `INV-PAY-051` exists to stop.
 *
 * Refused BEFORE the claim, so the task stays OPEN and still holds the money
 * question.
 */
export const REVIEW_CHARGE_NO_INSTRUMENT_MESSAGE =
  "There is no card payment on this booking and no invoice to add this to, so the club cannot ask for the money automatically. Collect it another way, then dismiss this task with a note recording what was collected and how - the note is the record that the money was settled outside the system.";

/**
 * #3170: a charge with no `BookingModification` to hang it on.
 *
 * The same anchor the refund side needs, and needed for the same reason plus two
 * more: the supplementary invoice that corrects an issued Xero invoice is queued
 * against that row, so a charge with no anchor would collect money the club's
 * accounts never show as owed - and since the combined request is anchored to
 * that row too, a charge without one could not be joined to its sibling share.
 * Told plainly rather than guessed at.
 */
export const REVIEW_CHARGE_ANCHOR_MISSING_MESSAGE =
  "This review is not linked to the booking change it came from, so the club cannot ask for the money automatically. Collect it another way, then dismiss this task with a note recording what was collected and how - the note is the record that the money was settled outside the system.";

/**
 * #3170 (owner decision, 30 Aug 2026): "a share may not be added to a request the
 * member has already paid", answered as a REFUSAL rather than as a second
 * request.
 *
 * The member has settled this edit's bill. Raising the paid intent's amount is
 * not available - Stripe refuses an amount change on a succeeded PaymentIntent,
 * and if it did not, the money is already taken and the figure would be a lie.
 * The two alternatives were weighed:
 *
 *   * MINT A FRESH REQUEST FOR THE REMAINDER. Rejected. That is a second
 *     outstanding request against one edit, which is exactly the arrangement this
 *     decision removed: the moment two exist, minting the second queues the first
 *     for cancellation and the payment record carries only the later figure. It
 *     would reintroduce the money-losing mechanism in the one case where the club
 *     has already been paid part of the money and can least afford to lose track
 *     of the rest.
 *   * UPDATE ANYWAY AND LET IT FAIL. Rejected outright - a settlement that
 *     appears to succeed while collecting nothing is the `INV-PAY-051` failure.
 *
 * So the task stays OPEN, still holding the money question, and the officer is
 * told what to do. This is a genuinely different case from the one the owner
 * REJECTED ("refuse the second charge until the first is paid"): that would have
 * blocked the ordinary two-shares-in-one-sitting flow, which is the flow this
 * refusal leaves entirely alone.
 */
export const REVIEW_CHARGE_REQUEST_ALREADY_PAID_MESSAGE =
  "The member has already paid the request for this booking change, so this amount cannot be added to it. Collect it another way, then dismiss this task with a note recording what was collected and how - the note is the record that the money was settled outside the system.";

/**
 * #3170: this edit's request exists but can no longer be restated - it was
 * cancelled, or it failed, or its supplementary Xero invoice has already been
 * issued and sent.
 *
 * The same refusal shape and the same reasoning as the already-paid case: there
 * is one request per edit, this one is closed, and minting a second is the thing
 * that loses money. It is the internet-banking route's ordinary ceiling rather
 * than a rare edge - that route's supplementary invoice is raised UNPAID and
 * issues as soon as the outbox runs, so a second share settled minutes later
 * meets an invoice already with the member. Refused loudly, with the money still
 * owed and the task still open, rather than queued into a dedupe that would
 * silently drop it.
 *
 * A FAILED request is included DELIBERATELY, and the call is close enough to be
 * worth writing down. A declined card leaves the Stripe intent in
 * `requires_payment_method`, which Stripe would still let us raise the amount on
 * - so this is stricter than the provider requires. It is refused because the
 * LOCAL row says FAILED, and reviving it would mean flipping that row back to
 * PENDING: `mapAdditionalSummaryStatus` reports FAILED to the payment summary,
 * the stale-WAITING_PAYMENT reaper retires this edit's Xero operation 24 hours
 * after the failure, and a resurrection would have to reason about both. A
 * refusal with the money still owed and the task still open is the honest answer
 * until somebody needs the other one.
 */
export const REVIEW_CHARGE_REQUEST_CLOSED_MESSAGE =
  "The club has already asked the member for this booking change, and that request can no longer be changed. Collect this amount another way, then dismiss this task with a note recording what was collected and how - the note is the record that the money was settled outside the system.";
