/**
 * The environment-safety half of the email delivery boundary (ENV-SAFETY 2,
 * #3035; epic #2986). INV-CONFIG-004.
 *
 * `sendEmail` asks this once per message, immediately before it would open a
 * transport. It exists as its own module for two reasons: `core.ts` is already
 * the longest module in the mail layer and this is a self-contained decision, and
 * keeping the EmailLog bookkeeping here means the withhold shapes can be read
 * side by side rather than inferred from scattered `prisma.emailLog.update`
 * calls.
 *
 * WHAT IS WRITTEN, AND WHY THE TWO ROWS DIFFER.
 *
 * NOTHING IS WRITTEN AT ALL for a copy that has DECLARED a local capture mailbox,
 * because nothing was withheld there: it really transmits, into a mailbox that
 * cannot deliver onward, and the row goes on to be `SENT` like any other.
 * Recording that as a withhold would be false, and would inflate the withheld
 * count the admin panel reads.
 *
 * - **Confirmed NON_PRODUCTION** -> `SKIPPED_NON_PRODUCTION`, a brand-new
 *   terminal status, with the retained HTML dropped. Terminal because there is
 *   nothing to retry: a copy is a copy until somebody re-declares it, and if they
 *   do, replaying weeks of stale confirmations at real members would be worse
 *   than not sending them. Its own status rather than a reuse of
 *   `SKIPPED_NO_EMAILS`, because that value means "the club decided not to email
 *   this person about this booking" and conflating the two would make the
 *   booking's withheld list claim an admin decision nobody made — and would make
 *   the withheld-email count this issue owes #3034 uncountable.
 * - **A capture transport on the club's LIVE site** -> `FAILED` with
 *   `deliveryBlockReason` `CAPTURE_TRANSPORT_IN_PRODUCTION`, and whatever HTML the
 *   row holds kept. A misconfiguration rather than an environment fact, and
 *   retryable for exactly the same reason as the row below: correct the flags and
 *   the mail goes out.
 * - **A capture transport on a copy whose host is a PUBLIC mail host** -> `FAILED`
 *   with `deliveryBlockReason` `CAPTURE_TRANSPORT_PUBLIC_HOST` (#3071 review,
 *   hoppers99). Its own value rather than a reuse of the one above, because that
 *   one asserts the installation is the club's live site and
 *   `environment-safety-withheld.ts` counts it separately as exactly that alarm —
 *   writing it from a copy would raise a live-site emergency that is not
 *   happening. Retryable: point `EMAIL_SERVER_HOST` at the capture and the mail
 *   goes into it.
 * - **UNKNOWN** -> `FAILED` with `deliveryBlockReason` set, and whatever HTML the
 *   row holds kept. Retryable on purpose, so the message goes out by itself the
 *   moment an operator declares the role — the same self-healing shape the
 *   `booking_flag_unreadable` fail-closed withhold already uses. The nullable
 *   column is what makes it distinguishable from a transport failure by something
 *   sturdier than a message string.
 *
 * WHICH IS SELF-HEALING ONLY WHEN THERE IS A BODY TO REPLAY, and for twenty-six
 * templates there never is (#3035 review). `sendEmail` persists no rendered body
 * for `SENSITIVE_EMAIL_LOG_TEMPLATES` — `booking-confirmed`,
 * `pre-arrival-reminder`, `split-guest-payment-link`, `age-up-invitation`, every
 * token template — nor for any message whose log recipient is redacted, because a
 * live sign-in link, a door code or a payment link must not sit at rest. The
 * retry cron only selects rows that still hold a body, so those rows were never
 * replayed; and `attempts` defaults to 1 while the operator review queue selects
 * `attempts >= 3`, so they surfaced in NO queue either. Silently, permanently
 * lost, while this file and six other places told the operator it would go out by
 * itself.
 *
 * So such a row is written at the retry CEILING, which drops it out of the retry
 * query and lands it in the email-failure review queue — the retry cron's own
 * remedy for the same shape — and every sentence about it says "re-send it by
 * hand" instead. Retaining the body for those templates is not the fix; it is the
 * hazard they are excluded for.
 *
 * NO ADMIN ALERT IS RAISED, deliberately, and this is the one place the design
 * differs from the #2258 fail-closed withhold beside it. That alert is an EMAIL,
 * so on the UNKNOWN path it would be held back by this very gate; on the
 * NON_PRODUCTION path it would mail the club's real admins from a copy, which is
 * precisely what this epic exists to stop. The unresolved state is already loud
 * where it can be acted on: the boot log, the `environment-role` setup step and
 * the Admin -> Environment panel (all #3034).
 */

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  describeDeliveryDecision,
  resolveDeliveryPolicy,
  type DeliveryBlockReason,
  type DeliveryClearance,
  type DeliveryReplayability,
} from "@/lib/environment-delivery-policy";
import type { EmailDeliveryBlockReason } from "@prisma/client";

