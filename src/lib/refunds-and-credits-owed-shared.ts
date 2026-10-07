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
   * Every refund the club has promised back by hand and not yet paid: the open
   * hand-back tasks, summed by the same rule Net Collected subtracts them with
   * (`openHandBackOwedCents`). A task leaves this figure when it is completed
   * (paid back) or dismissed.
   */
  refundsOwedCents: number;
  /**
   * Account credit issued to members and not yet applied or used: the sum of
   * every member's credit-ledger balance (`sumOutstandingCreditCents` over
   * `readMemberCreditBalances`). Credit leaves it when it is spent on a booking.
   */
  creditsOwedCents: number;
}

/** The on-screen note both figures carry, so every surface says the same thing. */
export const REFUNDS_AND_CREDITS_OWED_NOTE =
  "As at today, across the club: not limited to the dates or filters above.";
