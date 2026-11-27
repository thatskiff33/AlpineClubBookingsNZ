import { NextRequest, NextResponse } from "next/server";

import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit-http";
import { sendAdminMaintenanceReportAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { loadMaintenanceReportSettings } from "@/lib/maintenance-report-settings";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  MAX_MAINTENANCE_SUMMARY_LENGTH,
  MaintenanceReportValidationError,
  createMaintenanceReport,
  loadActiveMaintenanceQuestions,
} from "@/lib/maintenance-reports";
import { prisma } from "@/lib/prisma";
import { applyMemberScopedRateLimit, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSession } from "@/lib/session-guards";
import { resolveMaintenanceAlertPayload } from "@/lib/maintenance-report-alert";
import {
  memberMaintenanceReportConnectionSchema,
  memberMaintenanceReportSchema,
} from "@/lib/maintenance-report-schema";
import {
  MAINTENANCE_REPORT_CREATED_CONNECTION_SHAPE,
  MAINTENANCE_REPORT_FORM_CONNECTION_SHAPE,
} from "@/lib/connection-shapes-lodge-life";
import { arrivesAsMcpConnection, connectionJson } from "@/lib/mcp-connection-request";

/**
 * The SIGNED-IN maintenance-report door (#2780), deliberately a separate file
 * from the QR door at `/api/lodge-maintenance/[token]`.
 *
 * The two share the submit service (`createMaintenanceReport`) so the question
 * set, answer validation, photo rules and answers-as-asked snapshot cannot drift
 * between them, and share nothing else — because everything else about them is
 * different. Here the caller is an active member session, the rate limit is
 * member-scoped, the report carries `memberId`, and no IP fingerprint is kept.
 *
 * GET returns what the form needs to render: the active question set, the lodges
 * that may be reported against, and whether a photo may be attached. It is a
 * member-only read and returns nothing about tokens, settings the member cannot
 * act on, or other people's reports.
 *
 * THE MODULE GATE IS ENFORCED HERE AS WELL AS UPSTREAM. `src/proxy.ts`'s matcher
 * lists this prefix so the feature-route rule 404s both methods when
 * `maintenanceReports` is off, but a module gate that lived only in middleware
 * shipped bypassed once already on the sibling QR route — so both GET and POST
 * re-check the flag directly (defence in depth, #2780 security review) and 404 an
 * off module. `loadEffectiveModuleFlags` fails closed on a read error.
 *
 * Both methods are also AI app actions (ALP-796): `get_maintenance_report_form`
 * and `report_maintenance_issue`. A connection reports without a photo
 * (`memberMaintenanceReportConnectionSchema`), so it is not told whether
 * photos are on.
 */

/**
 * 404 when the module is off, mirroring the feature-route gate's own response so
 * a member with the module off cannot tell this route apart from one that does
 * not exist. Returns null when the module is on.
 */
async function maintenanceModuleGate() {
  const modules = await loadEffectiveModuleFlags();
  if (!modules.maintenanceReports) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}


export async function GET(request: NextRequest) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;

  const moduleOff = await maintenanceModuleGate();
  if (moduleOff) return moduleOff;

  const [questions, settings, lodges] = await Promise.all([
    loadActiveMaintenanceQuestions(),
    loadMaintenanceReportSettings(),
    prisma.lodge.findMany({
      where: { active: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true, isDefault: true },
    }),
  ]);

  return connectionJson(request, {
    questions,
    lodges,
    // Only the two facts the member form can act on. `anonymousReportsEnabled`
    // and the retention window are admin policy and are deliberately absent.
    photosEnabled: settings.photosEnabled,
    summaryMaxLength: MAX_MAINTENANCE_SUMMARY_LENGTH,
  }, MAINTENANCE_REPORT_FORM_CONNECTION_SHAPE);
}

export async function POST(request: NextRequest) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const memberId = guard.session.user.id;

  const moduleOff = await maintenanceModuleGate();
  if (moduleOff) return moduleOff;

  // Member-scoped, with the shared-IP backstop at ten times the budget: a lodge
  // full of members on one wifi must not spend each other's allowance, and one
  // member rotating addresses must not get a fresh one.
  const limited = await applyMemberScopedRateLimit(
    rateLimiters.maintenanceReportMember,
    request,
    memberId,
  );
  if (limited) return limited;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const schema = arrivesAsMcpConnection(request)
    ? memberMaintenanceReportConnectionSchema
    : memberMaintenanceReportSchema;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const [settings, questions, lodge, member] = await Promise.all([
    loadMaintenanceReportSettings(),
    loadActiveMaintenanceQuestions(),
    prisma.lodge.findFirst({
      where: { id: parsed.data.lodgeId, active: true },
      select: { id: true, name: true },
    }),
    prisma.member.findUnique({
      where: { id: memberId },
      select: { firstName: true, lastName: true, email: true },
    }),
  ]);

  // An inactive or unknown lodge is refused rather than defaulted. Defaulting
  // would file a fault against the wrong building, which is worse than an error.
  if (!lodge) {
    return NextResponse.json(
      { error: "Please choose a lodge to report against." },
      { status: 400 },
    );
  }
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  let created;
  try {
    created = await createMaintenanceReport(
      {
        source: "MEMBER_PORTAL",
        memberId,
        lodgeId: lodge.id,
        summary: parsed.data.summary,
        answers: parsed.data.answers,
        photoDataUrl:
          "photoDataUrl" in parsed.data && typeof parsed.data.photoDataUrl === "string"
            ? parsed.data.photoDataUrl
            : null,
      },
      settings,
      questions,
    );
  } catch (err) {
    if (err instanceof MaintenanceReportValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    logger.error({ err }, "Failed to create member maintenance report");
    return NextResponse.json(
      { error: "Something went wrong sending that report. Please try again." },
      { status: 500 },
    );
  }

  logAudit({
    action: "maintenance.report.submitted",
    // `lodge`, because the affected business domain is the physical lodge — the
    // #2581 rule is the domain, never who acted and never which surface reads it.
    // Note `lodge` is NOT in MEMBER_VISIBLE_AUDIT_CATEGORIES, so this row does
    // not appear on the reporter's own timeline. That is the correct answer for
    // the taxonomy and it means the payload below carries no member-visible text
    // to review under INV-PRIV; it is stated rather than left implicit because a
    // reader would otherwise have to go and check.
    category: "lodge",
    memberId,
    targetId: created.id,
    entityType: "MaintenanceReport",
    entityId: created.id,
    details: JSON.stringify({
      lodgeId: lodge.id,
      source: "MEMBER_PORTAL",
      answerCount: created.answerCount,
      hasPhoto: created.hasPhoto,
    }),
    ipAddress: getClientIp(request),
  });

  // AFTER the transaction, and never awaited into the response: a slow mail
  // server must not hold a database transaction open (AGENTS.md) and must not
  // fail a report that is already stored.
  void resolveMaintenanceAlertPayload({
    reportId: created.id,
    lodgeName: lodge.name,
    reportedBy: `${member.firstName} ${member.lastName}`.trim() || member.email,
    source: "MEMBER_PORTAL",
    hasPhoto: created.hasPhoto,
    request,
  })
    .then((payload) => sendAdminMaintenanceReportAlert(payload))
    .catch((err) =>
      logger.error(
        { err, reportId: created.id },
        "Failed to send admin maintenance report alert",
      ),
    );

  return connectionJson(
    request,
    { id: created.id },
    MAINTENANCE_REPORT_CREATED_CONNECTION_SHAPE,
    { status: 201 },
  );
}
