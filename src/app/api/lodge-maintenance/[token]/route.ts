import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { logAudit } from "@/lib/audit";
import { sendAdminMaintenanceReportAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { resolveMaintenanceAlertPayload } from "@/lib/maintenance-report-alert";
import { MAX_MAINTENANCE_PHOTO_DATA_URL_LENGTH } from "@/lib/maintenance-report-photo";
import { loadMaintenanceReportSettings } from "@/lib/maintenance-report-settings";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  MAX_MAINTENANCE_QUESTIONS,
  MAX_MAINTENANCE_REPORTER_CONTACT_LENGTH,
  MAX_MAINTENANCE_REPORTER_NAME_LENGTH,
  MAX_MAINTENANCE_SUMMARY_LENGTH,
  MaintenanceReportValidationError,
  createMaintenanceReport,
  loadActiveMaintenanceQuestions,
} from "@/lib/maintenance-reports";
import {
  resolveLodgeForMaintenanceToken,
  touchMaintenanceTokenLastUsed,
} from "@/lib/maintenance-report-tokens";
import { getClientIp, applyRateLimit, rateLimiters } from "@/lib/rate-limit";

/**
 * THE UNAUTHENTICATED DOOR (#2780, owner decision 5). Read this whole docblock
 * before changing anything in this file.
 *
 * WHAT A CALLER HOLDING A VALID TOKEN MAY DO. Exactly two things: read the active
 * question set plus the name of the lodge the token belongs to, and submit one
 * maintenance report for that lodge. Nothing else is readable or writable. There
 * is no account data on this surface at all — not a member name, not an email,
 * not a booking, not a count of anything — and the report it creates carries
 * `memberId: null` by construction rather than by a check (`AnonymousSubmission`
 * has no field for one).
 *
 * FOUR GATES, ALL ANSWERING THE SAME 404. The module must be on, the club-wide
 * `anonymousReportsEnabled` setting must be on, the token must resolve, and both
 * the token and its lodge must be active. Every failure returns the identical
 * generic 404 with no body detail, so the endpoint is not an oracle for "is this
 * a real token" or "does this club have the feature on". The module gate answers
 * upstream in `src/proxy.ts` from `FEATURE_ROUTE_RULES` (its matcher lists this
 * prefix) AND again here in `resolveGate` as defence in depth — a module gate
 * that lived only in middleware shipped bypassed once already (the matcher was
 * missing this prefix), so it is enforced in both places now. The other three
 * gates answer here, and `resolveLodgeForMaintenanceToken` collapses its own
 * several failure reasons to one `null` before this file ever sees them.
 *
 * THE TOKEN IS NEVER ECHOED. It is read from the path, hashed, and dropped. It is
 * not returned in any response body, not logged (the shared redaction layer
 * strips `/lodge-maintenance/<token>` from log lines and Sentry events), and not
 * put in an error message. The page that calls this route holds it in the URL the
 * browser already has and nowhere else.
 *
 * TWO SEPARATE BUDGETS, BOTH PER IP. Reads are throttled by
 * `maintenanceReportToken` (30 per 15 minutes) because the read is the only
 * endpoint that answers anything about a token at all, so it is what an
 * enumeration attempt would hammer; submits are throttled far harder by
 * `maintenanceReportAnonymous` (5 per hour) because each one costs the club a row
 * and an email. Sizing them together would either break an honest reload or hand
 * a script five hundred submissions.
 *
 * `no-store` ON EVERY RESPONSE. A tokenised page's JSON must never sit in a
 * shared cache, and a 404 must not be cached either — an admin who mints a token
 * a minute later would otherwise still be refused.
 */

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  // Belt and braces alongside the page's own metadata: nothing here should ever
  // reach an index.
  "X-Robots-Tag": "noindex, nofollow",
} as const;

/**
 * The ONE failure response. Every gate returns this — wrong shape, unknown token,
 * deactivated token, deactivated lodge, feature off. Callers must not add a
 * reason, a code, or a different status to any of them.
 */
function genericNotFound() {
  return NextResponse.json(
    { error: "Not found" },
    { status: 404, headers: NO_STORE_HEADERS },
  );
}

