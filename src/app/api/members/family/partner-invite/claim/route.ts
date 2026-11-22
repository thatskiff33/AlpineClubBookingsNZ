import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { claimPartnerInviteToken } from "@/lib/partner-invite-token";
import { parseJsonRequestBody } from "@/lib/api-json";

const claimSchema = z.object({
  token: z.string().min(1, "Invitation token required"),
});

/**
 * POST /api/members/family/partner-invite/claim (#1682)
 * A now-registered partner claims their single-use invite token to be filed and
 * accepted as an ADULT_INVITE into the family group. The signed-in member's
 * email must match the invited address.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const rateLimited = await applyRateLimit(rateLimiters.familyGroupJoinRequest, req);
  if (rateLimited) return rateLimited;

  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = claimSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const result = await claimPartnerInviteToken({
    rawToken: parsed.data.token,
    memberId: session.user.id,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    message: result.partnerLinkFormed
      ? `You have joined ${result.groupName ?? "the family group"}, and your partner relationship has been recorded.`
      : `You have joined ${result.groupName ?? "the family group"}.`,
    familyGroupId: result.familyGroupId,
    alreadyMember: result.alreadyMember,
    partnerLinkFormed: result.partnerLinkFormed,
  });
}
