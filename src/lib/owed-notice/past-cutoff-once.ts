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
 * - already held by another attempt and kept for good (the alert went, and
 *   the run stopped before the clear, or another marker sharing the key sent
 *   it): `settled`, with no send. Only a claim older than the caller's wait
 *   (`inFlightMs`) reads as kept; a younger one may still be in flight, its
 *   send not yet known, so the step answers `threw` and its marker is offered
 *   again a wait later, when the holder's outcome shows (#5433 review E);
 * - held by nobody any more (given back between the claim and the read):
 *   `threw`, so the next attempt claims it;
 * - held for a day after an attempt nobody could receive, or this attempt
 *   reached nobody or threw (the claim is held a day or given back):
 *   `unreached`, so the marker waits the kind's longer retry;
 * - the claim call itself threw: the uncertain claim is given back and the
 *   step answers `threw`.
 *
 * Never throws.
 */
import {
  giveBackOwnOnceEverClaim,
  readHeldOnceEverAlertTimes,
  sendAdminAlertOnceEverClaim,
} from "@/lib/admin-alert-once";
import { ALERT_ONCE_EVER_WINDOW_MS } from "@/lib/alert-cooldown";
import type { AdminAlertSendResult } from "@/lib/email/admin-alert-send-result";
import type { OwedNoticeOutcome } from "@/lib/owed-notice/deliver";
import type { OwedNoticeMarker } from "@/lib/owed-notice/store";

/** The once-ever claim's key for one marker's past-cut-off alert. */
export function pastCutoffAlertKey(marker: Pick<OwedNoticeMarker, "id">): string {
  return `owed-notice-past-cutoff:${marker.id}`;
}

export async function alertOfficersOncePastCutoff(
  marker: OwedNoticeMarker,
  {
    label,
    send,
    inFlightMs,
    now = new Date(),
  }: {
    label: string;
    send: () => Promise<AdminAlertSendResult>;
    /** The calling kind's wait: a claim held for less than this may still be in flight. */
    inFlightMs: number;
    now?: Date;
  },
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
  // Another attempt holds the claim. A claim kept for good carries its send's
  // time; one held for a day after nobody received it is dated back by almost
  // the whole once-ever window (`deferAlertCooldown`), so the two are apart. A
  // claim younger than the caller's wait may be a send still running.
  let heldAt: Date | undefined;
  try {
    heldAt = (await readHeldOnceEverAlertTimes([key], now)).get(key);
  } catch {
    return "threw";
  }
  if (!heldAt || heldAt.getTime() > now.getTime() - inFlightMs) return "threw";
  return heldAt.getTime() > now.getTime() - ALERT_ONCE_EVER_WINDOW_MS / 2 ? "settled" : "unreached";
}