/**
 * The email retry cron's `MAX_ATTEMPTS`, and the operator review queue's
 * `attempts >= 3` threshold. One number serving both, and they are the same
 * number by design: at the ceiling a row leaves the retry query and enters the
 * review queue.
 *
 * DUPLICATED RATHER THAN IMPORTED, deliberately: `cron-email-retry.ts` imports
 * `@/lib/email` for its failure alert, so importing its constant here would make
 * the mailer depend on the cron that depends on the mailer.
 * `email-retry-attempt-ceiling` in the boundary census pins the three copies
 * against each other so they cannot drift.
 */
const EMAIL_RETRY_CEILING = 3;

/** How a blocked-environment reason is persisted on the mail log. */
const BLOCK_REASON_COLUMN: Record<DeliveryBlockReason, EmailDeliveryBlockReason> = {
  declaration_missing: "ENVIRONMENT_DECLARATION_MISSING",
  declaration_invalid: "ENVIRONMENT_DECLARATION_INVALID",
  override_unreadable: "ENVIRONMENT_OVERRIDE_UNREADABLE",
};

export type EmailEnvironmentGate =
  | { decision: "send"; clearance: DeliveryClearance }
  | { decision: "withheld"; reason: EmailEnvironmentWithheldReason };

/**
 * Why the boundary held a message back.
 *
 * ONE of these is terminal and the rest are faults, and that is the distinction
 * every caller keys on — see `additional-payment-resend-service.ts`, which must
 * not hand a reminder stamp back for a message the retry cron is going to replay.
 * Callers therefore test `reason !== "environment_non_production"` rather than
 * enumerating the faults, so a fault added later is replayable by default.
 */
export type EmailEnvironmentWithheldReason =
  | "environment_non_production"
  | "environment_unknown"
  | "capture_transport_in_production"
  /**
   * A copy declaring a capture mailbox whose `EMAIL_SERVER_HOST` is a public mail
   * host (#3071 review, hoppers99). A fault, and replayable by the rule above —
   * fix the host and the mail goes into the capture by itself.
   */
  | "capture_transport_public_host";

/**
 * Decide whether this installation may transmit, and record the outcome when it
 * may not.
 *
 * `logRecipient` is whatever the caller has already decided is safe to persist —
 * `sendEmail` redacts it for the templates that must not retain an address, and
 * this module does not second-guess that.
 */
