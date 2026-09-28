import { prisma } from "@/lib/prisma";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import logger from "@/lib/logger";

/**
 * Cross-instance alert cooldown (#1211, extracted for reuse by #2262).
 *
 * One `AlertCooldown` row per alert key. A caller CLAIMS the window before
 * sending, so N app instances raise at most one alert per window instead of one
 * per instance: the conditional `updateMany` only matches when the last alert is
 * older than the window, so a single caller wins the write; on a miss the row is
 * either fresh-within-window (someone else already alerted) or does not exist
 * yet (first alert ever), and the unique-guarded create decides that race.
 *
 * ALWAYS claim first and send afterwards, with the provider call OUTSIDE any
 * database transaction. The tiny residual double-send window (two instances
 * reading between claim attempts) is bounded and acceptable for noise control;
 * it must never be relied on for money correctness.
 *
 * @returns true when this caller holds the claim and should send.
 */
export async function claimAlertCooldown({
  key,
  windowMs,
  now = new Date(),
  store = prisma,
}: {
  key: string;
  windowMs: number;
  now?: Date;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<boolean> {
  const windowStart = new Date(now.getTime() - windowMs);

  const claimed = await store.alertCooldown.updateMany({
    where: { key, lastAlertedAt: { lt: windowStart } },
    data: { lastAlertedAt: now },
  });
  if (claimed.count > 0) return true;

  try {
    await store.alertCooldown.create({ data: { key, lastAlertedAt: now } });
    return true;
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) return false;
    throw error;
  }
}

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

/**
 * A window no stay outlives: claiming with it means "alert once, ever" for its
 * key (#3672). One named constant so every once-only alert shares it.
 */
export const ALERT_ONCE_EVER_WINDOW_MS = 36_500 * 86_400_000;

/**
 * How long a claim whose alert nobody could receive (no admin opted in, the
 * template switched off, every recipient suppressed) is held before the next
 * run may try again (#3672): daily, not every run.
 */
export const ALERT_NOBODY_ELIGIBLE_RETRY_MS = 86_400_000;

/**
 * Give back a claim this caller took at `claimedAt` and could not use — the
 * send threw before reaching anyone, or (#3643) reached nobody for a hold that
 * stays a candidate — so the next run can claim and send again (#3672).
 * Deletes only a row still stamped with this caller's own claim, so a newer
 * claim by another sender is never released.
 */
export async function releaseAlertCooldown({
  key,
  claimedAt,
  store = prisma,
}: {
  key: string;
  claimedAt: Date;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<void> {
  await store.alertCooldown.deleteMany({ where: { key, lastAlertedAt: claimedAt } });
}

/**
 * Hold a claim this caller took at `claimedAt` for `retryAfterMs` only, rather
 * than the whole `windowMs` (#3672): the stamp is moved back so the row falls
 * out of the window, and `claimAlertCooldown` with the same `windowMs` succeeds
 * again, exactly `retryAfterMs` after the claim. Same own-stamp guard as
 * `releaseAlertCooldown`, so a newer claim by another sender is never touched.
 */
export async function deferAlertCooldown({
  key,
  claimedAt,
  windowMs,
  retryAfterMs,
  store = prisma,
}: {
  key: string;
  claimedAt: Date;
  windowMs: number;
  retryAfterMs: number;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<void> {
  await store.alertCooldown.updateMany({
    where: { key, lastAlertedAt: claimedAt },
    data: { lastAlertedAt: new Date(claimedAt.getTime() - windowMs + retryAfterMs) },
  });
}

/**
 * An alert that could not be delivered and whose subject no run will select
 * again (#3643: a hold already released). The marker is the durable "owed";
 * the next run drains it (`listOwedAlertKeys`) and settles it once delivered.
 * The key is its own namespace, beside the window key the send claimed.
 */
export async function markAlertOwed({
  key,
  now = new Date(),
  store = prisma,
}: {
  key: string;
  now?: Date;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<void> {
  try {
    await store.alertCooldown.create({ data: { key, lastAlertedAt: now } });
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) throw error;
  }
}

export async function listOwedAlertKeys({
  prefix,
  store = prisma,
}: {
  prefix: string;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<string[]> {
  const rows = await store.alertCooldown.findMany({
    where: { key: { startsWith: prefix } },
    select: { key: true },
    take: 50,
  });
  return rows.map((row) => row.key);
}

export async function settleOwedAlert({
  key,
  store = prisma,
}: {
  key: string;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<void> {
  await store.alertCooldown.deleteMany({ where: { key } });
}
