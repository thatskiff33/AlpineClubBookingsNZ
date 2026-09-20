import type { Prisma } from "@prisma/client";

/**
 * What the label needs to know about the club: the built-in NON_MEMBER
 * membership type's id, or null when it cannot be resolved. `HutFeeItemCodeResolver`
 * satisfies it; a reader that has no item codes to resolve loads the smaller
 * shape with `loadRateMembershipLabelResolver`.
 */
export type RateMembershipLabelResolver = { nonMemberTypeId: string | null };

/**
 * The member / non-member words on a guest's hut-fee invoice line (#2543), and
 * since #3530 on the lines of a booking edit wherever they are read - Xero,
 * the booking's history, its audit row - so every surface says the same thing.
 *
 * DRIVEN OFF THE RATE SNAPSHOT, not off `BookingGuest.isMember`, so the line's
 * NARRATION agrees with the item code the line is coded to — `resolveHutFeeItemCode`
 * in `xero-mappings.ts` keys on exactly the same field, which is why the two live side by side.
 *
 * The case that forced this: under `NON_MEMBER_PRICING` a member with an unpaid
 * season subscription is priced at the built-in NON_MEMBER rate and coded to the
 * NON_MEMBER hut-fee item, while `isMember` stays true (it is load-bearing
 * elsewhere, so #2543 deliberately does not move it). The line therefore read
 * "(ADULT, Member)" at the non-member amount inside the non-member item — a
 * treasurer reconciling member against non-member hut-fee income sees a Member
 * line sitting in the non-member account, and the member receiving the invoice
 * sees the same contradiction. Owner decision, 2 Aug 2026: Xero narrates "a normal
 * non-member line (honest)".
 *
 * KNOWN AND ACCEPTED CONSEQUENCE, stated rather than discovered later: this also
 * flips the pre-existing `TYPE_POLICY_FORCED` class — a member whose membership
 * TYPE forces the non-member rate — from ", Member" to ", Non-member". There is no
 * persisted marker distinguishing the two reasons for pricing on NON_MEMBER rows,
 * so per-class narration is not implementable from a stored row; and the new
 * wording is the honest one for that class too, since its line has always been
 * coded to the non-member item at the non-member amount. It is narration only: no
 * amount, item code, account code or idempotency key changes.
 *
 * FALLS BACK TO `isMember` when the guest has no snapshot (a pre-#1930 booking) or
 * the club has no built-in NON_MEMBER type resolved, which keeps every legacy line
 * byte-identical.
 */
export function describeGuestRateMembershipLabel(
  resolver: RateMembershipLabelResolver | null | undefined,
  guest: { isMember: boolean; rateMembershipTypeId?: string | null },
): "Member" | "Non-member" {
  if (guest.rateMembershipTypeId && resolver?.nonMemberTypeId) {
    return guest.rateMembershipTypeId === resolver.nonMemberTypeId
      ? "Non-member"
      : "Member";
  }
  return guest.isMember ? "Member" : "Non-member";
}

/**
 * The resolver for a reader that only narrates - no item codes. One indexed
 * read; a club without the built-in type resolves to null and the label falls
 * back to `isMember`, exactly as the Xero builders' resolver would.
 */
export async function loadRateMembershipLabelResolver(
  db: Pick<Prisma.TransactionClient, "membershipType">,
): Promise<RateMembershipLabelResolver> {
  const nonMember = await db.membershipType.findFirst({
    where: { key: "NON_MEMBER" },
    select: { id: true },
  });
  return { nonMemberTypeId: nonMember?.id ?? null };
}
