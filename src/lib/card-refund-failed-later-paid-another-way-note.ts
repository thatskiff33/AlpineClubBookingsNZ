/**
 * #4210 (`INV-PAY-136`): what the officers are told when Stripe fails, after
 * accepting it, a card refund a "Paid another way" close had already settled.
 * One builder for the hand-built HTML
 * (`email-templates/admin-card-refund-failed-after-paid-another-way.ts`) and
 * the `{{paidAnotherWayFailedLaterNote}}` token an admin's saved body renders,
 * so the two cannot say different things about money. A leaf module: the
 * registry imports it without loading the email layout.
 */

import type { PaidAnotherWayCheckReason } from "@/lib/open-card-refund-owed";

/** How the failed-later writer decided a refund a close had settled (`card-refund-failed-later-paid-another-way.ts`). */
export type PaidAnotherWayFailedLaterOutcome = "settled-paid-another-way" | "raised-check-part-close" | "raised-check-resolved" | "raised-check-uncertain";

export type PaidAnotherWayFailedLaterNoteInput = {
  outcome: PaidAnotherWayFailedLaterOutcome;
  stripeRefundId: string;
  /** The failed refund, formatted. */
  amount: string;
  /** What the close paid back, and what it owed when it closed, formatted. */
  paidBack: string;
  owed: string;
  /** The close paid back less than it owed (a part close). */
  partClose: boolean;
  /** What is raised for an officer to check, formatted (the check outcomes). */
  check: string;
  /** The refund was counted under "Card refunds paid back twice" (`cardRefundsSentAfterPaidAnotherWay`). */
  onPaidTwiceList: boolean;
  /**
   * The app recorded the refund after the close, so the close never counted it;
   * else it counted it toward another card refund on the booking before the close.
   */
  recordedAfterClose: boolean;
  /** The note the paid-twice row was marked Resolved with, if it was. */
  resolutionNote: string | null;
};

/**
 * #4210 round 3 (UX 1, `INV-SSOT`): why a row raised for an officer to check
 * is a check, as its row's last error and the dead card refunds panel both say it.
 */
export const PAID_ANOTHER_WAY_CHECK_WHY: Record<PaidAnotherWayCheckReason, string> = {
  "part-close": "The close paid back only part of what it owed, so this may be part of what it gave up",
  resolved: "Its paid-twice row was marked resolved, so the member may have returned the extra",
  uncertain: "The app cannot tell whether the close paid this refund back",
};

const GAVE_UP_ON = '"Card refunds Stripe gave up on" on the Stuck states page';
/** #4210 round 3 (UX 2): how an officer closes a check row either way. */
const CLOSE_CHECK = `If the member is owed it, pay them another way and close it there as paid another way; if they are not, close it there as checked - not owed`;

/** How the refund stood when the close was recorded (money F5: said only where true). */
function howItStood(note: PaidAnotherWayFailedLaterNoteInput): string {
  if (note.outcome === "raised-check-uncertain") return "";
  return note.recordedAfterClose
    ? " The app had not yet counted this refund when the close was recorded, so the close paid its share back."
    : " The app had counted this refund toward another card refund on the booking, not this one, so the close paid its share back.";
}

export function paidAnotherWayFailedLaterNote(note: PaidAnotherWayFailedLaterNoteInput): string {
  const close = note.partClose
    ? `paid the member back ${note.paidBack} of the ${note.owed} it owed and gave the rest up`
    : `paid the member back ${note.paidBack}`;
  const list = note.onPaidTwiceList ? ' It showed under "Card refunds paid back twice", and leaves that list now.' : "";
  const lead = `Stripe reported card refund ${note.stripeRefundId} of ${note.amount} failed after accepting it, so that money did not reach the member's card. The card refund it was made for had been closed as paid another way, and that close ${close}.${howItStood(note)}${list}`;
  switch (note.outcome) {
    case "settled-paid-another-way":
      return `${lead} The member has had this money back once, by the close, so it is not owed again and is not asked for again. ${note.onPaidTwiceList ? "Do not pay the member again unless they have already returned the extra; if you only asked, tell them not to send it." : "Do not pay the member again."} Raise no other refund note for it in Xero: if a card refund credit note was raised while Stripe counted it, it no longer matches money paid back, and the Xero reconciliation report lists it as refund coverage above the refunded total, for you to correct in Xero.`;
    case "raised-check-part-close":
      return `${lead} Up to ${note.check} of this refund may be part of what the close gave up, so ${note.check} is listed under ${GAVE_UP_ON} for you to check. It is not asked for again automatically. ${CLOSE_CHECK}. The rest was paid back by the close: do not pay it again.`;
    case "raised-check-resolved":
      return `${lead} The booking was then marked resolved under "Card refunds paid back twice"${note.resolutionNote ? `, with the note: "${note.resolutionNote}"` : ""}. If the member returned the extra, they are owed ${note.check} again. It is listed under ${GAVE_UP_ON} and is not asked for again automatically. ${CLOSE_CHECK}.`;
    case "raised-check-uncertain":
      return `${lead} The app cannot tell whether that close paid this refund's share back: the close was recorded before the app kept what a close counted, or it owed less than this refund. So ${note.check} is listed under ${GAVE_UP_ON} for you to check against the close and the Stripe dashboard. It is not asked for again automatically. ${CLOSE_CHECK}.`;
  }
}
