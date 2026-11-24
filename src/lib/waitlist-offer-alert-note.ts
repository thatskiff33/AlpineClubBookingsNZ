/**
 * #5433 (round 2, item 7): what the officers' routine waitlist offer alert
 * (`admin-waitlist-offer`) says about the offer email: sent, or withheld by
 * design (the booking's "No emails", or a copy that is not the club's live
 * site). It used to say "has been sent" in every case. A leaf module, so the
 * email registry can preview the `{{offerNote}}` token without loading a
 * template.
 */

/** The offer email's outcome, as the alert reports it (only a told email is reported). */
export type WaitlistOfferEmailOutcome = "sent" | "withheld";

export function waitlistOfferAlertNote(memberName: string, outcome: WaitlistOfferEmailOutcome): string {
  return outcome === "sent"
    ? `A waitlist offer has been sent to ${memberName}.`
    : `A waitlist offer has been made to ${memberName}, but its email was withheld (the booking's emails are switched off, or this is not the club's live site), so they may not know about it.`;
}
