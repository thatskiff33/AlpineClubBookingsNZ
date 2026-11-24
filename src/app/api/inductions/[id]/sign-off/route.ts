import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  addSignOff,
  canSignOff,
  getInductionById,
  inductionSignerContext,
  InductionError,
} from "@/lib/induction";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireActiveSession } from "@/lib/session-guards";

const signOffSchema = z.object({
  declarationAccepted: z
    .boolean()
    .refine((value) => value === true, {
      message: "You must accept the declaration",
    }),
  comments: z.string().max(2000).optional().nullable(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = signOffSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const memberId = guard.session.user.id;
  const ctx = await inductionSignerContext(req, guard.session.user);

  const induction = await getInductionById(id);
  if (!induction) {
    return NextResponse.json({ error: "Induction not found" }, { status: 404 });
  }

  const eligibility = canSignOff(induction, ctx);
  if (!eligibility.allowed || !eligibility.role) {
    return NextResponse.json(
      { error: eligibility.reason ?? "You are not authorised to sign off this induction" },
      { status: 403 }
    );
  }

  const signer = await prisma.member.findUnique({
    where: { id: memberId },
    select: { firstName: true, lastName: true },
  });
  const signerName = signer
    ? `${signer.firstName} ${signer.lastName}`.trim()
    : guard.session.user.email ?? "Member";

  try {
    const result = await addSignOff({
      inductionId: id,
      signerMemberId: memberId,
      signerName,
      signerRole: eligibility.role,
      declarationAccepted: parsed.data.declarationAccepted,
      comments: parsed.data.comments ?? null,
    });

    return NextResponse.json({
      ok: true,
      completed: result.completed,
      signOffCount: result.signOffCount,
    });
  } catch (err) {
    if (err instanceof InductionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error({ err, inductionId: id }, "Failed to record induction sign-off");
    return NextResponse.json(
      { error: "Failed to record sign-off" },
      { status: 500 }
    );
  }
}
