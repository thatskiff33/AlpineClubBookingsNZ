/**
 * #5433: a kind's past-cut-off officer alert, sent at most once per claim key.
 *
 * The sweep runs a kind's `pastCutoff` step at least once: a stop after the
 * step returns and before the marker is cleared runs it again. Owner decision
 * D1 says officers are alerted once when a member's notice passes its cut-off,
 * so a kind sends that alert through here: a once-ever claim keyed on the
 * marker's id, which a rerun for the same marker (or another marker sharing
 * the key: the waitlist offer's email and its never-told lapse, D5) loses.
 *
 * Through `sendAdminAlertOnceEverWithTakeover`, the one sequence for a
 * once-ever alert whose caller retries until it is out (round 2, item 5e), with
 * a sent stamp of its own (`pastCutoffSentKey`, written once an officer has the
 * alert or the email retry cron holds a copy) as its `isSent`. So a claim held
 * by another attempt is read by what happened, not by its age:
 * - the holder's alert went (the sent stamp): `settled`, nothing sent again;
 * - the holder may still be sending (its claim younger than the caller's wait):
 *   `threw`, so the marker is offered again a wait later;
 * - the holder died after claiming (an older claim with no sent stamp): taken
 *   over, given back and sent once more; a sibling that re-claimed first makes
 *   it `threw`;
 * - this attempt's own send reached nobody, threw, or its claim write failed:
 *   `unreached`, so the marker waits the kind's longer retry.
 * Stated limit: the sent stamp is written twice before giving up
 * (`stampOnceEverAlertSent`); if both writes fail, a later attempt older than
 * the wait takes the claim over and the officers may get the alert twice.
 *
 * Never throws.
 */
import { readHeldOnceEverAlertTimes, stampOnceEverAlertSent } from "@/lib/admin-alert-once";
import { sendAdminAlertOnceEverWithTakeover } from "@/lib/admin-alert-once-takeover";
import { adminAlertIsDeliveredOrQueued, type AdminAlertSendResult } from "@/lib/email/admin-alert-send-result";
import logger from "@/lib/logger";
import type { OwedNoticeOutcome } from "@/lib/owed-notice/deliver";
import type { OwedNoticeMarker } from "@/lib/owed-notice/store";

/** The once-ever claim's key for one marker's past-cut-off alert. */
export function pastCutoffAlertKey(marker: Pick<OwedNoticeMarker, "id">): string {
  return `owed-notice-past-cutoff:${marker.id}`;
}

/** The stamp written once that alert went out: the claim's `isSent`. */
export function pastCutoffSentKey(marker: Pick<OwedNoticeMarker, "id">): string {
  return `owed-notice-past-cutoff-sent:${marker.id}`;
}

export async function alertOfficersOncePastCutoff(
  marker: OwedNoticeMarker,
  {
    label,
    send,
    inFlightMs,
  }: {
    label: string;
    send: () => Promise<AdminAlertSendResult>;
    /** The calling kind's wait: another holder's claim younger than this may still be sending. */
    inFlightMs: number;
  },
): Promise<OwedNoticeOutcome> {
  const key = pastCutoffAlertKey(marker);
  const sentKey = pastCutoffSentKey(marker);
  const context = { owedNoticeId: marker.id, kind: marker.kind, subjectId: marker.subjectId };
  try {
    const outcome = await sendAdminAlertOnceEverWithTakeover({
      key,
      label,
      context,
      inFlightMs,
      send: async () => {
        const result = await send();
        if (adminAlertIsDeliveredOrQueued(result)) await stampOnceEverAlertSent(sentKey, label, context);
        return result;
      },
      isSent: async () => (await readHeldOnceEverAlertTimes([sentKey], new Date())).has(sentKey),
    });
    switch (outcome) {
      case "settled":
        return "settled";
      case "in-flight":
      case "taken-over":
        return "threw";
      case "not-sent":
        return "unreached";
    }
  } catch (err) {
    logger.error({ ...context, err }, `Failed to read the ${label}'s claim; it stays owed`);
    return "threw";
  }
}
