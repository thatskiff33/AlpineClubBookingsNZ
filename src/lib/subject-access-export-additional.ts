import "server-only";

import { prisma } from "@/lib/prisma";
import type { AdditionalRecordModel } from "@/lib/subject-access-export-coverage";

/**
 * The personal models with no section of their own (#4915): each one's rows
 * for this member, under the model's name. Projections are explicit and leave
 * out officer notes, idempotency keys, provider identifiers and the ids of
 * records that belong to someone else (another member's induction, the booking
 * that triggered a hosting re-check, the member a request was about). The
 * `satisfies` ties the keys to the coverage map, so a model placed under
 * `additionalRecords` there and not read here does not compile.
 */
export async function readAdditionalSubjectRecords(memberId: string) {
  const own = { memberId };
  const [
    MembershipSubscriptionChargeCoverage, MembershipBillingException, SeasonalMembershipAssignment,
    MemberLifecycleActionRequest, PromoRedemption, PromoRedemptionAllocation, PromoCodeAssignment,
    HostingCoverageReevaluation, FinanceSyncRun, AiAssistantUsageEvent, NoticeAudience, NoticeReadReceipt,
    BookingModification, NewBookingPolicyExceptionRequest, MemberLodgeAccess, FamilyGroupJoinRequest,
    DeletionRequest, AdminCreditAdjustmentRequest, CommitteeAssignment, OrganisationContact,
    SchoolMemberClassification, MemberMoneyObligation, MemberInductionAssignedSigner, MemberInductionSignOff,
  ] = await Promise.all([
    prisma.membershipSubscriptionChargeCoverage.findMany({ where: own, select: { chargeId: true, releasedAt: true, createdAt: true } }),
    prisma.membershipBillingException.findMany({ where: own, select: { seasonYear: true, code: true, firstSeenAt: true, resolvedAt: true } }),
    prisma.seasonalMembershipAssignment.findMany({ where: own, select: { seasonYear: true, applyFrom: true, createdAt: true } }),
    prisma.memberLifecycleActionRequest.findMany({
      where: { OR: [own, { requestedByMemberId: memberId }] },
      select: { memberId: true, action: true, status: true, requestedAt: true, reviewedAt: true, processedAt: true },
    }).then((rows) => rows.map(({ memberId: about, ...row }) => ({ ...row, aboutYou: about === memberId }))),
    prisma.promoRedemption.findMany({
      where: own,
      select: { bookingId: true, discountCents: true, priceAdjustmentCents: true, freeNightsUsed: true, createdAt: true, promoCode: { select: { code: true } } },
    }),
    prisma.promoRedemptionAllocation.findMany({ where: own, select: { bookingId: true, discountCents: true, priceAdjustmentCents: true, freeNightsUsed: true, createdAt: true } }),
    prisma.promoCodeAssignment.findMany({ where: own, select: { createdAt: true, promoCode: { select: { code: true } } } }),
    prisma.hostingCoverageReevaluation.findMany({ where: own, select: { enqueuedAt: true, processedAt: true } }),
    prisma.financeSyncRun.findMany({ where: { requestedByMemberId: memberId }, select: { workflow: true, startedAt: true, completedAt: true } }),
    prisma.aiAssistantUsageEvent.findMany({ where: own, select: { surface: true, success: true, questionChars: true, createdAt: true } }),
    prisma.noticeAudience.findMany({ where: own, select: { createdAt: true, notice: { select: { title: true } } } }),
    prisma.noticeReadReceipt.findMany({ where: own, select: { readAt: true, acknowledgedAt: true, notice: { select: { title: true } } } }),
    prisma.bookingModification.findMany({ where: own, select: { bookingId: true, modificationType: true, priceDiffCents: true, changeFeeCents: true, createdAt: true } }),
    prisma.newBookingPolicyExceptionRequest.findMany({
      where: { requestedByMemberId: memberId },
      select: { reviewedAt: true, cancelledAt: true, createdBookingId: true, createdAt: true },
    }),
    prisma.memberLodgeAccess.findMany({ where: own, select: { createdAt: true, lodge: { select: { name: true } } } }),
    prisma.familyGroupJoinRequest.findMany({
      where: { OR: [{ subjectMemberId: memberId }, { requesterId: memberId }] },
      select: { type: true, status: true, createdAt: true, reviewedAt: true },
    }),
    prisma.deletionRequest.findMany({ where: own, select: { reviewedAt: true, createdAt: true } }),
    prisma.adminCreditAdjustmentRequest.findMany({ where: own, select: { amountCents: true, reviewedAt: true, createdAt: true } }),
    prisma.committeeAssignment.findMany({
      where: own,
      select: { blurb: true, published: true, showPhone: true, isActive: true, createdAt: true, committeeRole: { select: { name: true } } },
    }),
    prisma.organisationContact.findMany({ where: own, select: { createdAt: true, organisation: { select: { name: true } } } }),
    prisma.schoolMemberClassification.findMany({ where: own, select: { decidedAt: true } }),
    prisma.memberMoneyObligation.findMany({ where: own, select: { faceCents: true } }),
    prisma.memberInductionAssignedSigner.findMany({
      where: own, select: { emailSentAt: true, createdAt: true },
    }),
    prisma.memberInductionSignOff.findMany({
      where: { signerMemberId: memberId },
      select: { signerName: true, signerRole: true, signedAt: true, declarationAccepted: true },
    }),
  ]);
  return {
    MembershipSubscriptionChargeCoverage, MembershipBillingException, SeasonalMembershipAssignment,
    MemberLifecycleActionRequest, PromoRedemption, PromoRedemptionAllocation, PromoCodeAssignment,
    HostingCoverageReevaluation, FinanceSyncRun, AiAssistantUsageEvent, NoticeAudience, NoticeReadReceipt,
    BookingModification, NewBookingPolicyExceptionRequest, MemberLodgeAccess, FamilyGroupJoinRequest,
    DeletionRequest, AdminCreditAdjustmentRequest, CommitteeAssignment, OrganisationContact,
    SchoolMemberClassification, MemberMoneyObligation, MemberInductionAssignedSigner, MemberInductionSignOff,
  } satisfies Record<AdditionalRecordModel, unknown>;
}
