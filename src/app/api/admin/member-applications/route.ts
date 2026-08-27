import { NextRequest, NextResponse } from "next/server";
import {
  parseApplicationAddress,
  parseApplicationFamilyMembers,
} from "@/lib/nomination";
import { NOMINATION_AUTOMATIC_REMINDER_LIMIT } from "@/lib/nomination-token-policy";
import { formatDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { z } from "zod";

const querySchema = z.object({
  status: z.enum(["PENDING_NOMINATORS", "PENDING_ADMIN", "APPROVED", "REJECTED"]).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, page, pageSize } = parsed.data;
  const where = status ? { status } : undefined;

  const [applications, total, pendingCount] = await Promise.all([
    prisma.memberApplication.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    prisma.memberApplication.count({ where }),
    prisma.memberApplication.count({ where: { status: "PENDING_ADMIN" } }),
  ]);

  const memberIds = Array.from(
    new Set(
      applications
        .flatMap((application) => [
          application.nominator1Id,
          application.nominator2Id,
          application.reviewedBy,
        ])
        .filter((value): value is string => Boolean(value))
    )
  );

  const members = memberIds.length
    ? await prisma.member.findMany({
        where: { id: { in: memberIds } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      })
    : [];

  const memberNameMap = new Map(
    members.map((member) => [member.id, `${member.firstName} ${member.lastName}`.trim()])
  );
  const applicationIds = applications.map((application) => application.id);
  const pendingTokens = applicationIds.length
    ? await prisma.nominationToken.findMany({
        where: {
          applicationId: { in: applicationIds },
          confirmedAt: null,
        },
        orderBy: [{ createdAt: "desc" }],
        select: {
          id: true,
          applicationId: true,
          nominatorMemberId: true,
          expiresAt: true,
          reminderCount: true,
          lastSentAt: true,
          createdAt: true,
        },
      })
    : [];
  const latestPendingTokenByApplicationAndNominator = new Map<
    string,
    (typeof pendingTokens)[number]
  >();

  for (const token of pendingTokens) {
    const key = `${token.applicationId}:${token.nominatorMemberId}`;
    if (!latestPendingTokenByApplicationAndNominator.has(key)) {
      latestPendingTokenByApplicationAndNominator.set(key, token);
    }
  }

  function tokenSummary(applicationId: string, nominatorMemberId: string | null) {
    if (!nominatorMemberId) {
      return {
        tokenExpiresAt: null,
        tokenLastSentAt: null,
        reminderCount: 0,
        reminderLimit: NOMINATION_AUTOMATIC_REMINDER_LIMIT,
        reminderExhausted: false,
      };
    }

    const token = latestPendingTokenByApplicationAndNominator.get(
      `${applicationId}:${nominatorMemberId}`
    );

    return {
      tokenExpiresAt: token?.expiresAt.toISOString() ?? null,
      tokenLastSentAt: (token?.lastSentAt ?? token?.createdAt)?.toISOString() ?? null,
      reminderCount: token?.reminderCount ?? 0,
      reminderLimit: NOMINATION_AUTOMATIC_REMINDER_LIMIT,
      reminderExhausted:
        (token?.reminderCount ?? 0) >= NOMINATION_AUTOMATIC_REMINDER_LIMIT,
    };
  }

  const data = applications.map((application) => {
    const familyMembers = parseApplicationFamilyMembers(application.familyMembers);
    const nominator1Token = tokenSummary(application.id, application.nominator1Id);
    const nominator2Token = tokenSummary(application.id, application.nominator2Id);
    return {
      id: application.id,
      applicantFirstName: application.applicantFirstName,
      applicantLastName: application.applicantLastName,
      applicantEmail: application.applicantEmail,
      // Date-only (YYYY-MM-DD), not a full ISO datetime: the approval panel
      // feeds this straight into the joining-fee preview endpoint, whose
      // schema is strictly date-only (#1931 item 15).
      //
      // TRUNCATION, NOT THE CLUB-ZONE FORMATTER, AND THE TWO ARE NOT
      // INTERCHANGEABLE (#2872; INV-DATE-019's first exact boundary, with
      // INV-DATE-026 — not INV-DATE-010, which rules that the value is an
      // encoding rather than a moment and is not the citation for a decode;
      // #3080). `applicantDateOfBirth` is
      // `@db.Date`: it holds a CALENDAR DAY, encoded as UTC midnight, and
      // `formatDateOnly` reads back exactly the day that was stored from any
      // zone on earth. `formatDateOnlyForTimeZone` — which this used to call —
      // projects the value into the club's zone first. That happens to agree in
      // New Zealand, which sits AHEAD of UTC, and reads back the PREVIOUS day
      // for any club behind it. A birthday takes no timezone.
      applicantDateOfBirth: application.applicantDateOfBirth
        ? formatDateOnly(application.applicantDateOfBirth)
        : null,
      applicantPhone: application.applicantPhone,
      applicantAddress: parseApplicationAddress(application.applicantAddress),
      familyMembers,
      familyMemberCount: familyMembers.length,
      nominator1Email: application.nominator1Email,
      nominator2Email: application.nominator2Email,
      nominator1Id: application.nominator1Id,
      nominator2Id: application.nominator2Id,
      nominator1Name: application.nominator1Id
        ? memberNameMap.get(application.nominator1Id) ?? null
        : null,
      nominator2Name: application.nominator2Id
        ? memberNameMap.get(application.nominator2Id) ?? null
        : null,
      nominator1ConfirmedAt: application.nominator1ConfirmedAt?.toISOString() ?? null,
      nominator2ConfirmedAt: application.nominator2ConfirmedAt?.toISOString() ?? null,
      nominator1TokenExpiresAt: nominator1Token.tokenExpiresAt,
      nominator2TokenExpiresAt: nominator2Token.tokenExpiresAt,
      nominator1TokenLastSentAt: nominator1Token.tokenLastSentAt,
      nominator2TokenLastSentAt: nominator2Token.tokenLastSentAt,
      nominator1ReminderCount: nominator1Token.reminderCount,
      nominator2ReminderCount: nominator2Token.reminderCount,
      nominatorReminderLimit: NOMINATION_AUTOMATIC_REMINDER_LIMIT,
      nominator1ReminderExhausted: nominator1Token.reminderExhausted,
      nominator2ReminderExhausted: nominator2Token.reminderExhausted,
      status: application.status,
      adminNotes: application.adminNotes,
      reviewedBy: application.reviewedBy,
      reviewerName: application.reviewedBy
        ? memberNameMap.get(application.reviewedBy) ?? null
        : null,
      reviewedAt: application.reviewedAt?.toISOString() ?? null,
      createdAt: application.createdAt.toISOString(),
      updatedAt: application.updatedAt.toISOString(),
    };
  });

  return NextResponse.json({
    data,
    applications: data,
    pendingCount,
    page,
    pageSize,
    total,
  });
}
