/**
 * The data-key re-encrypt's two writers of a member's second factor (#4456):
 * moving a stored authenticator secret to the current ring key, and retiring
 * the unused recovery codes hashed under the auth secret. Only
 * `data-encryption-reencrypt.ts` calls them, one member per short transaction.
 *
 * BOTH ARE CLAIMS, NOT OVERWRITES. Each update is guarded on the exact stored
 * value the caller read (and, for a code, on its still being unused), so a
 * member who enrols again, regenerates their codes, uses a code or is cleared
 * meanwhile wins: the guard matches nothing, nothing is written, nothing is
 * audited, and the next pass re-reads.
 *
 * BOTH ARE AUDITED like every other second-factor write (INV-PRIV-020): the row
 * is written on the same transaction, names the `data-key-reencrypt` job, and
 * carries booleans and counts, never a secret or a code.
 *
 * Neither ever writes under the auth secret: each refuses unless a ring key is
 * the current key, so a re-encrypt can only move data AWAY from it.
 */

import { DataKeyRingError, DATA_KEY_REENCRYPT_JOB_NAME } from "@/lib/data-encryption-key-material";
import { currentDataKey } from "@/lib/data-encryption-keys";
import { prisma } from "@/lib/prisma";
import { exactContains } from "@/lib/prisma-exact-prefix";
import { decryptTwoFactorSecret, encryptTwoFactorSecret } from "@/lib/two-factor";
import {
  recordTwoFactorMutation,
  TWO_FACTOR_AUDIT_ACTIONS,
  type TwoFactorReencryptActor,
} from "@/lib/two-factor-audit";
import { retiredRecoveryCodeHash } from "@/lib/two-factor-key-format";

const REENCRYPT_JOB: TwoFactorReencryptActor = { kind: "system", actor: DATA_KEY_REENCRYPT_JOB_NAME };

/**
 * A legacy code hash is bare hex; every other stored form has a `:` (a ring
 * key's id, or the retired marker). Matched literally (`INV-SSOT-006`).
 */
export const LEGACY_RECOVERY_CODE_WHERE = { NOT: { codeHash: exactContains(":") } } as const;

/** What happened to one row. Never carries a value. */
export type RekeyOutcome = "moved" | "lost-claim" | "unreadable";

/** Refuse unless the key a write would use is a ring key. */
function assertRingIsCurrent(): void {
  const key = currentDataKey();
  if (!key || key.legacy) {
    throw new DataKeyRingError(
      "The re-encrypt needs DATA_ENCRYPTION_KEYS: without a ring, the current key is AUTH_SECRET itself.",
    );
  }
}

/**
 * Re-encrypt one member's authenticator secret under the current ring key,
 * claimed on `stored`, the value the caller read. "unreadable" when that value
 * cannot be decrypted here (its key is gone or retired, or it is malformed):
 * nothing is written, and only re-enrolment fixes it.
 */
export async function rewrapTwoFactorSecret(memberId: string, stored: string): Promise<RekeyOutcome> {
  assertRingIsCurrent();
  let plaintext: string;
  try {
    plaintext = decryptTwoFactorSecret(stored);
  } catch (error) {
    if (error instanceof DataKeyRingError) throw error;
    return "unreadable";
  }
  const rewrapped = encryptTwoFactorSecret(plaintext);
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.member.updateMany({
      where: { id: memberId, totpSecret: stored },
      data: { totpSecret: rewrapped },
    });
    if (claimed.count !== 1) return "lost-claim";
    await recordTwoFactorMutation(tx, {
      action: TWO_FACTOR_AUDIT_ACTIONS.secretRewrapped,
      actor: REENCRYPT_JOB,
      subjectMemberId: memberId,
      method: null,
      authenticatorApp: true,
    });
    return "moved";
  });
}

/**
 * Retire one member's unused recovery codes hashed under the auth secret
 * (owner decision on #4456, 1 Nov 2026): each is rewritten to its retired form,
 * which no lookup on any release computes, so it never signs anyone in again,
 * and stays unused, which keeps telling the member to generate a new set.
 * Resolves the number retired; zero records nothing.
 */
export async function retireLegacyRecoveryCodes(memberId: string): Promise<number> {
  assertRingIsCurrent();
  return prisma.$transaction(async (tx) => {
    const codes = await tx.twoFactorRecoveryCode.findMany({
      where: { memberId, usedAt: null, ...LEGACY_RECOVERY_CODE_WHERE },
      select: { id: true, codeHash: true },
    });
    let retired = 0;
    for (const code of codes) {
      const claimed = await tx.twoFactorRecoveryCode.updateMany({
        where: { id: code.id, codeHash: code.codeHash, usedAt: null },
        data: { codeHash: retiredRecoveryCodeHash(code.codeHash) },
      });
      retired += claimed.count;
    }
    if (retired > 0) {
      await recordTwoFactorMutation(tx, {
        action: TWO_FACTOR_AUDIT_ACTIONS.recoveryCodesRetired,
        actor: REENCRYPT_JOB,
        subjectMemberId: memberId,
        method: null,
        authenticatorApp: false,
        recoveryCodesRetired: retired,
      });
    }
    return retired;
  });
}
