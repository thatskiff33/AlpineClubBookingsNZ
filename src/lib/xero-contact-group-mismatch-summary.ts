/**
 * How the Xero contact-group mismatch count is worded (#5234).
 *
 * The count is two kinds of entry. A mismatch is a member a grouping rule
 * matches whose contact sits in the wrong managed group; the re-sync repairs
 * it. An information-only entry is a member no rule matches whose contact
 * still sits in a managed group (often an organisation put there by hand);
 * the re-sync never touches it, so someone removes it in Xero or adds a rule.
 *
 * The health tile, the Stuck States item and the mismatch panel all count both
 * kinds, so each words the total from here and the three surfaces agree.
 */

/**
 * How many flagged contacts the mismatch panel lists and a Refresh re-fetches
 * from Xero. The panel sends it on every GET and POST, and the route defaults
 * a POST with no limit to it, so a Refresh never re-fetches the whole flagged
 * population (#5234).
 */
export const CONTACT_GROUP_MISMATCH_LIMIT = 200;

export interface ContactGroupMismatchCounts {
  /** Mismatches the re-sync repairs. */
  resyncCount: number;
  /** Information-only entries, fixed by hand in Xero or with a new rule. */
  reviewByHandCount: number;
}

/**
 * The one total the health tile, Stuck States and the panel all show:
 * information-only entries count too (owner decision, #5234).
 */
export function contactGroupMismatchTotal({
  resyncCount,
  reviewByHandCount,
}: ContactGroupMismatchCounts): number {
  return resyncCount + reviewByHandCount;
}

/** The total split by kind, e.g. "2 to re-sync, 1 to review by hand". */
export function describeContactGroupMismatchCounts({
  resyncCount,
  reviewByHandCount,
}: ContactGroupMismatchCounts): string {
  const parts: string[] = [];
  if (resyncCount > 0) parts.push(`${resyncCount} to re-sync`);
  if (reviewByHandCount > 0) parts.push(`${reviewByHandCount} to review by hand`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/**
 * The health tile's wording. An older server sends only `count`, so word it
 * from the total alone until both split counts arrive (blue-green).
 */
export function describeContactGroupMismatchTotal(counts: {
  count: number;
  resyncCount?: number;
  reviewByHandCount?: number;
}): string {
  if (counts.resyncCount === undefined || counts.reviewByHandCount === undefined) {
    return `${counts.count} to review`;
  }
  return describeContactGroupMismatchCounts({
    resyncCount: counts.resyncCount,
    reviewByHandCount: counts.reviewByHandCount,
  });
}

/** What a Refresh re-synced, as the mismatch route's POST reports it. */
export interface ContactGroupResyncCounts {
  /** Distinct contacts this Refresh asked Xero for (at most the limit per kind). */
  requestedContacts: number;
  /** Contacts Xero returned and whose cache rows were rewritten. */
  resyncedContacts: number;
  /** Contacts Xero no longer has; their stale cache rows were removed. */
  removedContacts: number;
  /**
   * Distinct contacts flagged across both full lists, before the per-kind
   * {@link CONTACT_GROUP_MISMATCH_LIMIT} cap; more than `requestedContacts`
   * means this Refresh left some contacts un-fetched. Counted like
   * `requestedContacts`, so members sharing a contact count once. An older
   * server omits it (blue-green).
   */
  flaggedContacts?: number;
}

/**
 * The line the group and link mismatch panels show after a Refresh. Past the
 * limit it counts out of the true total and names the full refresh that
 * reaches the rest: a genuine mismatch stays flagged in the same order, so
 * another Refresh re-fetches the same first contacts and never gets past the
 * limit. The link route sends no `flaggedContacts`, so its line never
 * carries the hint.
 * `at` is the club-time the re-sync ran, already formatted.
 */
export function describeContactResync(resync: ContactGroupResyncCounts, at: string): string {
  if (resync.requestedContacts === 0) {
    return `Nothing was flagged to re-sync; audit recomputed at ${at}.`;
  }
  const total = Math.max(resync.flaggedContacts ?? 0, resync.requestedContacts);
  const removed =
    resync.removedContacts > 0
      ? ` (${resync.removedContacts} no longer exist in Xero; their stale cache entries were removed)`
      : "";
  const notFetched = total - resync.requestedContacts;
  const rest =
    notFetched > 0
      ? ` The other ${notFetched} were not re-fetched; Refresh Xero Groups on the members list (or Refresh from Xero on Xero member grouping) re-reads every contact's groups.`
      : "";
  return `Re-synced ${resync.resyncedContacts} of ${total} flagged contact${total === 1 ? "" : "s"} from Xero at ${at}${removed}.${rest}`;
}

/** Why an information-only entry is left to a person. */
export const REVIEW_BY_HAND_REASON =
  "Members to review by hand match no grouping rule, so the re-sync never changes them.";

/** What a person does about one information-only entry. */
export function reviewByHandFix(groupNames: readonly string[]): string {
  return `Remove the contact from ${groupNames.join(", ")} in Xero, or add a grouping rule that covers this member.`;
}

/**
 * The Stuck States summary. Information-only entries stay in its count (owner
 * decision, #5234), so it says which entries the re-sync repairs and which
 * need a person.
 */
export function describeContactGroupMismatchStuckState(
  counts: ContactGroupMismatchCounts,
): string {
  const byHand = counts.reviewByHandCount > 0 ? ` ${REVIEW_BY_HAND_REASON}` : "";
  return `Linked members' Xero contact groups disagree with the grouping rules: ${describeContactGroupMismatchCounts(counts)}.${byHand}`;
}

/**
 * The managed groups an information-only entry sits in. An older server sends
 * only `unexpectedManagedGroupIds`, so fall back to unnamed ids (blue-green).
 */
export function unexpectedManagedGroupRefs(entry: {
  unexpectedManagedGroupIds: readonly string[];
  unexpectedManagedGroups?: ReadonlyArray<{ id: string; name: string | null }>;
}): ReadonlyArray<{ id: string; name: string | null }> {
  return (
    entry.unexpectedManagedGroups ??
    entry.unexpectedManagedGroupIds.map((id) => ({ id, name: null }))
  );
}
