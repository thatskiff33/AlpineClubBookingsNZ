import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  buildSetupReadiness,
  normalizeSetupProgress,
  type SetupDatabaseSnapshot,
} from "@/lib/setup-readiness";

async function getSetupDatabaseSnapshot(): Promise<SetupDatabaseSnapshot> {
  const now = new Date();
  const [
    adminCount,
    adminModuleSettings,
    ageTierSettingCount,
    seasonCount,
    cancellationPolicyCount,
    bookingDefaults,
    groupDiscount,
    membershipCancellationSettings,
    operationalXeroToken,
    financeXeroToken,
    xeroAccountMappingCount,
    xeroHutFeeItemMappingCount,
    xeroEntranceFeeMappingCount,
  ] = await Promise.all([
    prisma.member.count({ where: { role: "ADMIN", active: true } }),
    prisma.clubModuleSettings.findUnique({
      where: { id: "default" },
      select: {
        kiosk: true,
        chores: true,
        financeDashboard: true,
        waitlist: true,
        xeroIntegration: true,
        bedAllocation: true,
        internetBankingPayments: true,
      },
    }),
    prisma.ageTierSetting.count(),
    prisma.season.count({ where: { active: true } }),
    prisma.cancellationPolicy.count(),
    prisma.bookingDefaults.findUnique({ where: { id: "default" } }),
    prisma.groupDiscountSetting.findUnique({ where: { id: "default" } }),
    prisma.membershipCancellationSetting.findUnique({
      where: { id: "default" },
      select: {
        xeroArchiveContactsOnCancellation: true,
        _count: {
          select: { xeroContactGroups: true },
        },
      },
    }),
    prisma.xeroToken.findFirst({
      orderBy: { updatedAt: "desc" },
      select: { expiresAt: true },
    }),
    prisma.financeXeroToken.findFirst({
      orderBy: { updatedAt: "desc" },
      select: { expiresAt: true },
    }),
    prisma.xeroAccountMapping.count({
      where: {
        OR: [{ code: { not: null } }, { itemCode: { not: null } }],
      },
    }),
    prisma.xeroItemCodeMapping.count({
      where: {
        category: "HUT_FEE",
        itemCode: { not: null },
      },
    }),
    prisma.xeroItemCodeMapping.count({
      where: {
        category: "ENTRANCE_FEE",
        OR: [{ itemCode: { not: null } }, { amountCents: { not: null } }],
      },
    }),
  ]);

  return {
    adminCount,
    adminModuleSettings,
    ageTierSettingCount,
    seasonCount,
    cancellationPolicyCount,
    bookingDefaultsConfigured: Boolean(bookingDefaults),
    groupDiscountConfigured: Boolean(groupDiscount),
    membershipCancellationSettingsConfigured: Boolean(membershipCancellationSettings),
    membershipCancellationXeroGroupCount:
      membershipCancellationSettings?._count.xeroContactGroups ?? 0,
    membershipCancellationArchiveContacts: Boolean(
      membershipCancellationSettings?.xeroArchiveContactsOnCancellation,
    ),
    operationalXeroConnected: Boolean(
      operationalXeroToken && operationalXeroToken.expiresAt > now,
    ),
    operationalXeroTokenExpiresAt:
      operationalXeroToken?.expiresAt.toISOString() ?? null,
    financeXeroConnected: Boolean(
      financeXeroToken && financeXeroToken.expiresAt > now,
    ),
    financeXeroTokenExpiresAt: financeXeroToken?.expiresAt.toISOString() ?? null,
    xeroAccountMappingCount,
    xeroHutFeeItemMappingCount,
    xeroEntranceFeeMappingCount,
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const [database, progressRecord] = await Promise.all([
    getSetupDatabaseSnapshot(),
    prisma.setupProgress.findUnique({ where: { id: "default" } }),
  ]);
  const progress = normalizeSetupProgress(
    progressRecord
      ? {
          completedStepIds: progressRecord.completedStepIds,
          skippedStepIds: progressRecord.skippedStepIds,
          completedAt: progressRecord.completedAt?.toISOString() ?? null,
          completedByMemberId: progressRecord.completedByMemberId,
        }
      : null,
  );

  return NextResponse.json({
    readiness: buildSetupReadiness({
      database,
      progress,
    }),
    progress,
  });
}
