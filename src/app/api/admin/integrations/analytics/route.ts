import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  ANALYTICS_SETTINGS_ID,
  describeAnalyticsStatus,
  loadAnalyticsSettings,
  normalizeAnalyticsSettings,
  parseBannerMessage,
  parseMeasurementId,
} from "@/lib/analytics-settings";
import { DEFAULT_ANALYTICS_BANNER_MESSAGE } from "@/lib/analytics-settings-shared";
import { prisma } from "@/lib/prisma";
import { PUBLIC_LAYOUT_CACHE_TAGS } from "@/lib/public-layout-cache";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";
import { requireAdmin } from "@/lib/session-guards";
import { loadPrivacyPolicyPageState } from "@/lib/analytics-privacy-policy";

/**
 * GET/PUT /api/admin/integrations/analytics — the club's Google Analytics
 * configuration (#2573).
 *
 * ## Permissions
 *
 * The repository's established integration permission model, unchanged: everything
 * under `/api/admin/integrations` resolves to the `finance` admin area (see
 * `ROUTE_AREA_PREFIXES` in `src/lib/admin-permissions.ts`, which is where Xero,
 * Stripe and Google sign-in setup already live). Read needs `finance:view`, write
 * needs `finance:edit`, and both are enforced HERE rather than only in the UI.
 *
 * ## Module gating
 *
 * `src/config/feature-routes.ts` registers this prefix under the `analytics` flag,
 * so `src/proxy.ts` answers 404 on the whole subtree while Admin -> Modules has the
 * module switched off. Admin -> Modules stays the master switch (owner decision
 * section 1), and a module-off club therefore cannot read or write this
 * configuration at all — the Integrations card is hidden by the same flag.
 *
 * ## The measurement ID is configuration, not a secret
 *
 * It is published in the page source of every page the tag runs on, so it is stored
 * in plain text rather than through `IntegrationCredential`, and the UI does not
 * describe it as a secret. It is still behind the permissions above, because who may
 * point a club's website at a Google property is an access question either way.
 */

const updateSchema = z
  .object({
    measurementId: z.string().max(200),
    consentBannerEnabled: z.boolean(),
    bannerMessage: z.string().max(2000),
  })
  .strict();

async function buildPayload() {
  const settings = await loadAnalyticsSettings();
  return {
    settings,
    status: describeAnalyticsStatus(settings),
    defaultBannerMessage: DEFAULT_ANALYTICS_BANNER_MESSAGE,
    privacyPolicy: await loadPrivacyPolicyPageState(),
  };
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;

  return NextResponse.json(await buildPayload());
}

export async function PUT(request: Request) {
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

  const measurementIdResult = parseMeasurementId(parsed.data.measurementId);
  if (!measurementIdResult.ok) {
    return NextResponse.json(
      { error: measurementIdResult.error, field: "measurementId" },
      { status: 400 },
    );
  }

  // A non-empty message is required while the banner is ON; while it is off an
  // empty submission keeps whatever is stored (issue body: "preserve the saved text
  // if the banner is temporarily disabled").
  const bannerMessageResult = parseBannerMessage(
    parsed.data.bannerMessage,
    parsed.data.consentBannerEnabled,
  );
  if (!bannerMessageResult.ok) {
    return NextResponse.json(
      { error: bannerMessageResult.error, field: "bannerMessage" },
      { status: 400 },
    );
  }

  /*
    Read-then-write inside ONE transaction, so two concurrent saves cannot both
    record the same stale "previous" values in the audit log (the shape
    `/api/admin/ai-assistant/settings` uses, for the same reason).

    `consentRevision` is deliberately NOT in the update: an ordinary Save must never
    re-prompt visitors, however much the wording changed (owner decision section 6).
    The only writer of that column is the reconsent route beside this one.
  */
  const updated = await prisma.$transaction(async (tx) => {
    const existingRow = await tx.analyticsSettings.findUnique({
      where: { id: ANALYTICS_SETTINGS_ID },
    });
    const existing = normalizeAnalyticsSettings(existingRow);

    // Null means "no message submitted, banner is off" — keep the stored wording.
    const bannerMessage =
      bannerMessageResult.bannerMessage ?? existing.bannerMessage;

    const row = await tx.analyticsSettings.upsert({
      where: { id: ANALYTICS_SETTINGS_ID },
      create: {
        id: ANALYTICS_SETTINGS_ID,
        measurementId: measurementIdResult.measurementId,
        consentBannerEnabled: parsed.data.consentBannerEnabled,
        bannerMessage,
        updatedByMemberId: session.user.id,
      },
      update: {
        measurementId: measurementIdResult.measurementId,
        consentBannerEnabled: parsed.data.consentBannerEnabled,
        bannerMessage,
        updatedByMemberId: session.user.id,
      },
    });

    const after = normalizeAnalyticsSettings(row);

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "ANALYTICS_SETTINGS_UPDATED",
        actor: { memberId: session.user.id },
        entity: { type: "AnalyticsSettings", id: ANALYTICS_SETTINGS_ID },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Google Analytics integration settings updated",
        metadata: {
          // Structured before/after, deliberately WITHOUT the banner wording: the
          // issue body asks not to put full banner text into audit summaries, and a
          // 500-character paragraph in an audit row is noise. Whether it changed is
          // the auditable fact; the current wording is on the settings screen.
          previousMeasurementId: existing.measurementId,
          newMeasurementId: after.measurementId,
          previousConsentBannerEnabled: existing.consentBannerEnabled,
          newConsentBannerEnabled: after.consentBannerEnabled,
          bannerMessageChanged: existing.bannerMessage !== after.bannerMessage,
          bannerMessageLength: after.bannerMessage.length,
          consentRevision: after.consentRevision,
        },
        request: getAuditRequestContext(request),
      }),
    );

    return after;
  });

  /*
    Clear the stored public pages as well as the tagged data cache (#2352 F3).

    A tag-only clear is not enough and the failure would be silent: since the CMS
    pages are served from the full-route ISR store, what a visitor gets is a stored
    render of the layout — analytics runtime and all — so removing a measurement ID
    would have left the tag firing from every stored page until the 300-second
    backstop lapsed. That is precisely "a disabled or invalid configuration leaving a
    stale Google tag active", which owner decision section 12 forbids.
  */
  revalidatePublicSite(PUBLIC_LAYOUT_CACHE_TAGS.analytics);

  return NextResponse.json({
    settings: updated,
    status: describeAnalyticsStatus(updated),
    defaultBannerMessage: DEFAULT_ANALYTICS_BANNER_MESSAGE,
    privacyPolicy: await loadPrivacyPolicyPageState(),
  });
}
