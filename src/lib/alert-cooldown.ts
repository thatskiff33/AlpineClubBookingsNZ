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
 * Give back a claim this caller took at `claimedAt` and could not use — the
 * send threw or reached nobody — so the next run can claim and send again
 * (#3672). Deletes only a row still stamped with this caller's own claim, so a
 * newer claim by another sender is never released.
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
