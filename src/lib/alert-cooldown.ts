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
 * Give a claimed window back (#3643). For a caller whose window is "once, ever"
 * and whose send can fail: a claim kept after an undelivered send would make
 * the one notification disappear for good, so the caller releases it and the
 * next run tries again.
 */
export async function releaseAlertCooldown({
  key,
  store = prisma,
}: {
  key: string;
  store?: Pick<typeof prisma, "alertCooldown">;
}): Promise<void> {
  await store.alertCooldown.deleteMany({ where: { key } });
}
