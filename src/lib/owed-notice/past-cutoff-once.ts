/**
 * #5433: a kind's past-cut-off officer alert, sent at most once per marker.
 *
 * The sweep runs a kind's `pastCutoff` step at least once: a stop after the
 * step returns and before the marker is cleared runs it again. Owner decision
 * D1 says officers are alerted once when a member's notice passes its cut-off,
 * so a kind sends that alert through here: a once-ever claim
 * (`sendAdminAlertOnceEverClaim`) keyed on the marker's id, which a rerun for
 * the same marker loses, sending nothing.
 *
 * The claim's result becomes the step's outcome:
 * - kept (an officer has it, or the email retry cron holds a FAILED copy):
 *   `settled`, and the marker is cleared;
 * - already held by an earlier attempt for this marker and kept for good (the
 *   alert went, and the run stopped before the clear): `settled`, with no send;
 * - held by an earlier attempt still marked "no email yet" (#5255: a hung or
 *   failed send, or an uncertain claim whose give-backs failed), held for a day
 *   after an attempt nobody could receive, or this attempt reached nobody or
 *   threw (the claim is held a day or given back): `unreached`, so the marker
 *   waits the kind's longer retry, by when the claim is kept (the rerun
 *   settles), or released or given back by the sweep (the rerun sends);
 * - the claim call itself threw (its uncertain claim is given back), or the
 *   held claim's state cannot be read: `threw`.
 *
 * Never throws.
 */
import {
  giveBackOwnOnceEverClaim,
  readOnceEverClaimState,
  sendAdminAlertOnceEverClaim,
} from "@/lib/admin-alert-once";
import type { AdminAlertSendResult } from "@/lib/email/admin-alert-send-result";
import type { OwedNoticeOutcome } from "@/lib/owed-notice/deliver";
import type { OwedNoticeMarker } from "@/lib/owed-notice/store";

/** The once-ever claim's key for one marker's past-cut-off alert. */
export function pastCutoffAlertKey(marker: Pick<OwedNoticeMarker, "id">): string {
  return `owed-notice-past-cutoff:${marker.id}`;
}

export async function alertOfficersOncePastCutoff(
  marker: OwedNoticeMarker,
  { label, send, now = new Date() }: { label: string; send: () => Promise<AdminAlertSendResult>; now?: Date },
): Promise<OwedNoticeOutcome> {
  const key = pastCutoffAlertKey(marker);
  const context = { owedNoticeId: marker.id, kind: marker.kind, subjectId: marker.subjectId };
  const claim = await sendAdminAlertOnceEverClaim({ key, label, context, send });
  if (claim.kept) return "settled";
  if (claim.claimUncertain && claim.claimedAt) {
    await giveBackOwnOnceEverClaim({ key, label, context, claim: { claimedAt: claim.claimedAt, claimUncertain: true } });
    return "threw";
  }
  if (claim.claimedAt) return "unreached";
  // Another attempt holds the claim. Only one kept for good means the alert
  // went; one still awaiting its send may yet fail or be given back (#5255).
  // Classify at the read, never earlier: a competing claim made after `now`
  // and deferred would otherwise read as kept and settle an unsent alert.
  const readAt = new Date();
  try {
    return (await readOnceEverClaimState(key, readAt > now ? readAt : now)) === "kept" ? "settled" : "unreached";
  } catch {
    return "threw";
  }
}
