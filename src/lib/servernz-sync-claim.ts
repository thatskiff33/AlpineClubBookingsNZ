import "server-only";
import { prisma } from "@/lib/prisma";
import { SERVERNZ_SETTINGS_ID } from "@/lib/servernz-settings";

/**
 * Single-flight claim for an Other Clubs sync pass.
 *
 * WHY IT EXISTS. The nightly cron and the admin Upload/Download buttons drive
 * exactly the same writers. `instrumentation.node.ts` holds an in-process boolean
 * (`isAlpineServerSyncRunning`) which stops one container overlapping itself and
 * nothing else — it cannot see a second container, the HTTP cron route, or an
 * admin pressing a button. `claimBackupRun` (#2095) exists for the same pairing.
 *
 * WHY A STATUS-GUARDED CLAIM RATHER THAN AN ADVISORY LOCK. Both advisory forms
 * are wrong here, and neither wrongness is obvious:
 *
 *  - A SESSION-scoped `pg_advisory_lock` would be taken and released through
 *    Prisma's connection POOL, so the unlock can execute on a different
 *    connection than the lock. The lock then never releases and the sync is
 *    wedged until the pool recycles.
 *  - An XACT-scoped `pg_advisory_xact_lock` releases at COMMIT, so covering the
 *    pass means holding a database transaction open across the central server's
 *    HTTP calls — the thing `docs/CONCURRENCY_AND_LOCKING.md` tells writers not
 *    to do, and with a 10s-per-request timeout it is a long transaction.
 *
 * So this uses the repo's own status-guarded claim instead: a conditional
 * `updateMany` whose `count` IS the claim (`INV-LOCK` is not engaged at all — this
 * writer touches no booking, capacity, settlement, credit or lifecycle state, so
 * it correctly joins neither the global cohort nor a lodge key). A lost claim runs
 * no side effect: the caller returns `null` and makes no request.
 *
 * STALENESS. A container killed mid-pass would otherwise hold the claim forever,
 * so a claim older than the window is reaped by the same guarded update rather
 * than by a sweeper. The window is generous relative to a real pass (two requests,
 * each capped at 10s by the API client) because reaping early is worse than
 * reaping late: two overlapping passes are merely wasteful, whereas a wedged sync
 * is silent.
 */
const STALE_CLAIM_AFTER_MS = 15 * 60 * 1000;

/**
 * The one word for "another pass holds the claim" (#66): the nightly job's
 * skip reason and the code on the Upload/Download buttons' 409, so a reader
 * finding either finds the same fact.
 */
export const OTHER_LODGES_SYNC_RUNNING_CODE = "sync-already-running";

/**
 * Run `fn` while holding the sync claim, or return `null` when another process
 * already holds it.
 */
export async function withOtherLodgesSyncClaim<T>(
  fn: () => Promise<T>,
  now: Date = new Date(),
): Promise<T | null> {
  const staleCutoff = new Date(now.getTime() - STALE_CLAIM_AFTER_MS);

  // The guarded claim. `updateMany` returns the number of rows it matched, so a
  // count of 1 means THIS caller moved the column from "free or stale" to "held",
  // atomically, and any concurrent caller matched zero rows.
  const claim = await prisma.serverNzSettings.updateMany({
    where: {
      id: SERVERNZ_SETTINGS_ID,
      OR: [
        { otherLodgesSyncStartedAt: null },
        { otherLodgesSyncStartedAt: { lt: staleCutoff } },
      ],
    },
    data: { otherLodgesSyncStartedAt: now },
  });

  if (claim.count === 0) return null;

  try {
    return await fn();
  } finally {
    // Release regardless of outcome: a failed pass must not wedge the next one.
    // Scoped to OUR claim instant so a later run that reaped this one as stale is
    // not released out from under itself.
    await prisma.serverNzSettings.updateMany({
      where: { id: SERVERNZ_SETTINGS_ID, otherLodgesSyncStartedAt: now },
      data: { otherLodgesSyncStartedAt: null },
    });
  }
}
