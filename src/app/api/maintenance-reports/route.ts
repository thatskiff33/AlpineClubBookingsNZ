import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit-http";
import { sendAdminMaintenanceReportAlert } from "@/lib/email";
import logger from "@/lib/logger";
import {
  MAX_MAINTENANCE_PHOTO_DATA_URL_LENGTH,
} from "@/lib/maintenance-report-photo";
import { loadMaintenanceReportSettings } from "@/lib/maintenance-report-settings";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  MAX_MAINTENANCE_QUESTIONS,
  MAX_MAINTENANCE_SUMMARY_LENGTH,
  MaintenanceReportValidationError,
  createMaintenanceReport,
  loadActiveMaintenanceQuestions,
} from "@/lib/maintenance-reports";
import { prisma } from "@/lib/prisma";
import { applyMemberScopedRateLimit, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSession } from "@/lib/session-guards";
import { resolveMaintenanceAlertPayload } from "@/lib/maintenance-report-alert";

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

const submitSchema = z
  .object({
    lodgeId: z.string().trim().min(1).max(64),
    summary: z.string().trim().min(1).max(MAX_MAINTENANCE_SUMMARY_LENGTH),
    answers: z
      .array(
        z.object({
          questionId: z.string().trim().min(1).max(64),
          // Bounded here only so an oversized payload is refused before the
          // service walks it; the real per-type limits live in the service, which
          // is the half both doors share.
          value: z.string().max(4000),
        }),
      )
      .max(MAX_MAINTENANCE_QUESTIONS)
      .optional()
      .default([]),
    photoDataUrl: z
      .string()
      .max(MAX_MAINTENANCE_PHOTO_DATA_URL_LENGTH)
      .optional()
      .nullable(),
  })
  .strict();

export async function GET() {
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

  return NextResponse.json({
    questions,
    lodges,
    // Only the two facts the member form can act on. `anonymousReportsEnabled`
    // and the retention window are admin policy and are deliberately absent.
    photosEnabled: settings.photosEnabled,
    summaryMaxLength: MAX_MAINTENANCE_SUMMARY_LENGTH,
  });
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = submitSchema.safeParse(body);
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
        photoDataUrl: parsed.data.photoDataUrl ?? null,
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

  return NextResponse.json({ id: created.id }, { status: 201 });
}
