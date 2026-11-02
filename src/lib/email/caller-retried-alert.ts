/**
 * One retry owner per lost copy of a caller-retried admin alert (#4669).
 *
 * `isCallerRetriedAlertTemplate` names the alerts whose owner sends them again
 * when no recipient received them. They keep their bodies, so the email retry
 * cron replays a copy one recipient lost while another got it. When nobody got
 * it, the owner retries, and its new attempt writes new rows: the old rows must
 * not be replayed as well, or every recipient would get it twice.
 *
 * So the attempt's `FAILED` rows lose their body here, before the sender
 * returns to the owner. The body is dropped rather than the retry ceiling
 * written: the ceiling would put them in the email-failure review queue, asking
 * an operator to re-send what the owner already re-sends.
 *
 * THE RACE, and why no copy is replayed twice. The cron selects a row only 15
 * minutes after it was written (its backoff on `lastAttemptAt`), and this runs
 * as soon as every send has settled, so normally it has nothing to race. A send
 * that hangs past that leaves the cron free to claim a sibling's row, and its
 * claim is guarded on the exact body it read. Both writes are row-locked
 * single statements, so per row exactly one wins:
 * - this transaction first: the body is gone and the claim matches nothing;
 * - the claim first: its `attempts` has moved past the first attempt with its
 *   body kept, the count below sees it, and the whole transaction rolls back.
 *   Every row keeps its body and the cron replays each copy, so the owner must
 *   not: the sender reports `queued-for-retry`, and delivery then rests on the
 *   cron's own three attempts.
 *
 * The count reads only rows the cron could have claimed: past the first attempt
 * AND still holding a body (`RETAINS_REPLAYABLE_EMAIL_BODY`, the cron's own
 * selection). The environment gate writes a copy that keeps no body straight to
 * the retry ceiling; that row is not the cron's, and reading it as a claim would
 * stamp the alert sent with no copy queued anywhere. The block reason cannot
 * tell them apart: the claim leaves it set until the send's outcome clears it.
 */
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { RETAINS_REPLAYABLE_EMAIL_BODY } from "./retry-selection";

/** `EmailLog.attempts`'s default: a row no retry has claimed yet. */
const FIRST_ATTEMPT = 1;

/**
 * A few guarded updates and a count over one alert's rows (one per recipient).
 * A statement queues only behind short single-statement writers such as the
 * cron's claim, so the bound is generous; running out of it is a failed
 * release (below).
 */
const RELEASE_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

/** The rows were released, or the cron already holds one and keeps them all. */
type UnreceivedAlertRelease = "released" | "cron-holds-a-copy";

class CronHoldsACopy extends Error {}

/**
 * Make one attempt's `FAILED` rows non-replayable, all or none. A row that is
 * not `FAILED` (a suppressed copy is `BOUNCED` with no body) is left as it is.
 *
 * A release that fails for any other reason resolves `released`: the owner
 * then retries, and a row left holding its body could also be replayed. A
 * crash or restart after a copy's `FAILED` row was written and before the
 * release commits leaves the same two retries. Those are the two ways a copy
 * goes out twice, a stated limit chosen over losing the alert.
 */
export async function releaseUnreceivedAlertCopies(
  emailLogIds: readonly string[],
  templateName: string,
): Promise<UnreceivedAlertRelease> {
  if (emailLogIds.length === 0) return "released";
  const ids = [...emailLogIds];
  try {
    await prisma.$transaction(async (tx) => {
      const unclaimed = { id: { in: ids }, status: "FAILED" as const, attempts: FIRST_ATTEMPT };
      await tx.emailLog.updateMany({
        where: { ...unclaimed, deliveryBlockReason: null },
        data: { htmlBody: null },
      });
      // An environment fault's message promised a replay; say who sends it now.
      await tx.emailLog.updateMany({
        where: { ...unclaimed, deliveryBlockReason: { not: null } },
        data: {
          htmlBody: null,
          errorMessage:
            "Held back by the environment-safety boundary. No recipient received this alert, so it is sent again by the alert's own retry, not by the email retry cron (#4669).",
        },
      });
      const claimedByCron = await tx.emailLog.count({
        where: { id: { in: ids }, attempts: { gt: FIRST_ATTEMPT }, ...RETAINS_REPLAYABLE_EMAIL_BODY },
      });
      if (claimedByCron > 0) throw new CronHoldsACopy();
    }, RELEASE_TRANSACTION_OPTIONS);
    return "released";
  } catch (err) {
    if (err instanceof CronHoldsACopy) {
      logger.warn(
        { templateName, emailLogIds: ids },
        "No recipient received a caller-retried admin alert, but the email retry cron had already claimed a copy, so it keeps every copy and the alert's owner does not send it again",
      );
      return "cron-holds-a-copy";
    }
    logger.error(
      { err, templateName, emailLogIds: ids },
      "Could not release the failed copies of a caller-retried admin alert; its owner sends it again, and the email retry cron may replay a copy as well",
    );
    return "released";
  }
}
