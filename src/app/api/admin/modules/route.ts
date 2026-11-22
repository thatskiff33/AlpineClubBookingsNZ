import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import { requireAdmin } from "@/lib/session-guards";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  CLUB_MODULE_SETTINGS_ID,
  buildClubModuleSettingsPayload,
  loadClubModuleSettings,
  normalizeClubModuleSettings,
} from "@/lib/module-settings";
import { isAnalyticsIntegrationConfigured } from "@/lib/analytics-settings";
import { getGoogleSetupState } from "@/lib/google-config";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { PUBLIC_LAYOUT_CACHE_TAGS } from "@/lib/public-layout-cache";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";
import {
  // The write below keeps its own `select`: the shared read helper cannot serve
  // a write, but its RETURNING must name only live columns (#175).
  CLUB_MODULE_SETTINGS_COLUMN_SELECT,
  MODULE_KEYS,
  readClubModuleSettingsRecord,
  type ModuleKey,
  type ModuleSettingsValues,
} from "@/config/modules";
import { clubFormatValues } from "@/lib/club-format-server";
import { requireRecentAuth } from "@/lib/require-recent-auth";
import { AI_DIAGNOSTICS_DISCLOSURE_VERSION } from "@/lib/ai-diagnostics-disclosure";
import { judgeAiDiagnosticsEnable } from "@/lib/ai-diagnostics-enable-gate";
import { isPrismaRecordNotFoundError } from "@/lib/prisma-errors";

const moduleSettingsSchema = z
  .object(
    Object.fromEntries(MODULE_KEYS.map((key) => [key, z.boolean()])) as Record<
      ModuleKey,
      z.ZodBoolean
    >,
  )
  .strict();

const updateSchema = z
  .object({
    settings: moduleSettingsSchema,
    // The disclosure version the administrator ticked on the Modules page (#5243).
    // Required only when this save switches AI Diagnostics on.
    aiDiagnosticsDisclosureAcknowledgedVersion: z.number().int().optional(),
  })
  .strict();

function getChanges(
  before: ModuleSettingsValues,
  after: ModuleSettingsValues,
) {
  return MODULE_KEYS.filter((key) => before[key] !== after[key]).map((key) => ({
    key,
    previous: before[key],
    next: after[key],
  }));
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  // The club's format (#3565), resolved once per request.
  const format = await clubFormatValues();
  return NextResponse.json(await loadClubModuleSettings(format));
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;
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

  const existing = await readClubModuleSettingsRecord(prisma);
  const before = normalizeClubModuleSettings(existing);
  const after = parsed.data.settings;
  const changes = getChanges(before, after);

  // Hard verify gate (#2087, D2): googleLogin may only be turned ON once a real
  // Google OAuth round-trip has verified the stored credentials. This is the
  // authoritative server-side lock (the setup wizard + security card also gate
  // the toggle in the UI). Fail-CLOSED here: if we cannot confirm verification,
  // refuse enabling rather than silently letting an unverified module through.
  if (!before.googleLogin && after.googleLogin) {
    let verified = false;
    try {
      const state = await getGoogleSetupState();
      verified = state.verified && !state.needsReentry;
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.name : "unknown" },
        "Could not confirm Google verification for the module enable-gate",
      );
    }
    if (!verified) {
      return NextResponse.json(
        {
          error:
            "Verify Google sign-in in the setup wizard (Admin → Integrations → Google Sign-in Setup) before enabling it.",
        },
        { status: 409 },
      );
    }
  }

  // The disclosure gate (#5243). An existing row is written with `update` (not
  // `updateMany`) only if it still holds the aiDiagnostics value judged here, so
  // a lost race throws P2025 and the array transaction rolls back with its audit
  // rows. With no row yet the upsert is unguarded: a racing first save can switch
  // Diagnostics on only with its own acknowledgement.
  const aiDiagnostics = judgeAiDiagnosticsEnable(
    before,
    after,
    parsed.data.aiDiagnosticsDisclosureAcknowledgedVersion,
  );
  if (aiDiagnostics.refusal) {
    return NextResponse.json({ error: aiDiagnostics.refusal }, { status: 409 });
  }

  const data = { ...after, updatedByMemberId: session.user.id };
  const write = existing
    ? prisma.clubModuleSettings.update({
        where: { id: CLUB_MODULE_SETTINGS_ID, aiDiagnostics: before.aiDiagnostics },
        data,
        select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
      })
    : prisma.clubModuleSettings.upsert({
        where: { id: CLUB_MODULE_SETTINGS_ID },
        create: { id: CLUB_MODULE_SETTINGS_ID, ...data },
        update: data,
        select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
      });

  let record;
  try {
    record =
      changes.length > 0
        ? (
            await prisma.$transaction([
              write,
              prisma.auditLog.create(
                buildStructuredAuditLogCreateArgs({
                  action: "CLUB_MODULE_SETTINGS_UPDATED",
                  actor: { memberId: session.user.id },
                  entity: {
                    type: "ClubModuleSettings",
                    id: CLUB_MODULE_SETTINGS_ID,
                  },
                  category: "admin",
                  severity: "important",
                  outcome: "success",
                  summary: "Club module settings updated",
                  metadata: {
                    changedModuleKeys: changes.map((change) => change.key),
                    changes,
                    previousSettings: before,
                    newSettings: after,
                  },
                  request: getAuditRequestContext(request),
                }),
              ),
              ...(aiDiagnostics.enables
                ? [
                    prisma.auditLog.create(
                      buildStructuredAuditLogCreateArgs({
                        action: "AI_DIAGNOSTICS_DISCLOSURE_ACKNOWLEDGED",
                        actor: { memberId: session.user.id },
                        entity: {
                          type: "ClubModuleSettings",
                          id: CLUB_MODULE_SETTINGS_ID,
                        },
                        category: "admin",
                        severity: "important",
                        outcome: "success",
                        summary:
                          "AI Diagnostics provider disclosure acknowledged when switching it on",
                        metadata: {
                          disclosureVersion: AI_DIAGNOSTICS_DISCLOSURE_VERSION,
                          recipient: "anthropic",
                        },
                        request: getAuditRequestContext(request),
                      }),
                    ),
                  ]
                : []),
            ])
          )[0]
        : await write;
  } catch (error) {
    if (!isPrismaRecordNotFoundError(error)) throw error;
    return NextResponse.json(
      {
        error:
          "Someone else changed the module settings while you were saving. Reload the page and try again.",
      },
      { status: 409 },
    );
  }

  // Full-route clear as well as the tag clear (#2352 F3): the module flags are
  // rendered INTO the public layout (the analytics banner, the nav), so under
  // full-route ISR a tag-only invalidation left every stored page showing the old
  // switch position until the 300-second backstop lapsed. `revalidatePublicSite()`
  // always clears the capacity tag, so it is not repeated here.
  revalidatePublicSite(PUBLIC_LAYOUT_CACHE_TAGS.modules);

  // The analytics readiness fact is a separate DB read (#2573); resolved here so the
  // response the toggle grid re-seeds from carries the same readiness message the GET
  // would return, rather than the fail-closed default.
  // The club's format (#3565), resolved once per request; the readiness text
  // it feeds names the module's default spend cap.
  const format = await clubFormatValues();
  return NextResponse.json(
    buildClubModuleSettingsPayload(format, record, {
      analyticsConfigured: await isAnalyticsIntegrationConfigured(),
    }),
  );
}
