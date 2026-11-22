import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  INTERNET_BANKING_PAYMENT_SETTINGS_ID,
  buildInternetBankingHoldPolicySummary,
  loadInternetBankingPaymentSettings,
  normalizeInternetBankingPaymentSettings,
} from "@/lib/internet-banking-settings";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const updateSchema = z
  .object({
    holdBedSlots: z.boolean(),
    holdDays: z.number().int().min(1).max(30),
    minimumDaysBeforeCheckIn: z.number().int().min(0).max(365),
  })
  .strict();

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const [settings, modules] = await Promise.all([
    loadInternetBankingPaymentSettings(),
    loadEffectiveModuleFlags(),
  ]);

  return NextResponse.json({
    settings,
    holdPolicySummary: buildInternetBankingHoldPolicySummary(settings),
    moduleState: {
      xeroIntegrationEnabled: modules.xeroIntegration,
      internetBankingPaymentsEnabled: modules.internetBankingPayments,
      ready: modules.xeroIntegration && modules.internetBankingPayments,
    },
    xeroBehaviour:
      "Internet Banking bookings automatically queue a Xero invoice and email it through Xero. Xero operation failures remain visible in the existing Xero operation monitoring.",
  });
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.internetBankingPaymentSettings.findUnique({
    where: { id: INTERNET_BANKING_PAYMENT_SETTINGS_ID },
  });
  const before = normalizeInternetBankingPaymentSettings(existing);
  const after = parsed.data;
  const changes = Object.entries(after)
    .filter(([key, value]) => before[key as keyof typeof before] !== value)
    .map(([key, value]) => ({
      key,
      previous: before[key as keyof typeof before],
      next: value,
    }));

  const write = prisma.internetBankingPaymentSettings.upsert({
    where: { id: INTERNET_BANKING_PAYMENT_SETTINGS_ID },
    create: {
      id: INTERNET_BANKING_PAYMENT_SETTINGS_ID,
      ...after,
      updatedByMemberId: session.user.id,
    },
    update: {
      ...after,
      updatedByMemberId: session.user.id,
    },
  });

  const record =
    changes.length > 0
      ? (
          await prisma.$transaction([
            write,
            prisma.auditLog.create(
              buildStructuredAuditLogCreateArgs({
                action: "INTERNET_BANKING_PAYMENT_SETTINGS_UPDATED",
                actor: { memberId: session.user.id },
                entity: {
                  type: "InternetBankingPaymentSettings",
                  id: INTERNET_BANKING_PAYMENT_SETTINGS_ID,
                },
                category: "admin",
                severity: "important",
                outcome: "success",
                summary: "Internet Banking payment settings updated",
                metadata: {
                  changes,
                  previousSettings: before,
                  newSettings: after,
                },
                request: getAuditRequestContext(request),
              }),
            ),
          ])
        )[0]
      : await write;

  const settings = normalizeInternetBankingPaymentSettings(record);
  return NextResponse.json({
    settings,
    holdPolicySummary: buildInternetBankingHoldPolicySummary(settings),
  });
}
