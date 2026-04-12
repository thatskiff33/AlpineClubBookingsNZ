import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  approveMemberApplication,
  MembershipApplicationError,
  rejectMemberApplication,
} from "@/lib/nomination";
import { requireActiveSessionUser } from "@/lib/session-guards";
import logger from "@/lib/logger";

const reviewSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  adminNotes: z.string().max(4000).optional().nullable(),
});

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 422 }
    );
  }

  try {
    if (parsed.data.decision === "APPROVE") {
      const result = await approveMemberApplication(
        id,
        session.user.id,
        parsed.data.adminNotes
      );

      return NextResponse.json({
        success: true,
        status: result.application.status,
        applicantMemberId: result.applicantMember.id,
        warnings: result.warnings,
      });
    }

    const result = await rejectMemberApplication(
      id,
      session.user.id,
      parsed.data.adminNotes
    );

    return NextResponse.json({
      success: true,
      status: result.status,
    });
  } catch (err) {
    if (err instanceof MembershipApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    logger.error({ err, applicationId: id }, "Unexpected error reviewing membership application");
    return NextResponse.json(
      { error: "Could not review the membership application right now" },
      { status: 500 }
    );
  }
}
