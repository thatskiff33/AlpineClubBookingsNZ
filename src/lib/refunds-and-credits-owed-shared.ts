/**
 * Client-safe half of `refunds-and-credits-owed.ts`: the shape and the note,
 * with no database import, so a client page can render the figures.
 */
/**
 * The two figures shown beside every Net Collected figure (owner, #3372,
 * 7 Oct 2026: "show a separate number that says 'refunds owed' and 'credits
 * owed' so it shows here until they are paid ... the total of all refunds owed
 * but not yet paid and all credits issued and not yet applied/used").
 *
 * POINT-IN-TIME, CLUB-WIDE: "as at today". Neither is narrowed by a surface's
 * dates, lodge or filters - a refund owed is owed whatever range the officer is
 * looking at - and neither is part of Net Collected's arithmetic. Net Collected
 * takes each open hand-back off straight away; these say what is still out.
 */
export interface RefundsAndCreditsOwed {
  /**
   * Every refund owed and not yet paid (owner, 7 Oct 2026), each part summed by
   * the rule Net Collected subtracts it with: open hand-back tasks
   * (`openTaskOwedCents`), card refunds Stripe has not yet paid
   * (`openCardRefundOwedCents`), and late card charges awaiting the
   * treasurer's refund-or-keep decision (`isLateCaptureAwaitingDecisionTask`).
   * Plus, as one club-wide amount against no booking (owner, 8 Oct 2026:
   * "Separate club-wide line"), what the unclosed group settlement card
   * refunds from before #3653 still have to send
   * (`legacyGroupSettlementRefundOwedCents`).
   * Each leaves this figure when it is paid, dismissed or kept.
   */
  refundsOwedCents: number;
  /**
   * Account credit issued to members and not yet applied or used: the sum of
   * every member's credit-ledger balance (`sumOutstandingCreditCents` over
   * `readMemberCreditBalances`). Credit leaves it when it is spent on a booking.
   */
  creditsOwedCents: number;
}

/** The two figures' labels, one spelling for every surface and the Reports CSV. */
export const REFUNDS_OWED_LABEL = "Refunds owed";
export const CREDITS_OWED_LABEL = "Credits owed";

/**
 * The on-screen note both figures carry, so every surface says the same thing.
 * It names no "above": on the dashboard card nothing above it has dates or
 * filters (#3372 review, F4u).
 */
export const REFUNDS_AND_CREDITS_OWED_NOTE =
  "As at today, across the club: not limited to any dates or filters.";
