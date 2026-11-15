import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { MembershipApplicationError } from "@/lib/member-application-fields";
import { type NominatorSlot, replaceMemberApplicationNominator } from "@/lib/nomination";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";

const replaceNominatorSchema = z.object({
  memberId: z.string().min(1),
});

function parseSlot(slot: string): NominatorSlot | null {
  if (slot === "nominator1" || slot === "nominator2") {
    return slot;
  }
  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; slot: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const { id, slot: rawSlot } = await params;
  const slot = parseSlot(rawSlot);

  if (!slot) {
    return NextResponse.json({ error: "Invalid nominator slot" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = replaceNominatorSchema.safeParse(body);
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
    const result = await replaceMemberApplicationNominator({
      applicationId: id,
      slot,
      replacementMemberId: parsed.data.memberId,
      adminMemberId: guard.session.user.id,
    });

    return NextResponse.json({
      success: true,
      replacementNominatorId: result.replacementNominatorId,
      warnings: result.emailWarnings,
    });
  } catch (err) {
    if (err instanceof MembershipApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    logger.error(
      { err, applicationId: id, slot },
      "Unexpected error replacing membership application nominator"
    );
    return NextResponse.json(
      { error: "Could not replace the nominator right now" },
      { status: 500 }
    );
  }
}
