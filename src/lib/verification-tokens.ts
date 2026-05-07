import { prisma } from "./prisma";
import { issueActionToken } from "./action-tokens";

export const EMAIL_VERIFICATION_TTL_MS = 48 * 60 * 60 * 1000;
export const EMAIL_CHANGE_TTL_MS = 2 * 60 * 60 * 1000;

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
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

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
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_MS);

  await prisma.emailChangeToken.create({
    data: { memberId, newEmail, tokenHash, expiresAt },
  });

  return token;
}