export async function resolveEmailEnvironmentGate(params: {
  emailLogId: string | null;
  templateName: string;
  logRecipient: string;
  /**
   * Whether THIS row will hold a body the email retry cron could replay.
   *
   * `sendEmail`'s own `persistHtmlBody`, threaded in rather than recomputed here
   * so the gate cannot disagree with the row that was actually written. It is
   * false for the twenty-six `SENSITIVE_EMAIL_LOG_TEMPLATES` and for any message
   * whose log recipient is redacted.
   */
  bodyRetainedForReplay: boolean;
}): Promise<EmailEnvironmentGate> {
  const decision = await resolveDeliveryPolicy();
  if (decision.kind === "allow") {
    return { decision: "send", clearance: decision.clearance };
  }

  const suppressed = decision.kind === "suppress_non_production";
  const replay: DeliveryReplayability = params.bodyRetainedForReplay
    ? "replayed-automatically"
    : "needs-a-manual-resend";
  const errorMessage = describeDeliveryDecision(decision, replay);
  /*
    EXHAUSTIVE BY COMPILATION, RATHER THAN BY A TRAILING FALLBACK (#3071 review,
    hoppers99).

    This was two ternary chains ending `: "environment_unknown"` and `: null`, and
    that trailing branch is what made adding a delivery outcome unsafe: the new
    `block_capture_public_host` fell into it silently and would have been recorded
    as "nobody has declared what this installation is" — false, it is a declared
    copy — carrying a NULL block reason, which drops the row out of the
    withheld-email count `INV-CONFIG-004` defines as `FAILED` plus a non-null
    reason. Two wrong facts about a message that was not sent, from a default
    nobody chose.

    Adding the case to the chain would have fixed today and left the next one
    exposed, so the shape changed instead. The `never` assignment means a seventh
    outcome is a COMPILE ERROR here, not a silent mis-bucket — the same reason
    this module's `BLOCK_REASON_COLUMN` is a total `Record` rather than a lookup
    with a default.
  */
  const [reason, blockReason]: [
    EmailEnvironmentWithheldReason,
    EmailDeliveryBlockReason | null,
  ] = (() => {
    switch (decision.kind) {
      case "suppress_non_production":
        // Terminal, and recorded as its own STATUS rather than a block reason —
        // see the row write below.
        return ["environment_non_production", null];
      case "block_capture_in_production":
        return [
          "capture_transport_in_production",
          "CAPTURE_TRANSPORT_IN_PRODUCTION",
        ];
      case "block_capture_public_host":
        return [
          "capture_transport_public_host",
          "CAPTURE_TRANSPORT_PUBLIC_HOST",
        ];
      case "block_environment_unknown":
        return ["environment_unknown", BLOCK_REASON_COLUMN[decision.reason]];
      default: {
        const unhandled: never = decision;
        throw new Error(
          `Unhandled delivery outcome in the mail environment gate: ${JSON.stringify(unhandled)}. Every outcome must name its own withheld reason and block reason (INV-CONFIG-004).`,
        );
      }
    }
  })();

  if (params.emailLogId) {
    try {
      await prisma.emailLog.update({
        where: { id: params.emailLogId },
        data: suppressed
          ? {
              status: "SKIPPED_NON_PRODUCTION",
              htmlBody: null,
              bookingRetryHtmlBody: null,
              errorMessage,
            }
          : {
              status: "FAILED",
              deliveryBlockReason: blockReason,
              errorMessage,
              /*
                A ROW NOTHING CAN REPLAY IS PUT WHERE A PERSON WILL SEE IT
                (#3035 review). Left at `attempts: 1` such a row surfaced
                NOWHERE: the retry cron requires a retained body, and the
                operator review queue selects `attempts >= 3`. So the message was
                silently and permanently lost, while seven places in this
                codebase told the operator it would go out by itself.

                Pushing attempts to the ceiling is the retry cron's own remedy
                for the same shape — see `cron-email-retry.ts`, which does
                exactly this to a booking email it cannot verify and says why:
                it "drops it out of the query and lands it in the review queue,
                which is what the operator needs". Retaining the body instead is
                not an option; these templates are excluded from retention
                precisely because they carry live tokens, door codes and payment
                links.
              */
              ...(params.bodyRetainedForReplay
                ? {}
                : { attempts: EMAIL_RETRY_CEILING }),
            },
      });
    } catch (err) {
      logger.error(
        { err, to: params.logRecipient, templateName: params.templateName },
        suppressed
          ? "Failed to record an email held back because this installation is a copy"
          : "Failed to record an email held back because this installation's environment role is unknown",
      );
    }
  }

  if (suppressed) {
    logger.info(
      { to: params.logRecipient, templateName: params.templateName },
      "Held back an email: this installation is not the club's live site, so no provider was contacted",
    );
  } else {
    logger.error(
      {
        to: params.logRecipient,
        templateName: params.templateName,
        blockReason,
        replayable: params.bodyRetainedForReplay,
      },
      decision.kind === "block_capture_in_production"
        ? params.bodyRetainedForReplay
          ? "Did not send an email: this deployment declares itself the club's live site AND declares a local capture mailbox, so it would accept every message and deliver none. No provider was contacted. It is queued and goes out once the transport flags are corrected"
          : "Did not send an email: this deployment declares itself the club's live site AND declares a local capture mailbox, so it would accept every message and deliver none. No provider was contacted. This message keeps no stored copy, so it must be re-sent by hand once the transport flags are corrected; it is in the email-failure review queue"
        : decision.kind === "block_capture_public_host"
          ? params.bodyRetainedForReplay
            ? "Did not send an email: this copy declares a local capture mailbox but EMAIL_SERVER_HOST is a public mail host, so the capture would have delivered this message to a real member. No provider was contacted. It is queued and goes out once EMAIL_SERVER_HOST points at the capture"
            : "Did not send an email: this copy declares a local capture mailbox but EMAIL_SERVER_HOST is a public mail host, so the capture would have delivered this message to a real member. No provider was contacted. This message keeps no stored copy, so it must be re-sent by hand once EMAIL_SERVER_HOST points at the capture; it is in the email-failure review queue"
        : params.bodyRetainedForReplay
          ? "Did not send an email: nothing has confirmed whether this installation is the club's live site or a copy, so no provider was contacted. It is queued and will go out once the environment role is declared"
          : "Did not send an email: nothing has confirmed whether this installation is the club's live site or a copy, so no provider was contacted. This message keeps no stored copy, so it must be re-sent by hand once the role is declared; it is in the email-failure review queue",
    );
  }

  return { decision: "withheld", reason };
}
