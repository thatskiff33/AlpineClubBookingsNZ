import "server-only";

import logger from "@/lib/logger";
import { hashPassword, passwordHashCost, passwordHashNeedsUpgrade } from "@/lib/password-hashing";
import { prisma } from "@/lib/prisma";

/**
 * Re-hash a member's password at the current bcrypt cost once they have just
 * proved it (#5261, INV-AUTH-013). Call only after `verifyPassword` accepted
 * `plain` against `storedHash`.
 *
 * The write is a compare-and-swap on the hash that was proved: a password the
 * member changed or reset in the meantime is never overwritten. Only
 * `passwordHash` changes — not `passwordChangedAt`, which would end the
 * member's sessions — so the member notices nothing. Standard bcrypt, so a
 * release running beside this one reads the new hash. Never throws: a failed
 * upgrade leaves the old hash in place and is retried at the next sign-in.
 *
 * Returns true only when this call replaced the hash.
 */
export async function upgradePasswordHashAfterProof(input: {
  memberId: string;
  plain: string;
  storedHash: string;
}): Promise<boolean> {
  const { memberId, plain, storedHash } = input;
  if (!passwordHashNeedsUpgrade(storedHash)) return false;
  try {
    const passwordHash = await hashPassword(plain);
    const { count } = await prisma.member.updateMany({
      where: { id: memberId, passwordHash: storedHash },
      data: { passwordHash },
    });
    if (count !== 1) return false;
    logger.info(
      { memberId, fromCost: passwordHashCost(storedHash), toCost: passwordHashCost(passwordHash) },
      "Upgraded stored password hash cost after sign-in",
    );
    return true;
  } catch (error) {
    logger.warn({ err: error, memberId }, "Failed to upgrade stored password hash cost");
    return false;
  }
}
