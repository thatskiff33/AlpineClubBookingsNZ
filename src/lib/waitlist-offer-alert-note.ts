/**
 * #5433 (round 2, item 7): what the officers' routine waitlist offer alert
 * (`admin-waitlist-offer`) says about the offer email: sent; withheld by
 * design (the booking's "No emails", or a copy that is not the club's live
 * site); or not delivered (it bounced, failed for good, or could not be sent at
 * all). It used to say "has been sent" in every case. A leaf module, so the
 * email registry can preview the `{{offerNote}}` token without loading a
 * template.
 */

/** What became of the offer email, as the alert reports it. */
export type WaitlistOfferEmailOutcome = "sent" | "withheld" | "not-delivered";

export function waitlistOfferAlertNote(memberName: string, outcome: WaitlistOfferEmailOutcome): string {
  switch (outcome) {
    case "sent":
      return `A waitlist offer has been sent to ${memberName}.`;
    case "withheld":
      return `A waitlist offer has been made to ${memberName}, but its email was withheld (the booking's emails are switched off, or this is not the club's live site), so they may not know about it.`;
    case "not-delivered":
      return `A waitlist offer has been made to ${memberName}, but its email did not reach them, so they may not know about it. A separate "Waitlist email not sent" alert says what to do.`;
  }
}
