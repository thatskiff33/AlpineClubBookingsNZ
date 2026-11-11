/**
 * Clearing a member's authenticator, emailed codes and passkeys (#4618).
 *
 * The admin route and the operator command both call this. The row lock is
 * the only lock: one member's credentials, not a cohort or a lodge
 * (INV-LOCK-001). No advisory key is minted (INV-LOCK-002, INV-LOCK-003).
 * The same Member row is the one the former-member anonymiser updates.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isKioskSessionMember } from "@/lib/session-idle-expiry";
import { MEMBER_PRIVILEGE_CHECK_SELECT } from "@/lib/access-role-definitions";
import {
  readTwoFactorClearEvidence,
  recordTwoFactorClear,
  type TwoFactorActor,
  type TwoFactorRequestContext,
} from "@/lib/two-factor-audit";

export class FactorResetBlocksEnrolmentError extends Error {
  constructor() {
    super("A reset of this account is newer than the session trying to enrol");
    this.name = "FactorResetBlocksEnrolmentError";
  }
}

type FactorClient = Prisma.TransactionClient;

/** The one `FOR UPDATE` on the member whose factors are being written. */
export async function lockMemberFactorRow(
  tx: FactorClient,
  memberId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "Member" WHERE "id" = ${memberId} FOR UPDATE`;
}

/**
 * Refuse an enrolment whose session was issued before a reset. Locks the
 * member and re-reads. A missing issue time fails closed once a reset exists.
 */
export async function assertEnrolmentNotSuperseded(
  tx: FactorClient,
  memberId: string,
  sessionIssuedAt: Date | null,
): Promise<void> {
  await lockMemberFactorRow(tx, memberId);
  const row = await tx.member.findUnique({
    where: { id: memberId },
    select: { factorsResetAt: true },
  });
  if (!row?.factorsResetAt) return;
  if (
    sessionIssuedAt == null ||
    row.factorsResetAt.getTime() > sessionIssuedAt.getTime()
  ) {
    throw new FactorResetBlocksEnrolmentError();
  }
}

export type ClearMemberSecondFactorsResult =
  | { ok: false; reason: "missing" | "kiosk" }
  | {
      ok: true;
      memberId: string;
      email: string;
      firstName: string;
      factorsResetAt: Date;
    };

/**
 * Clear every factor a lost phone could still use, and end the member's
 * sessions, in one transaction. Email is the caller's job, after commit.
 * An empty factor still stamps the reset and the revocation; the audit row
 * is omitted when there was nothing to clear. A lost claim writes neither.
 */
export async function clearMemberSecondFactors(params: {
  memberId: string;
  actor: Exclude<TwoFactorActor, { kind: "member" }>;
  request?: TwoFactorRequestContext;
}): Promise<ClearMemberSecondFactorsResult> {
  return prisma.$transaction(async (tx) => {
    await lockMemberFactorRow(tx, params.memberId);
    const target = await tx.member.findUnique({
      where: { id: params.memberId },
      select: {
        id: true,
        email: true,
        firstName: true,
        role: true,
        financeAccessLevel: true,
        ...MEMBER_PRIVILEGE_CHECK_SELECT,
      },
    });
    if (!target) return { ok: false as const, reason: "missing" as const };
    if (isKioskSessionMember(target)) {
      return { ok: false as const, reason: "kiosk" as const };
    }

    const before = await readTwoFactorClearEvidence(tx, params.memberId);
    const claimed = await tx.member.updateMany({
      where: { id: params.memberId },
      data: {
        totpSecret: null,
        twoFactorMethod: null,
        twoFactorEnabled: false,
        twoFactorEnrolledAt: null,
        twoFactorFailedAttempts: 0,
        twoFactorLockedUntil: null,
      },
    });
    if (claimed.count !== 1) {
      return { ok: false as const, reason: "missing" as const };
    }

    await tx.twoFactorRecoveryCode.deleteMany({ where: { memberId: params.memberId } });
    await tx.twoFactorEmailCode.deleteMany({ where: { memberId: params.memberId } });
    await tx.twoFactorSessionChallenge.deleteMany({
      where: { memberId: params.memberId },
    });
    await tx.sessionReauthChallenge.deleteMany({
      where: { memberId: params.memberId },
    });
    await tx.webAuthnCredential.deleteMany({ where: { memberId: params.memberId } });
    await tx.webAuthnChallenge.deleteMany({ where: { memberId: params.memberId } });
    await tx.$executeRaw`
      UPDATE "Member"
      SET "factorsResetAt" = NOW(), "sessionsRevokedAt" = NOW()
      WHERE "id" = ${params.memberId}
    `;
    await recordTwoFactorClear(tx, {
      before,
      actor: params.actor,
      subjectMemberId: params.memberId,
      request: params.request,
    });
    const stamped = await tx.member.findUnique({
      where: { id: params.memberId },
      select: { factorsResetAt: true },
    });
    return {
      ok: true as const,
      memberId: target.id,
      email: target.email,
      firstName: target.firstName,
      factorsResetAt: stamped?.factorsResetAt ?? new Date(0),
    };
  });
}