const submitSchema = z
  .object({
    summary: z.string().trim().min(1).max(MAX_MAINTENANCE_SUMMARY_LENGTH),
    answers: z
      .array(
        z.object({
          questionId: z.string().trim().min(1).max(64),
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
    reporterName: z
      .string()
      .trim()
      .max(MAX_MAINTENANCE_REPORTER_NAME_LENGTH)
      .optional()
      .nullable(),
    reporterContact: z
      .string()
      .trim()
      .max(MAX_MAINTENANCE_REPORTER_CONTACT_LENGTH)
      .optional()
      .nullable(),
  })
  // `.strict()` is load-bearing here rather than tidy: it is what refuses a
  // payload carrying `memberId`, `lodgeId`, `status` or any other field somebody
  // hopes the service will read, instead of silently ignoring it.
  .strict();

/**
 * Resolve the four gates, or null. Shared by GET and POST so they cannot answer
 * differently — a read that succeeded where a submit would 404 (or the reverse)
 * would itself be the oracle this design avoids.
 */
async function resolveGate(rawToken: string) {
  // MODULE GATE, IN-HANDLER (defence in depth, #2780 security review). The proxy
  // matcher also runs the upstream module gate on this prefix, but a module gate
  // that lives ONLY in middleware is one matcher edit from being bypassed — which
  // is exactly the regression this route shipped with. So the closure is enforced
  // here too: with `maintenanceReports` off, both GET and POST 404 regardless of
  // `anonymousReportsEnabled`. `loadEffectiveModuleFlags` fails closed (false) on
  // a read error, so an outage refuses the anonymous door rather than opening it.
  const modules = await loadEffectiveModuleFlags();
  if (!modules.maintenanceReports) {
    return null;
  }

  const settings = await loadMaintenanceReportSettings();
  if (!settings.anonymousReportsEnabled) {
    return null;
  }

  const lodge = await resolveLodgeForMaintenanceToken(rawToken);
  if (!lodge) {
    return null;
  }

  return { settings, lodge };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const limited = await applyRateLimit(rateLimiters.maintenanceReportToken, request);
  if (limited) return limited;

  const { token } = await context.params;
  const gate = await resolveGate(token);
  if (!gate) return genericNotFound();

  const questions = await loadActiveMaintenanceQuestions();

  return NextResponse.json(
    {
      // The lodge NAME only. The id is deliberately absent: it means something in
      // every other API in this application, and nothing here needs it — the
      // submit route re-derives it from the token rather than accepting one.
      lodgeName: gate.lodge.lodgeName,
      questions,
      photosEnabled: gate.settings.photosEnabled && gate.settings.anonymousPhotosEnabled,
      contactPrompt: gate.settings.anonymousContactPrompt,
      summaryMaxLength: MAX_MAINTENANCE_SUMMARY_LENGTH,
    },
    { headers: NO_STORE_HEADERS },
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const limited = await applyRateLimit(
    rateLimiters.maintenanceReportAnonymous,
    request,
  );
  if (limited) return limited;

  const { token } = await context.params;
  const gate = await resolveGate(token);
  if (!gate) return genericNotFound();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please check the form and try again." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const questions = await loadActiveMaintenanceQuestions();

  // The contact prompt being off is enforced, not just hidden. A club that turned
  // it off has decided it does not want anonymous contact details stored, and a
  // hand-crafted payload must not be able to store them anyway.
  const contactAllowed = gate.settings.anonymousContactPrompt;

  let created;
  try {
    created = await createMaintenanceReport(
      {
        source: "LODGE_QR",
        lodgeId: gate.lodge.lodgeId,
        summary: parsed.data.summary,
        answers: parsed.data.answers,
        photoDataUrl: parsed.data.photoDataUrl ?? null,
        reporterName: contactAllowed ? parsed.data.reporterName ?? null : null,
        reporterContact: contactAllowed ? parsed.data.reporterContact ?? null : null,
        submitterIp: getClientIp(request),
      },
      gate.settings,
      questions,
    );
  } catch (err) {
    if (err instanceof MaintenanceReportValidationError) {
      return NextResponse.json(
        { error: err.message },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    logger.error({ err }, "Failed to create anonymous maintenance report");
    return NextResponse.json(
      { error: "Something went wrong sending that report. Please try again." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  void touchMaintenanceTokenLastUsed(gate.lodge.tokenId);

  logAudit({
    action: "maintenance.report.submitted",
    // Same action and category as the member door, because it is the same event
    // in the same domain. What differs is `memberId: null` and the `source` in
    // the details, which is what an operator correlating the two needs.
    category: "lodge",
    // No member acted, and none may be inferred. A self-declared name in the
    // payload is free text that proves nothing, so it is deliberately NOT copied
    // into the audit row's member fields.
    memberId: null,
    targetId: created.id,
    entityType: "MaintenanceReport",
    entityId: created.id,
    details: JSON.stringify({
      lodgeId: gate.lodge.lodgeId,
      source: "LODGE_QR",
      answerCount: created.answerCount,
      hasPhoto: created.hasPhoto,
      selfDeclaredContact:
        contactAllowed &&
        Boolean(parsed.data.reporterName || parsed.data.reporterContact),
    }),
    ipAddress: getClientIp(request),
  });

  void resolveMaintenanceAlertPayload({
    reportId: created.id,
    lodgeName: gate.lodge.lodgeName,
    // The label says plainly that nobody signed in. Where a name WAS typed it is
    // shown as a claim rather than as an identity, because on this path it is
    // exactly that — see the template, which escapes it.
    reportedBy:
      contactAllowed && parsed.data.reporterName
        ? `Not signed in — gave their name as "${parsed.data.reporterName}"`
        : "Not signed in (QR code in the lodge)",
    source: "LODGE_QR",
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

  return NextResponse.json(
    { ok: true },
    { status: 201, headers: NO_STORE_HEADERS },
  );
}
