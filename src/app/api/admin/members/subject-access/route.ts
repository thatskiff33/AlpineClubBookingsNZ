/**
 * Full Admin subject access report (#4915, `INV-PRIV-023`)
 * GET /api/admin/members/subject-access?memberId=… | ?email=… | ?guestId=…
 *
 * The same file a member downloads from Profile, produced by the one shared
 * builder for the person a privacy officer is answering: a member (dependants
 * included), a non-member found by the email they gave on a booking request or
 * application, or a non-member guest found by the exact id of their guest row
 * (guest rows hold no email address). Full Admins only, with a fresh sign-in
 * proof, rate-limited per officer, and every file produced is audited.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { requireRecentAuth } from "@/lib/require-recent-auth";
import { isFullAdmin } from "@/lib/access-roles";
import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/audit";
import { checkRateLimit, rateLimiters, rateLimitedResponse } from "@/lib/rate-limit";
import { grantOfficerSubjectAccessDietaryAccess } from "@/lib/member-dietary";
import { buildSubjectAccessExport, type SubjectAccessSubject } from "@/lib/subject-access-export";
import { subjectAccessExportResponse } from "@/lib/subject-access-export-response";
import logger from "@/lib/logger";

const FULL_ADMIN_REQUIRED = { error: "Only a Full Admin can produce a subject access report." };

type Lookup = { memberId: string } | { email: string } | { guestId: string };

function readLookup(params: URLSearchParams): Lookup | null {
  const memberId = params.get("memberId")?.trim();
  const email = params.get("email")?.trim().toLowerCase();
  const guestId = params.get("guestId")?.trim();
  if ([memberId, email, guestId].filter(Boolean).length !== 1) return null;
  if (memberId) return memberId.length <= 64 ? { memberId } : null;
  if (guestId) return guestId.length <= 64 ? { guestId } : null;
  return email && email.includes("@") && email.length <= 200 ? { email } : null;
}

/**
 * Who the lookup names. Member emails are not unique (a dependant may share a
 * parent's address), so an email matching several member records is refused
 * rather than guessed: the officer opens that member's own page instead. A
 * guest row linked to a member is that member's record.
 */
async function resolveSubject(
  lookup: Lookup,
): Promise<{ subject: SubjectAccessSubject } | { status: 404 | 409; error: string }> {
  if ("memberId" in lookup) {
    const member = await prisma.member.findUnique({ where: { id: lookup.memberId }, select: { id: true } });
    return member ? { subject: { memberId: member.id } } : { status: 404, error: "Member not found" };
  }
  if ("guestId" in lookup) {
    const guest = await prisma.bookingGuest.findUnique({
      where: { id: lookup.guestId },
      select: { id: true, memberId: true },
    });
    if (!guest) return { status: 404, error: "Guest not found" };
    return { subject: guest.memberId ? { memberId: guest.memberId } : { guestId: guest.id } };
  }
  const members = await prisma.member.findMany({
    where: { email: { equals: lookup.email, mode: "insensitive" } },
    select: { id: true },
    take: 2,
  });
  if (members.length > 1) {
    return {
      status: 409,
      error: "More than one member record uses this email. Open the member's own page and download their report there.",
    };
  }
  return { subject: members[0] ? { memberId: members[0].id } : { email: lookup.email } };
}

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({ permission: { area: "membership", level: "view" } });
  if (!guard.ok) return guard.response;
  if (!isFullAdmin(guard.session.user)) return NextResponse.json(FULL_ADMIN_REQUIRED, { status: 403 });
  // A whole person's record in one file: the same fresh proof the member CSV export asks for (INV-AUTH-010).
  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;
  const officerId = guard.session.user.id;

  const lookup = readLookup(request.nextUrl.searchParams);
  if (!lookup) {
    return NextResponse.json({ error: "Supply exactly one member ID, email address or guest ID." }, { status: 400 });
  }
  const limit = await checkRateLimit(rateLimiters.subjectAccessReport, officerId);
  if (!limit.success) return rateLimitedResponse(limit);

  try {
    const resolved = await resolveSubject(lookup);
    if (!("subject" in resolved)) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    const { subject } = resolved;
    // Re-checks Full Admin against the database, not the session.
    const grant = await grantOfficerSubjectAccessDietaryAccess(officerId, {
      memberId: "memberId" in subject ? subject.memberId : undefined,
      guestId: "guestId" in subject ? subject.guestId : undefined,
    });
    if (!grant) return NextResponse.json(FULL_ADMIN_REQUIRED, { status: 403 });
    const payload = await buildSubjectAccessExport(subject, grant);
    if (!payload) return NextResponse.json({ error: "No personal records found for this person." }, { status: 404 });

    await createAuditLog({
      action: "member.subject_access_exported",
      category: "privacy",
      memberId: officerId,
      actorMemberId: officerId,
      ...("memberId" in subject
        ? { targetId: subject.memberId, subjectMemberId: subject.memberId, entityType: "Member", entityId: subject.memberId }
        : "guestId" in subject
          ? { entityType: "BookingGuest", entityId: subject.guestId }
          : {}),
      details: "email" in subject
        ? `Produced a subject access report for the non-member email ${subject.email}.`
        : "Produced a subject access report.",
    });
    return subjectAccessExportResponse(payload, "subject-access-report");
  } catch (err) {
    logger.error({ err, officerId }, "Subject access report failed");
    return NextResponse.json({ error: "Failed to generate report" }, { status: 500 });
  }
}
