import { NextResponse } from "next/server";
import { z } from "zod";
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
  // The upsert below keeps its own `select`: it is a WRITE, and the shared read
  // helper cannot serve it — but its RETURNING must still name only the live
  // columns (#175), so it spreads the canonical constant rather than a literal.
  CLUB_MODULE_SETTINGS_COLUMN_SELECT,
  MODULE_KEYS,
  readClubModuleSettingsRecord,
  type ModuleKey,
  type ModuleSettingsValues,
} from "@/config/modules";

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

  return NextResponse.json(await loadClubModuleSettings());
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

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
            "Verify Google sign-in in the setup wizard (Admin → Integrations → Google) before enabling it.",
        },
        { status: 409 },
      );
    }
  }

  const write = prisma.clubModuleSettings.upsert({
    where: { id: CLUB_MODULE_SETTINGS_ID },
    create: {
      id: CLUB_MODULE_SETTINGS_ID,
      ...after,
      updatedByMemberId: session.user.id,
    },
    update: {
      ...after,
      updatedByMemberId: session.user.id,
    },
    select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
  });

  const record =
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
          ])
        )[0]
      : await write;

  // Full-route clear as well as the tag clear (#2352 F3): the module flags are
  // rendered INTO the public layout (the analytics banner, the nav), so under
  // full-route ISR a tag-only invalidation left every stored page showing the old
  // switch position until the 300-second backstop lapsed. `revalidatePublicSite()`
  // always clears the capacity tag, so it is not repeated here.
  revalidatePublicSite(PUBLIC_LAYOUT_CACHE_TAGS.modules);

  // The analytics readiness fact is a separate DB read (#2573); resolved here so the
  // response the toggle grid re-seeds from carries the same readiness message the GET
  // would return, rather than the fail-closed default.
  return NextResponse.json(
    buildClubModuleSettingsPayload(record, {
      analyticsConfigured: await isAnalyticsIntegrationConfigured(),
    }),
  );
}
