// Which way a manual refund task's money goes, and the two choices the officer
// picks between, moved verbatim from `manual-refund-task-queue.tsx` so that
// file stays under its hard size ceiling (#4926). Pure data: no state, no fetch.

/**
 * #3170: which way the officer says the money goes.
 *
 * `null` is "not yet chosen" and is the state the dialog OPENS in - there is no
 * default, deliberately. Before this issue the direction was implicit in the word
 * "refund", and that implicitness was the hazard: this is the first release where
 * a parked edit can have raised the price, so an officer reading the evidence can
 * correctly conclude the club is owed, and every settlement path was refund
 * -shaped. A pre-ticked "pay them back" would put the wrong-direction movement
 * one un-noticed default away.
 */
export type SettlementDirection = "REFUND_TO_MEMBER" | "CHARGE_TO_MEMBER";

/**
 * What each direction actually does, in the words the officer needs BEFORE they
 * commit rather than in a receipt afterwards. Both sentences name the instrument,
 * and the charge sentence says plainly that nothing is taken from the card here -
 * the completion raises the request and the member pays it, exactly as they would
 * for an ordinary check-out extension.
 */
export const DIRECTION_CHOICES: ReadonlyArray<{
  value: SettlementDirection;
  label: string;
  detail: string;
}> = [
  {
    value: "REFUND_TO_MEMBER",
    label: "The club owes the member",
    detail:
      "The money goes back to them: to the card they paid with, or as account credit where there is no card behind it.",
  },
  {
    value: "CHARGE_TO_MEMBER",
    label: "The member owes the club",
    detail:
      "They are asked to pay it: added to this booking as an additional payment on their card, or onto the booking's invoice to pay by internet banking. Nothing is taken from their card by this screen.",
  },
];
