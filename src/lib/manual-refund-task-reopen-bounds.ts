/**
 * How far back, and how many, the finance queue OFFERS a dismissal for reopening
 * (#3498, owner decision D2) — the one home for both bounds.
 *
 * ## Why they are here rather than beside the query or beside the card
 *
 * Because they are read in two places that must agree, on opposite sides of the
 * server boundary. `readDismissedManualRefundTasks` applies them to the query;
 * the card has to SAY them, because a bounded list that does not publish its
 * bound tells an officer who dismissed something five weeks ago that there is
 * nothing to correct. `manual-refund-task-reopen.ts` is `server-only`, so a
 * constant there is unreachable from the card — which is how the window came to
 * be stated in one place and the row cap in none.
 *
 * ## THEY BOUND THE LIST, NOT THE RULE
 *
 * `reopenManualRefundTask` refuses on STATUS and on WHO CLOSED the row, and
 * never on age: there is no failure that stops being worth correcting on day
 * thirty-one. A bound written into the money rule would make whether a mistake
 * can be undone depend on the clock. What stops an arbitrarily old row being
 * reopened from this screen is only that the screen does not list it, and the
 * card says so in those words.
 *
 * This module imports nothing, so either side may read it.
 */

/** How far back the card lists a dismissal. A display bound, not a money rule. */
export const REOPENABLE_DISMISSAL_WINDOW_DAYS = 30;

/**
 * The most rows that list carries.
 *
 * A card exists to be read, and an unbounded list of settled rows is what makes
 * an operator stop reading it — the same reason the automatic-refund card beside
 * it is bounded.
 */
export const REOPENABLE_DISMISSAL_LIST_MAX = 100;
