import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

// Long enough to outlast bounded provider requests and a delayed heartbeat.
const LEASE_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;

/** A committed lease, never a transaction around provider work. */
export async function withCronRunClaim<T>(
  jobName: string,
  work: (assertOwned: () => Promise<void>) => Promise<T>,
  db = prisma,
): Promise<{ claimed: false } | { claimed: true; result: T }> {
  const owner = randomUUID();
  const now = new Date();
  const claimed = await db.$transaction(async (tx) => {
    // INV-LOCK-001/002/003: run coordination only; never nests domain locks.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cron-run-claim'), hashtext(${jobName}))`;
    await tx.cronRunClaim.upsert({
      where: { jobName },
      create: { jobName, expiresAt: new Date(0) },
      update: {},
    });
    return tx.cronRunClaim.updateMany({
      where: { jobName, expiresAt: { lte: now } },
      data: { owner, expiresAt: new Date(now.getTime() + LEASE_MS) },
    });
  });
  if (claimed.count !== 1) return { claimed: false };

  // A failed/expired renewal fails closed. Never renew or release a successor.
  let lost = false;
  let renewal: Promise<void> | undefined;
  const renew = async () => {
    try {
      const at = new Date();
      const updated = await db.cronRunClaim.updateMany({
        where: { jobName, owner, expiresAt: { gt: at } },
        data: { expiresAt: new Date(at.getTime() + LEASE_MS) },
      });
      if (updated.count !== 1) lost = true;
    } catch {
      lost = true;
    }
  };
  const assertOwned = async () => {
    if (renewal) await renewal;
    if (!lost) await renew();
    if (lost) throw new Error("The sync run claim was lost; retry the sync.");
  };
  const timer = setInterval(() => {
    if (!renewal && !lost) {
      renewal = renew().finally(() => { renewal = undefined; });
    }
  }, HEARTBEAT_MS);
  timer.unref();
  try {
    const result = await work(assertOwned);
    await assertOwned();
    return { claimed: true, result };
  } finally {
    clearInterval(timer);
    if (renewal) await renewal;
    await db.cronRunClaim.updateMany({
      where: { jobName, owner },
      data: { owner: null, expiresAt: new Date(0) },
    });
  }
}
