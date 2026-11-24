/**
 * The email registry's preview samples for the waitlist alerts' whole-sentence
 * notes (#5433): `{{noticeNote}}` (the "Waitlist email not sent" alert,
 * previewed as the offer arm) and `{{offerNote}}` (the routine offer alert,
 * previewed as the sent arm). Moved out of `sampleValue` in
 * `email-message-registry.ts`, which is past its size ceiling; that function
 * asks here for these tokens. Each sample is the sender's own wording.
 */
import { waitlistOfferAlertNote } from "@/lib/waitlist-offer-alert-note";
import { WAITLIST_NOTICE_UNSENT_NOTE } from "@/lib/waitlist-notice-unsent-note";

/** The sample for one of these tokens, or undefined for any other token. */
export function waitlistAlertSampleValue(token: string): string | undefined {
  if (token === "noticeNote") return WAITLIST_NOTICE_UNSENT_NOTE.offer;
  if (token === "offerNote") return waitlistOfferAlertNote("Sam Member", "sent");
  return undefined;
}
