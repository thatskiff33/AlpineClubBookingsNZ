import "server-only";
import { MEMBER_CONTACT_ERASURE_PATCH } from "@/lib/member-contact-erasure";
import type { Prisma } from "@prisma/client";
import { acquireMemberLifecycleLocks } from "@/lib/member-lifecycle-lock";
import { lockMemberCreditLedger } from "@/lib/member-credit";
import { lockMemberForAccountDeletionXeroFence, DELETED_ACCOUNT_PASSWORD_HASH } from "@/lib/xero-contact-create-recovery";
import { DELETED_CONTACT_EMAIL_DOMAIN } from "@/lib/deleted-account-email";
import { DIETARY_ERASURE_PATCH } from "@/lib/member-dietary";
import { deleteOwnedMemberPhotoBlobs } from "@/lib/member-photo";
import { reconcileEmailInheritanceForMemberChange, retireInheritedEmailCopies } from "@/lib/member-email-inheritance";
import { formerMemberRetentionBlockers } from "@/lib/privacy-retention-selection";
import { createAuditLog } from "@/lib/audit";
import { readTwoFactorClearEvidence, recordTwoFactorClear } from "@/lib/two-factor-audit";
import { FORMER_MEMBER_ANONYMISATION_JOB_NAME } from "@/lib/privacy-retention-shared";

/** Local-only erasure; never deletes the identity or financial references. */
export async function anonymiseFormerMember(
  tx: Prisma.TransactionClient, id: string, where: Prisma.MemberWhereInput, now: Date,
): Promise<boolean> {
  // INV-LOCK-001/002/003: exclude capture/cancel/refund while testing open money;
  // compose global -> lifecycle -> credit -> Member row -> owned photo rows.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
  await acquireMemberLifecycleLocks(tx, [id]);
  await lockMemberCreditLedger(id, tx);
  await lockMemberForAccountDeletionXeroFence(tx, id);
  const member = await tx.member.findFirst({
    where: { AND: [where, { id }] }, select: { id: true, email: true, photoImageId: true, xeroContactId: true },
  });
  if (!member || (await formerMemberRetentionBlockers(tx, id)).length) return false;
  // INV-PRIV-020: read after the row lock, recorded only once the claim cleared it.
  const twoFactorBefore = await readTwoFactorClearEvidence(tx, id);
  const claim = await tx.member.updateMany({
    where: { AND: [where, { id }] },
    data: {
      ...MEMBER_CONTACT_ERASURE_PATCH, email: `${id}@${DELETED_CONTACT_EMAIL_DOMAIN}`,
      deletedAt: now, canLogin: false, passwordHash: DELETED_ACCOUNT_PASSWORD_HASH,
      googleSub: null, emailVerified: false, totpSecret: null, twoFactorEnabled: false,
      twoFactorMethod: null, twoFactorEnrolledAt: null, twoFactorLockedUntil: null, twoFactorFailedAttempts: 0,
      title: null, gender: null, occupation: null,
      comments: null, cancelledReason: null, archivedReason: null,
      photoImageId: null, photoUpdatedAt: null, photoUpdatedByMemberId: null,
      lodgeScreenPhoneOptIn: false, inheritEmailFromId: null, inheritEmailChoiceId: null,
      inheritParentEmail: false, ...DIETARY_ERASURE_PATCH,
    },
  });
  if (claim.count !== 1) return false;
  await recordTwoFactorClear(tx, {
    before: twoFactorBefore,
    actor: { kind: "system", actor: FORMER_MEMBER_ANONYMISATION_JOB_NAME },
    subjectMemberId: id,
  });
  await retireInheritedEmailCopies(tx, { id, email: member.email });
  await tx.member.updateMany({
    where: { OR: [{ inheritEmailFromId: id }, { inheritEmailChoiceId: id }] },
    data: { inheritEmailFromId: null, inheritEmailChoiceId: null, inheritParentEmail: false },
  });
  await reconcileEmailInheritanceForMemberChange(tx, [id], {
    trigger: "lifecycle-eligibility-change",
  });
  await tx.xeroObjectLink.updateMany({
    where: { localModel: "Member", localId: id, xeroObjectType: "CONTACT", active: true },
    data: { active: false },
  });
  await deleteOwnedMemberPhotoBlobs(tx, { memberId: id, photoImageId: member.photoImageId });
  await Promise.all([
    tx.magicLinkToken.deleteMany({ where: { memberId: id } }),
    tx.passwordResetToken.deleteMany({ where: { memberId: id } }),
    tx.emailVerificationToken.deleteMany({ where: { memberId: id } }),
    tx.emailChangeToken.deleteMany({ where: { memberId: id } }),
    tx.twoFactorEmailCode.deleteMany({ where: { memberId: id } }),
    tx.twoFactorRecoveryCode.deleteMany({ where: { memberId: id } }),
    tx.twoFactorSessionChallenge.deleteMany({ where: { memberId: id } }),
    tx.bookingGuest.updateMany({ where: { memberId: id }, data: { firstName: "Deleted", lastName: "Member", ...DIETARY_ERASURE_PATCH } }),
    ...(member.xeroContactId ? [tx.xeroContactCache.deleteMany({ where: { contactId: member.xeroContactId } })] : []),
  ]);
  await createAuditLog({
    action: "privacy.retention.member_anonymised", category: "privacy", severity: "critical",
    entityType: "Member", entityId: id, subjectMemberId: id,
    summary: "Former member anonymised after retention period",
    metadata: { financialReferencesRetained: true },
  }, tx);
  return true;
}
