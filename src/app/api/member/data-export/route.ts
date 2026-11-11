import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { checkRateLimit, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { createAuditLog } from "@/lib/audit";
import { grantSelfDataExportDietaryAccess } from "@/lib/member-dietary";
import { buildSubjectAccessExport } from "@/lib/subject-access-export";
import { subjectAccessExportResponse } from "@/lib/subject-access-export-response";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  // Rate limit by member ID (not IP), 5 exports per day
  const rl = await checkRateLimit(rateLimiters.dataExport, session.user.id);
  if (!rl.success) {
    const retryAfter = Math.ceil((rl.resetAt - Date.now()) / 1000);
    return NextResponse.json(
      { error: "Too many requests. You may export your data up to 5 times per day." },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(rl.limit),
          "X-RateLimit-Remaining": "0",
        },
      }
    );
  }

  try {
    const payload = await buildSubjectAccessExport(
      { memberId: session.user.id }, grantSelfDataExportDietaryAccess(session),
    );
    if (!payload) return NextResponse.json({ error: "Member not found" }, { status: 404 });
    await createAuditLog({ action: "member.data_exported", category: "privacy", memberId: session.user.id,
      targetId: session.user.id, details: "Member downloaded their subject access export." });
    return subjectAccessExportResponse(payload);
  } catch (err) {
    logger.error({ err, memberId: session.user.id }, "Data export failed");
    return NextResponse.json({ error: "Failed to generate data export" }, { status: 500 });
  }
}

