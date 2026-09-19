// Pure helpers for the Partner/Husband/Wife relationship (#1742), kept in a
// leaf module with no side-effecting imports ("server-only", prisma, email,
// audit) so predicates like double-bed-sharing.ts — and any test suite whose
// module graph reaches them — can use the canonical pair ordering and status
// vocabulary without pulling in the full service graph (#1744).

import { compareOrdinal } from "@/lib/ordinal-order";

export const PARTNER_LINK_PENDING = "PENDING";
export const PARTNER_LINK_CONFIRMED = "CONFIRMED";

/**
 * The one ordering used for member ids in canonical pairs and sorted lock
 * acquisition. PostgreSQL's default C collation compares text bytewise; JS's
 * relational string comparison has the same ordering for the ASCII member ids
 * this application generates. Child B pins the SQL side to this contract.
 * The comparison itself is the one `compareOrdinal` (INV-EXCEPT-036): this
 * order is an IDENTITY — it decides which member is `memberAId` in a stored
 * pair and the order two row locks are taken in — so it must never follow the
 * runtime's locale.
 */
export function compareMemberIds(memberOneId: string, memberTwoId: string) {
  return compareOrdinal(memberOneId, memberTwoId);
}

/** Canonical pair ordering: the lower member id is always memberAId. */
export function canonicalPartnerPair(memberOneId: string, memberTwoId: string) {
  return compareMemberIds(memberOneId, memberTwoId) < 0
    ? { memberAId: memberOneId, memberBId: memberTwoId }
    : { memberAId: memberTwoId, memberBId: memberOneId };
}
