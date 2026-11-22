import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  getInductionById,
  InductionError,
  overrideCompleteInduction,
  reassignInductionSigners,
  voidInduction,
} from "@/lib/induction";
import { INDUCTION_SIGN_OFF_DECLARATION } from "@/lib/induction-checklist-template";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";

const patchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("OVERRIDE_COMPLETE"),
    comments: z.string().trim().max(2000).optional().nullable(),
  }),
  z.object({
    action: z.literal("VOID"),
    reason: z.string().trim().min(3).max(2000),
  }),
  z.object({
    action: z.literal("REASSIGN_SIGNERS"),
    signerMemberIds: z.array(z.string().min(1)).max(10),
  }),
]);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const induction = await getInductionById(id);
  if (!induction) {
    return NextResponse.json({ error: "Induction not found" }, { status: 404 });
  }

  return NextResponse.json({
    induction,
    declaration: INDUCTION_SIGN_OFF_DECLARATION,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    if (parsed.data.action === "OVERRIDE_COMPLETE") {
      await overrideCompleteInduction({
        inductionId: id,
        adminMemberId: guard.session.user.id,
        comments: parsed.data.comments ?? null,
      });
    } else if (parsed.data.action === "VOID") {
      await voidInduction({
        inductionId: id,
        adminMemberId: guard.session.user.id,
        reason: parsed.data.reason,
      });
    } else {
      await reassignInductionSigners({
        inductionId: id,
        adminMemberId: guard.session.user.id,
        signerMemberIds: parsed.data.signerMemberIds,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof InductionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error({ err, inductionId: id }, "Failed to update induction");
    return NextResponse.json(
      { error: "Failed to update induction" },
      { status: 500 }
    );
  }
}
