/**
 * The one rule behind every stamp-guarded claim of an owed marker (#5407,
 * #5433), whichever table holds the marker: `OwedNotice` (`./store.ts`) or a
 * legacy `AlertCooldown` row (`claimOwedAlert` and `deferAlertCooldown` in
 * `alert-cooldown.ts`). Each table writes its own guarded statement; the
 * stamps they write come from here, so the two cannot drift (`INV-SSOT-001`).
 */

/**
 * The stamp a claim writes: `now`, kept strictly later than the bound it was
 * guarded on. A frozen or coarse clock could otherwise hand two callers the
 * same instant, and the own-claim guard on the settle could not tell them apart.
 */
export function claimStampAfter(stampedNoLaterThan: Date, now: Date): Date {
  return new Date(Math.max(now.getTime(), stampedNoLaterThan.getTime() + 1));
}

/**
 * Take a claim: `write` runs the table's guarded update (stamp no later than
 * the bound, moved to the returned stamp) and reports how many rows matched.
 * Exactly one match is a won claim, and its stamp is returned for the settle's
 * own-claim guard; anything else is a lost claim, and its caller must send
 * nothing.
 */
export async function claimByStamp(
  stampedNoLaterThan: Date,
  now: Date,
  write: (claimedAt: Date) => Promise<{ count: number }>,
): Promise<Date | null> {
  const claimedAt = claimStampAfter(stampedNoLaterThan, now);
  const claimed = await write(claimedAt);
  return claimed.count === 1 ? claimedAt : null;
}

/**
 * The stamp that holds a claimed marker for `retryAfterMs` instead of the
 * usual `waitMs`: moved so that a sweep waiting `waitMs` after the stamp
 * offers it again exactly `retryAfterMs` after the claim. It can lie in the
 * future, which is the point.
 */
export function deferredStamp(claimedAt: Date, waitMs: number, retryAfterMs: number): Date {
  return new Date(claimedAt.getTime() - waitMs + retryAfterMs);
}
