import logger from "@/lib/logger";
import { claimAlertCooldown } from "@/lib/alert-cooldown";

/*
 * #3635: the fail-open windowed claim, beside `alert-cooldown.ts` rather than
 * inside it so that it calls that module's `claimAlertCooldown` through its
 * import: a suite that mocks the cooldown still drives THIS rule for real.
 */

/**
 * CLAIM A REPEAT-ALERT WINDOW, AND SEND ANYWAY IF THE CLAIM CANNOT BE TAKEN
 * (#3635, the one home for the wave's three copies). For alerts about money
 * nothing will reconcile by itself, raised by an EVENT (a Xero delivery, a
 * settlement step) rather than by a run that re-selects the condition: a
 * claim that fails to be read may never be offered again, so staying silent is
 * the worse failure and a possible duplicate the acceptable one. That is the
 * opposite choice from `sendAdminAlertOnceEver` (fail-closed, because its
 * re-selecting run retries), and deliberately so.
 *
 * Callers, each keeping its own key shape and window, and why each sends anyway:
 * - #3638 manual-settlement conflict (`xero-inbound/settlement-conflicts.ts`),
 *   24 h, `SETTLEMENT_MONEY_ALERT_REPEAT_MS`: re-raised while Xero redelivers.
 * - #3638 second instrument (same file), 10 minutes in flight: the marker's
 *   `alertSentAt` is its once-ever record, and a lost claim only risks one
 *   duplicate beside a send that would otherwise wait for the next delivery.
 * - #3642 group settlement invoice (`group-settlement-invoice-alerts.ts`),
 *   24 h, `SETTLEMENT_MONEY_ALERT_REPEAT_MS`: re-fetched on every Xero event.
 * - #3643 Internet Banking hold kept or released (`internet-banking-hold-kept.ts`),
 *   once ever: a released hold is never selected again. Its after-send handling
 *   (give back, owed marker) is its own, documented there.
 *
 * @returns true when the caller should send.
 */
export async function claimAlertCooldownFailOpen({
  key,
  windowMs,
  now,
  context,
  logMessage,
}: {
  key: string;
  windowMs: number;
  /** The claim's stamp, for a caller that may give the claim back later. */
  now?: Date;
  /** Logged with the claim failure. */
  context: Record<string, unknown>;
  /** The line logged when the claim fails and the alert is sent anyway. */
  logMessage: string;
}): Promise<boolean> {
  return claimAlertCooldown({ key, windowMs, now }).catch((err) => {
    logger.error({ err, key, ...context }, logMessage);
    return true;
  });
}

/**
 * The repeat window of a settlement-money alert (#2262, #3638, #3642): a
 * redelivery re-counts the conflict without re-mailing the admins more than
 * once a day while it stays unreconciled.
 */
export const SETTLEMENT_MONEY_ALERT_REPEAT_MS = 24 * 60 * 60 * 1000;
