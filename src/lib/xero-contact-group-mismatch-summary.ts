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
