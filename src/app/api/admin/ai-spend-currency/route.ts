import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { APP_CURRENCY } from "@/config/operational";
import {
  describeRateInputRule,
  formatClubUnitsPerNzd,
  parseClubUnitsPerNzdToMicros,
  type AiSpendCurrency,
} from "@/lib/ai-spend-currency";
import {
  AI_SPEND_CURRENCY_SETTINGS_ID,
  loadAiSpendCurrency,
} from "@/lib/ai-spend-currency-settings";
import { prisma } from "@/lib/prisma";

// GET/PUT /api/admin/ai-spend-currency — the administrator-set NZD -> club-
// currency conversion rate for AI spend (#3354, INV-CONFIG-001). ONE setting
// shared by the page-help assistant and AI Diagnostics, rendered on both of
// their settings pages, so it has its own route rather than a copy under each
// module's prefix. The single writer of `AiSpendCurrencySettings`.
//
// Same permission shape as the two budget routes beside it: support view reads
// the rate, support edit sets it. Like the caps, the rate is a deployment-
// specific operational control and does NOT travel in a config-transfer bundle
// (see config-transfer club-settings.ts). Not module-gated (feature-routes.ts):
// it belongs to two modules and spends nothing.

const updateSchema = z
  .object({
    // The decimal as typed ("0.92"): parsed server-side by the canonical
    // parser, which is what rejects zero, a sign, a symbol, over-precision and
    // anything above the bound — the client's check is a courtesy, not the gate.
    clubUnitsPerNzd: z.string().trim().min(1).max(32),
  })
  .strict();

function toResponse(currency: AiSpendCurrency) {
  return {
    clubCurrency: currency.clubCurrency,
    isNzd: currency.isNzd,
    isConfigured: currency.isConfigured,
    clubUnitsPerNzdMicros: currency.clubUnitsPerNzdMicros,
    clubUnitsPerNzd: formatClubUnitsPerNzd(currency.clubUnitsPerNzdMicros),
    rateSetAt: currency.rateSetAt?.toISOString() ?? null,
    rateSetByMemberId: currency.rateSetByMemberId,
  };
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  return NextResponse.json(toResponse(await loadAiSpendCurrency()));
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  // An NZD club has nothing to convert: the rate is identity by definition and
  // the settings pages render no editor. Refuse rather than store a row that
  // nothing would ever read.
  const current = await loadAiSpendCurrency();
  if (current.isNzd) {
    return NextResponse.json(
      {
        error:
          "No conversion applies: this club's currency is New Zealand dollars, so AI spend is already counted in it.",
      },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const micros = parseClubUnitsPerNzdToMicros(parsed.data.clubUnitsPerNzd);
  if (micros === null) {
    return NextResponse.json(
      {
        error: describeRateInputRule(APP_CURRENCY),
      },
      { status: 400 },
    );
  }

  // Read the previous value, upsert, and write the audit log inside ONE
  // transaction so concurrent PUTs record accurate previous values (the same
  // race fix as the two budget routes).
  const now = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.aiSpendCurrencySettings.findUnique({
      where: { id: AI_SPEND_CURRENCY_SETTINGS_ID },
    });

    const updated = await tx.aiSpendCurrencySettings.upsert({
      where: { id: AI_SPEND_CURRENCY_SETTINGS_ID },
      create: {
        id: AI_SPEND_CURRENCY_SETTINGS_ID,
        clubUnitsPerNzdMicros: micros,
        rateSetAt: now,
        rateSetByMemberId: session.user.id,
      },
      update: {
        clubUnitsPerNzdMicros: micros,
        rateSetAt: now,
        rateSetByMemberId: session.user.id,
      },
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "AI_SPEND_CURRENCY_RATE_UPDATED",
        actor: { memberId: session.user.id },
        entity: {
          type: "AiSpendCurrencySettings",
          id: AI_SPEND_CURRENCY_SETTINGS_ID,
        },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "AI spend NZD-to-club-currency rate updated",
        metadata: {
          clubCurrency: current.clubCurrency,
          previousClubUnitsPerNzdMicros: existing?.clubUnitsPerNzdMicros ?? null,
          newClubUnitsPerNzdMicros: micros,
        },
        request: getAuditRequestContext(request),
      }),
    );

    return updated;
  });

  return NextResponse.json(
    toResponse({
      clubCurrency: current.clubCurrency,
      isNzd: false,
      isConfigured: true,
      clubUnitsPerNzdMicros: row.clubUnitsPerNzdMicros,
      rateSetAt: row.rateSetAt,
      rateSetByMemberId: row.rateSetByMemberId,
    }),
  );
}
