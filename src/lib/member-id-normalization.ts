/**
 * ONE spelling of "the member ids a party names" (`INV-SSOT-001`, #3770).
 *
 * Trim, drop the empty, de-duplicate. The member lookup
 * (`resolveLinkedBookingMembersWithBoundary`) resolves exactly this set and
 * refuses every id in it that does not resolve, and the own-dependant guard's
 * `claimedMemberPathIds` treats exactly this set as member-linked when it runs
 * before that lookup. The guard is sound only while the two sets are the same
 * set, so they are built here, once. An import-free leaf, because the guard's
 * module is imported by client components.
 */
export function normalizeMemberIds(
  memberIds: ReadonlyArray<string | null | undefined>,
): string[] {
  return [
    ...new Set(
      memberIds
        .map((memberId) => memberId?.trim())
        .filter((memberId): memberId is string => Boolean(memberId)),
    ),
  ];
}
