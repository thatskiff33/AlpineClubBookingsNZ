/**
 * Minimum member data needed to resolve the effective email address.
 * Include `inheritEmailFrom` in your Prisma select to avoid an extra DB lookup.
 */
export type EmailResolvableMember = {
  email: string;
  inheritEmailFromId?: string | null;
  inheritEmailFrom?: { email: string } | null;
};

export function resolveEffectiveEmail(member: EmailResolvableMember): string {
  if (member.inheritEmailFromId && member.inheritEmailFrom) {
    return member.inheritEmailFrom.email;
  }

  return member.email;
}
