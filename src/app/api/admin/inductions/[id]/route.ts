import { NextRequest, NextResponse } from "next/server";
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
import { inductionPatchSchema } from "@/lib/admin-membership-api/inductions";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  INDUCTION_DETAIL_CONNECTION_SHAPE,
  INDUCTION_UPDATED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/membership-committee";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const induction = await getInductionById(id);
  if (!induction) {
    return NextResponse.json({ error: "Induction not found" }, { status: 404 });
  }

  return connectionJson(
    req,
    { induction, declaration: INDUCTION_SIGN_OFF_DECLARATION },
    INDUCTION_DETAIL_CONNECTION_SHAPE,
  );
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

  const parsed = inductionPatchSchema.safeParse(body);
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
    return connectionJson(req, { ok: true }, INDUCTION_UPDATED_CONNECTION_SHAPE);
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
