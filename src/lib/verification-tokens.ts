import { prisma } from "./prisma";
import { issueActionToken } from "./action-tokens";

/**
 * Generate a cryptographically random 64-character hex token.
 */
export function generateToken(): string {
  return issueActionToken().token;
}

/**
 * Create an email verification token for a member.
 * Deletes any existing tokens for the member first.
 */
export async function createEmailVerificationToken(memberId: string): Promise<string> {
  // Delete existing tokens for this member
  await prisma.emailVerificationToken.deleteMany({ where: { memberId } });

  const { token, tokenHash } = issueActionToken();
  // Email verification: 48h (generous — users may not check email same day)
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours

  await prisma.emailVerificationToken.create({
    data: { memberId, tokenHash, expiresAt },
  });

  return token;
}

/**
 * Create an email change token for a member.
 * Deletes any existing tokens for the member first.
 */
export async function createEmailChangeToken(memberId: string, newEmail: string): Promise<string> {
  // Delete existing tokens for this member
  await prisma.emailChangeToken.deleteMany({ where: { memberId } });

  const { token, tokenHash } = issueActionToken();
  // Email change: 2h (moderate — user initiated, but allow for email delay)
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours

  await prisma.emailChangeToken.create({
    data: { memberId, newEmail, tokenHash, expiresAt },
  });

  return token;
}
