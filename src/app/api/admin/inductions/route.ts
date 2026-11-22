import { parseJsonRequestBody } from "@/lib/api-json";
import { exactContains } from "@/lib/prisma-exact-prefix";
import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import {
  createMemberInduction,
  InductionError,
} from "@/lib/induction";
import { INDUCTION_SIGNER_ROLE_LABELS } from "@/lib/induction-display";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { sendInductionSignOffRequestEmail } from "@/lib/email";
import { z } from "zod";

const INDUCTION_STATUSES = ["DRAFT", "IN_PROGRESS", "COMPLETED", "VOIDED"] as const;
const INDUCTION_KINDS = [
  "NEW_MEMBER",
  "HUT_LEADER",
  "YOUTH_TO_FULL",
  "RE_INDUCTION",
] as const;

const createSchema = z.object({
  memberId: z.string().min(1),
  kind: z.enum(INDUCTION_KINDS).optional(),
  signerMemberIds: z.array(z.string().min(1)).max(10).optional(),
});

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get("status");
  const kindParam = searchParams.get("kind");
  const search = searchParams.get("search")?.trim();

  const where: Prisma.MemberInductionWhereInput = {};
  if (statusParam && (INDUCTION_STATUSES as readonly string[]).includes(statusParam)) {
    where.status = statusParam as (typeof INDUCTION_STATUSES)[number];
  }
  if (kindParam && (INDUCTION_KINDS as readonly string[]).includes(kindParam)) {
    where.kind = kindParam as (typeof INDUCTION_KINDS)[number];
  }
  if (search) {
    where.member = {
      OR: [
        { firstName: exactContains(search, "insensitive") },
        { lastName: exactContains(search, "insensitive") },
        { email: exactContains(search, "insensitive") },
      ],
    };
  }

  const inductions = await prisma.memberInduction.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 500,
    include: {
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          ageTier: true,
        },
      },
      _count: { select: { signOffs: true } },
      assignedSigners: {
        include: {
          member: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      },
    },
  });

  return NextResponse.json({
    inductions: inductions.map((induction) => ({
      id: induction.id,
      kind: induction.kind,
      status: induction.status,
      requiredSignOffs: induction.requiredSignOffs,
      signOffCount: induction._count.signOffs,
      completedAt: induction.completedAt,
      completionSource: induction.completionSource,
      createdAt: induction.createdAt,
      member: induction.member,
      assignedSigners: induction.assignedSigners.map((signer) => ({
        memberId: signer.memberId,
        firstName: signer.member.firstName,
        lastName: signer.member.lastName,
        email: signer.member.email,
        emailSentAt: signer.emailSentAt,
      })),
    })),
  });
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const member = await prisma.member.findUnique({
    where: { id: parsed.data.memberId },
    select: { id: true },
  });
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const inducteeMember = await prisma.member.findUnique({
    where: { id: parsed.data.memberId },
    select: { firstName: true, lastName: true },
  });
  const assignedSignerIds = Array.from(
    new Set(
      (parsed.data.signerMemberIds ?? []).filter(
        (memberId) => memberId !== parsed.data.memberId
      )
    )
  );

  try {
    const induction = await createMemberInduction({
      memberId: parsed.data.memberId,
      kind: parsed.data.kind ?? "RE_INDUCTION",
      createdByMemberId: guard.session.user.id,
      signerMemberIds: assignedSignerIds,
    });

    // Send sign-off request emails to assigned signers
    if (assignedSignerIds.length && inducteeMember) {
      const inducteeName = `${inducteeMember.firstName} ${inducteeMember.lastName}`.trim();
      const signers = await prisma.member.findMany({
        where: { id: { in: assignedSignerIds } },
        select: { id: true, firstName: true, lastName: true, email: true },
      });
      await Promise.allSettled(
        signers.map(async (signer) => {
          if (!signer.email) return;
          await sendInductionSignOffRequestEmail({
            email: signer.email,
            signerName: `${signer.firstName} ${signer.lastName}`.trim(),
            inducteeName,
            signerRoleLabel: INDUCTION_SIGNER_ROLE_LABELS.NOMINATOR,
          });
          await prisma.memberInductionAssignedSigner.updateMany({
            where: { inductionId: induction.id, memberId: signer.id },
            data: { emailSentAt: new Date() },
          });
        })
      );
    }

    return NextResponse.json({ induction }, { status: 201 });
  } catch (err) {
    if (err instanceof InductionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error({ err }, "Failed to create induction from admin");
    return NextResponse.json(
      { error: "Failed to create induction" },
      { status: 500 }
    );
  }
}
