import { prisma } from "@/lib/prisma";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";

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
 * send threw before reaching anyone — so the next run can claim and send
 * again (#3672). A send that reached nobody is deferred instead
 * (`deferAlertCooldown`), never given back (#3635 F1).
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

/**
 * The owed markers under `prefix` that are due: last marked or attempted at
 * least `retryAfterMs` before `now` (#3635 F1), so an alert nobody can
 * receive is tried at most once per `retryAfterMs`, never every run.
 */
export async function listOwedAlertKeys({
  prefix,
  now = new Date(),
  retryAfterMs,
  store = prisma,
}: {
  prefix: string;
  now?: Date;
  retryAfterMs: number;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<string[]> {
  const rows = await store.alertCooldown.findMany({
    where: {
      key: { startsWith: prefix },
      lastAlertedAt: { lte: new Date(now.getTime() - retryAfterMs) },
    },
    select: { key: true },
    orderBy: { lastAlertedAt: "asc" },
    take: 50,
  });
  return rows.map((row) => row.key);
}

/**
 * Stamp an owed marker as attempted at `now` without settling it (#3635 F1):
 * the drain tried and nobody received it, so it waits `retryAfterMs` again.
 */
export async function noteOwedAlertAttempt({
  key,
  now = new Date(),
  store = prisma,
}: {
  key: string;
  now?: Date;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<void> {
  await store.alertCooldown.updateMany({ where: { key }, data: { lastAlertedAt: now } });
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
