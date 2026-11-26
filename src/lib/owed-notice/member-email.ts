/**
 * #5433: WHAT BECAME OF AN OWED MEMBER NOTICE'S EMAIL, read from its row.
 *
 * A member's owed notice sends with an event key, so its email has at most one
 * `EmailLog` row, at a known id (`durableEmailLogId`). A send that returns is
 * not proof the member was told: the email core returns without throwing for a
 * suppressed address (`BOUNCED`), a fail-closed "No emails" read or an
 * environment fault (`FAILED`), and an empty or placeholder address (no row at
 * all). So a kind that tells a member reads the row after its send, by the
 * shared told rule (`email/keyed-email-state.ts`), and answers the mechanism
 * here, one rule for every kind that uses it (`INV-SSOT-001`). The split guest
 * payment link's first attempt does not: it decides from what the send
 * returned, as before #5433, revoking a link whose email was not delivered so
 * the job's next extension sends a fresh one (`split-guest-payment-link-notice.ts`);
 * - told (sent, or withheld by "No emails" or a non-production copy): settled;
 * - held back by the installation's environment gate (an undeclared role, a
 *   misplaced capture transport): settled, as before #5433, because the gate
 *   writes that row to the retry ceiling and it waits in the email-failure
 *   review queue for an officer;
 * - held by the email retry cron (a replayable `FAILED` row, or one it is
 *   replaying): kept for it (`threw`), so a later sweep reads the row again;
 * - anything else (a failure nothing replays, a bounce or suppressed address,
 *   a fail-closed "No emails" read, no address at all: owner decisions D8,
 *   D9 and D11): the kind's officers' alert, once per marker
 *   (`alertOfficersOncePastCutoff`).
 * Past a kind's cut-off the same reading decides whether the officers are
 * alerted at all: a notice that did reach the member after all, or waits in
 * the review queue, needs no alert, and one the retry cron still holds waits.
 *
 * The wait and the maximum age every member kind of the confirm-pending job
 * shares are here too: the paid confirmation's (owner decision D7: after a
 * week of attempts, stop and alert officers once), which owner decision D10
 * applies to each member notice the job owes.
 *
 * Reads only, outside any transaction, and never throws.
 */
import { isToldKeyedEmailState, KEYED_EMAIL_ROW_SELECT, keyedEmailRowState, type KeyedEmailState } from "@/lib/email/keyed-email-state";
import logger from "@/lib/logger";
import type { OwedNoticeOutcome } from "@/lib/owed-notice/deliver";
import { prisma } from "@/lib/prisma";

/** How long after its stamp a sweep takes a member notice's marker, so the attempt right after the commit goes first. */
export const OWED_MEMBER_NOTICE_SWEEP_AFTER_MS = 30 * 60 * 1000;

/** A member notice still owed this long after its event is past its cut-off, whatever its own cut-off says (owner decision D7). */
export const OWED_MEMBER_NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A member notice's email, by the told rule, and whether the environment gate held it back. */
export interface OwedMemberEmailReading {
  state: KeyedEmailState;
  heldByEnvironment: boolean;
}

/**
 * The email at `emailLogId` by the shared told rule, and whether the
 * installation's environment gate held it back: such a row carries a block
 * reason (`email/environment-gate.ts`).
 */
export async function readOwedMemberEmail(emailLogId: string): Promise<OwedMemberEmailReading> {
  const row = await prisma.emailLog.findUnique({
    where: { id: emailLogId },
    select: { ...KEYED_EMAIL_ROW_SELECT, deliveryBlockReason: true },
  });
  return { state: keyedEmailRowState(row), heldByEnvironment: row?.deliveryBlockReason != null };
}

/** One member notice's email, as its kind describes it for the reading above. */
export interface OwedMemberEmail {
  emailLogId: string;
  /** What the email is, for the logs: "booking confirmation", say. */
  label: string;
  /** Ids only, for every log line. */
  log: Record<string, unknown>;
  /** The kind's officers' alert, once per marker. */
  alertOfficers: () => Promise<OwedNoticeOutcome>;
}

/**
 * After the send: what became of the email, read from its row, answered as
 * the module's header says. Never throws.
 */
export async function owedMemberEmailOutcome({ emailLogId, label, log, alertOfficers }: OwedMemberEmail): Promise<OwedNoticeOutcome> {
  try {
    const { state, heldByEnvironment } = await readOwedMemberEmail(emailLogId);
    if (isToldKeyedEmailState(state)) return "settled";
    if (heldByEnvironment) {
      logger.warn(log, `The ${label} was held back by this installation's environment gate; it waits in the email-failure review queue`);
      return "settled";
    }
    if (state === "retrying") {
      logger.info(log, `The email retry cron holds this ${label}; the owed notice waits for it`);
      return "threw";
    }
    logger.warn({ ...log, state }, `The ${label} did not reach the owner; alerting the officers instead`);
  } catch (err) {
    logger.error({ err, ...log }, `Failed to read the ${label}'s state after its send`);
    return "threw";
  }
  return alertOfficers();
}

/**
 * Past the kind's cut-off: alert the officers once, unless the email did reach
 * the member after all, or waits in the review queue. An email the retry cron
 * still holds (`retrying`) may yet go, so the marker is held for it, not
 * alerted on: telling officers it "will not be sent automatically" would be
 * false. The hard ceiling (`OWED_NOTICE_HARD_CEILING_MULTIPLE`) still clears
 * it, and once the cron gives up the row reads undeliverable and the alert
 * goes. A template whose body is never kept (`booking-confirmed`) is never
 * `retrying`. Never throws.
 */
export async function owedMemberEmailPastCutoff({ emailLogId, label, log, alertOfficers }: OwedMemberEmail): Promise<OwedNoticeOutcome> {
  try {
    const { state, heldByEnvironment } = await readOwedMemberEmail(emailLogId);
    if (isToldKeyedEmailState(state) || heldByEnvironment) return "settled";
    if (state === "retrying") {
      logger.info(log, `Past its cut-off, the email retry cron still holds this ${label}; the owed notice waits for it`);
      return "threw";
    }
  } catch (err) {
    logger.error({ err, ...log }, `Failed to read the ${label}'s state past its cut-off`);
    return "threw";
  }
  logger.error(log, `The ${label} passed its cut-off unsent; alerting the officers once`);
  return alertOfficers();
}
