import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  parseApplicationAddress,
  parseApplicationFamilyMembers,
} from "@/lib/nomination";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";

const querySchema = z.object({
  status: z.enum(["PENDING_NOMINATORS", "PENDING_ADMIN", "APPROVED", "REJECTED"]).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

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

  const data = applications.map((application) => {
    const familyMembers = parseApplicationFamilyMembers(application.familyMembers);
    return {
      id: application.id,
      applicantFirstName: application.applicantFirstName,
      applicantLastName: application.applicantLastName,
      applicantEmail: application.applicantEmail,
      applicantDateOfBirth: application.applicantDateOfBirth?.toISOString() ?? null,
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
