import { NextRequest, NextResponse } from "next/server";
import {
  replaceNominatorParamsSchema,
  replaceNominatorSchema,
} from "@/lib/admin-membership-api/requests";
import { parseJsonRequestBody } from "@/lib/api-json";
import { NOMINATOR_REPLACED_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-requests";
import { connectionJson } from "@/lib/mcp-connection-request";
import { MembershipApplicationError } from "@/lib/member-application-fields";
import { replaceMemberApplicationNominator } from "@/lib/nomination";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; slot: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const parsedParams = replaceNominatorParamsSchema.safeParse(await params);

  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid nominator slot" }, { status: 400 });
  }
  const { id, slot } = parsedParams.data;

  const jsonBody = await parseJsonRequestBody(req, {
    error: "Invalid JSON payload",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

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

    return connectionJson(
      req,
      {
        success: true,
        replacementNominatorId: result.replacementNominatorId,
        warnings: result.emailWarnings,
      },
      NOMINATOR_REPLACED_CONNECTION_SHAPE
    );
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
