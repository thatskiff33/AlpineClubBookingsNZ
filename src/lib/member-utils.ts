import { prisma } from "./prisma";

/**
 * Minimum member data needed to resolve the effective email address.
 * Include `inheritEmailFrom` in your Prisma select to avoid an extra DB lookup.
 */
export type EmailResolvableMember = {
  email: string;
  inheritEmailFromId?: string | null;
  inheritEmailFrom?: { email: string } | null;
};

/**
 * Returns the effective email address for a member.
 *
 * Resolution order:
 * 1. If `inheritEmailFromId` is set, use that adult member's email.
 *    Uses pre-loaded `inheritEmailFrom` if available, otherwise does a DB lookup.
 * 2. Otherwise return `member.email` directly — which may be the family lead's
 *    email for non-login members with inherited emails.
 *
 * Booking emails (confirmed, pending, cancelled, etc.) go to the booking
 * creator who is always a primary (non-dependent) member, so those code paths
 * do not need to call this helper.  This helper is mainly relevant for:
 *  - Chore roster emails sent to individual guests (who may be dependents)
 *  - Any future per-dependent notifications
 */
export async function getEffectiveEmail(
  member: EmailResolvableMember
): Promise<string> {
  if (!member.inheritEmailFromId) {
    return member.email;
  }

  // Use pre-loaded relation data when available (no extra round-trip)
  if (member.inheritEmailFrom) {
    return member.inheritEmailFrom.email;
  }

  // Fallback: DB lookup
  const source = await prisma.member.findUnique({
    where: { id: member.inheritEmailFromId },
    select: { email: true },
  });

  return source?.email ?? member.email;
}
