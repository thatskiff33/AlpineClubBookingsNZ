import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
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
import { prisma } from "@/lib/prisma";
import { MODULE_KEYS, type ModuleSettingsValues } from "@/config/modules";

const moduleSettingsSchema = z
  .object({
    kiosk: z.boolean(),
    chores: z.boolean(),
    financeDashboard: z.boolean(),
    waitlist: z.boolean(),
    xeroIntegration: z.boolean(),
    bedAllocation: z.boolean(),
    internetBankingPayments: z.boolean(),
  })
  .strict();

const updateSchema = z
  .object({
    settings: moduleSettingsSchema,
  })
  .strict();

async function requireAdminSession() {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      session: null,
    };
  }
  if (session.user.role !== "ADMIN") {
    return {
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      session: null,
    };
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return { response: inactiveResponse, session: null };
  }

  return { response: null, session };
}

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
  const { response } = await requireAdminSession();
  if (response) {
    return response;
  }

  return NextResponse.json(await loadClubModuleSettings());
}

export async function PUT(request: Request) {
  const { response, session } = await requireAdminSession();
  if (response) {
    return response;
  }
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  const existing = await prisma.clubModuleSettings.findUnique({
    where: { id: CLUB_MODULE_SETTINGS_ID },
  });
  const before = normalizeClubModuleSettings(existing);
  const after = parsed.data.settings;
  const changes = getChanges(before, after);
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

  return NextResponse.json(buildClubModuleSettingsPayload(record));
}
