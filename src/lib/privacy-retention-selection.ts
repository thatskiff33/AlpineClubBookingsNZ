import "server-only";
import type { Prisma } from "@prisma/client";
import { clubTime } from "@/lib/club-time/server";
import { dateOnlyInstantOf } from "@/lib/club-time";
import { addUtcYears } from "@/lib/retention-calendar";
import { getMemberCreditBalance } from "@/lib/member-credit";
import { hasMemberContactChangeMergeBlocker } from "@/lib/xero-contact-create-recovery";
import { buildAdditionalOwedWhere } from "@/lib/unpaid-finished-stays";
import { ADDITIONAL_ASK_RETIRED_BOOKING_STATUSES } from "@/lib/additional-payment-chase";
import type { PrivacyRetentionSettingsValues } from "@/lib/privacy-retention-shared";

export type RetentionDb = Prisma.TransactionClient;
export const RETENTION_BATCH_SIZE = 100;

/** The same exclusive cutoffs feed both preview and mutation predicates. */
export async function privacyRetentionSelection(settings: PrivacyRetentionSettingsValues, now: Date) {
  const day = dateOnlyInstantOf((await clubTime()).calendarDateOf(now));
  return {
    emailLogs: { createdAt: { lt: addUtcYears(now, -settings.emailLogRetentionYears) } } satisfies Prisma.EmailLogWhereInput,
    rejectedApplications: {
      status: "REJECTED", reviewedAt: { lt: addUtcYears(now, -settings.rejectedApplicationRetentionYears) },
    } satisfies Prisma.MemberApplicationWhereInput,
    formerMembers: {
      active: false, deletedAt: null,
      leavingDate: { not: null, lt: addUtcYears(day, -settings.formerMemberRetentionYears) },
    } satisfies Prisma.MemberWhereInput,
    undatedMembers: { active: false, deletedAt: null, leavingDate: null } satisfies Prisma.MemberWhereInput,
  };
}

/** Block on present obligations, never on settled financial history. */
export async function formerMemberRetentionBlockers(db: RetentionDb, memberId: string): Promise<string[]> {
  const [family, legacyFamily, bookings, subscriptions, charges, credit, refunds, contact] = await Promise.all([
    db.familyGroupMember.count({ where: { memberId } }),
    db.member.count({ where: { id: memberId, OR: [{ familyGroupId: { not: null } }, { billingFamilyGroupId: { not: null } }] } }),
    db.booking.count({ where: {
      OR: [{ memberId }, { guests: { some: { memberId } } }],
      AND: [{ OR: [
        { status: { notIn: [...ADDITIONAL_ASK_RETIRED_BOOKING_STATUSES, "COMPLETED"] } },
        buildAdditionalOwedWhere(),
        { payment: { is: { OR: [
          { status: { in: ["PENDING", "PROCESSING"] } },
          { additionalPaymentStatus: "PENDING" },
          { recoveryOperations: { some: { status: { in: ["PENDING", "PROCESSING"] } } } },
          { manualRefundTasks: { some: { status: "OPEN" } } },
        ] } } },
      ] }],
    } }),
    db.memberSubscription.count({ where: { memberId, status: { in: ["UNPAID", "OVERDUE"] } } }),
    db.membershipSubscriptionCharge.count({ where: { recipientMemberId: memberId, status: { in: ["QUEUED", "PROCESSING", "CONFLICT", "EMAIL_FAILED"] } } }),
    getMemberCreditBalance(memberId, db),
    db.refundRequest.count({ where: { memberId, status: "PENDING" } }),
    hasMemberContactChangeMergeBlocker(memberId, db),
  ]);
  return [
    ...(family || legacyFamily ? ["active family group"] : []),
    ...(bookings ? ["open booking or booking money"] : []),
    ...(subscriptions || charges || credit !== 0 || refunds ? ["open money"] : []),
    ...(contact ? ["unresolved Xero contact operation"] : []),
  ];
}

export async function selectFormerMemberBatch(
  db: RetentionDb, where: Prisma.MemberWhereInput, afterId?: string, take = RETENTION_BATCH_SIZE,
) {
  const rows = await db.member.findMany({
    where: { AND: [where, ...(afterId ? [{ id: { gt: afterId } }] : [])] },
    select: { id: true, leavingDate: true }, orderBy: { id: "asc" }, take,
  });
  return Promise.all(rows.map(async (row) => ({
    id: row.id, date: row.leavingDate,
    reasons: await formerMemberRetentionBlockers(db, row.id),
  })));
}
