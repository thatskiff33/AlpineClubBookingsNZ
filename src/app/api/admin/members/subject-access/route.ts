import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { isFullAdmin } from "@/lib/access-roles";
import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/audit";
import { checkRateLimit, rateLimiters, rateLimitedResponse } from "@/lib/rate-limit";
import { grantOfficerSubjectAccessDietaryAccess } from "@/lib/member-dietary";
import { buildSubjectAccessExport, type SubjectAccessSubject } from "@/lib/subject-access-export";
import { subjectAccessExportResponse } from "@/lib/subject-access-export-response";
import logger from "@/lib/logger";

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({ permission: { area: "membership", level: "view" } });
  if (!guard.ok) return guard.response;
  if (!isFullAdmin(guard.session.user)) return NextResponse.json({ error: "Full Admin required" }, { status: 403 });
  const limit = await checkRateLimit(rateLimiters.subjectAccessReport, guard.session.user.id);
  if (!limit.success) return rateLimitedResponse(limit);
  const params = request.nextUrl.searchParams;
  const memberId = params.get("memberId")?.trim();
  const email = params.get("email")?.trim().toLowerCase();
  const guestId = params.get("guestId")?.trim();
  if ([memberId, email, guestId].filter(Boolean).length !== 1 ||
      (email && (!email.includes("@") || email.length > 200))) {
    return NextResponse.json({ error: "Supply exactly one memberId, email or guestId" }, { status: 400 });
  }
  try {
    const member = guestId ? null : await prisma.member.findFirst({
      where: memberId ? { id: memberId } : { email: { equals: email!, mode: "insensitive" } },
      select: { id: true },
    });
    if (memberId && !member) return NextResponse.json({ error: "Member not found" }, { status: 404 });
    const subject: SubjectAccessSubject = member ? { memberId: member.id } : guestId ? { guestId } : { email: email! };
    const grant = await grantOfficerSubjectAccessDietaryAccess(guard.session.user.id,
      member ? { memberId: member.id } : { guestId });
    if (!grant) return NextResponse.json({ error: "Full Admin required" }, { status: 403 });
    const payload = await buildSubjectAccessExport(subject, grant);
    if (!payload) return NextResponse.json({ error: "Subject not found" }, { status: 404 });
    await createAuditLog({ action: "member.subject_access_exported", category: "privacy",
      memberId: guard.session.user.id, targetId: member?.id ?? guestId ?? email!,
      details: "Officer produced a subject access report.", metadata: { subject } });
    return subjectAccessExportResponse(payload);
  } catch (err) {
    logger.error({ err }, "Subject access report failed");
    return NextResponse.json({ error: "Failed to generate report" }, { status: 500 });
  }
}
