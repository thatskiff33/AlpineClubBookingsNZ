import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody, parseOptionalJsonRequestBody } from "@/lib/api-json";
import { requireAdmin } from "@/lib/session-guards";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";
import {
  getPartnerLinkState,
  adminAssignPartnerLink,
  adminRemovePartnerLink,
} from "@/lib/member-partner-link";
import {
  assignPartnerLinkSchema,
  removePartnerLinkBodySchema,
  removePartnerLinkQuerySchema,
} from "@/lib/admin-membership-api/members";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  MEMBER_PARTNER_LINK_CONNECTION_SHAPE,
  PARTNER_LINK_ASSIGNED_CONNECTION_SHAPE,
  PARTNER_LINK_REMOVED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/membership-members";

/**
 * GET /api/admin/members/[id]/partner-link (#1742)
 * Partner-link state for one member (confirmed link + pending requests) for
 * the admin member-detail card. Permission: membership view (inferred from
 * the /api/admin/members path).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const { id: memberId } = await params;
  const state = await getPartnerLinkState(memberId);
  return connectionJson(req, state, MEMBER_PARTNER_LINK_CONNECTION_SHAPE);
}

/**
 * POST /api/admin/members/[id]/partner-link (#1742)
 * Directly assign a CONFIRMED partner link between member [id] and
 * partnerMemberId (no consent round-trip; the assigning admin is recorded).
 * Permission: membership edit.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = assignPartnerLinkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { id: memberId } = await params;
  const result = await adminAssignPartnerLink({
    adminMemberId: guard.session.user.id,
    memberOneId: memberId,
    memberTwoId: parsed.data.partnerMemberId,
    notifyMember: parsed.data.notifyMember,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return connectionJson(
    req,
    { message: result.message, linkId: result.linkId },
    PARTNER_LINK_ASSIGNED_CONNECTION_SHAPE,
    { status: 201 }
  );
}

/**
 * DELETE /api/admin/members/[id]/partner-link?id=LINK_ID (#1742)
 * Remove a partner link (pending or confirmed) involving member [id].
 * Permission: membership edit. `?linkId=` is read too (ALP-720): an AI app
 * action cannot send `?id=`, which would collide with the member's `id`.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const searchParams = req.nextUrl.searchParams;
  const query = removePartnerLinkQuerySchema.safeParse({
    linkId: searchParams.get("linkId") ?? searchParams.get("id") ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json({ error: "Partner link id required" }, { status: 400 });
  }
  const { linkId } = query.data;

  // #1769a: an optional JSON body carries the admin's notify choice for a
  // CONFIRMED removal. A bodyless DELETE (pending removal) must still succeed,
  // so an empty body is treated as an empty object; a malformed one is a 400.
  const jsonBody = await parseOptionalJsonRequestBody(req, { whenAbsent: {} });
  if (!jsonBody.ok) return jsonBody.response;
  const parsedBody = removePartnerLinkBodySchema.safeParse(jsonBody.body);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsedBody.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  // memberScopeId restricts the delete to links involving this member so the
  // URL shape (member-scoped resource) cannot be bypassed with a foreign
  // link id.
  const { id: memberId } = await params;
  let result: Awaited<ReturnType<typeof adminRemovePartnerLink>>;
  try {
    result = await adminRemovePartnerLink({
      adminMemberId: guard.session.user.id,
      linkId,
      memberScopeId: memberId,
      notifyMember: parsedBody.data.notifyMember,
    });
  } catch (err) {
    // INV-LOCK-006: the removal's transaction is the first write.
    const contended = transactionContendedResponse(
      err,
      "Admin partner link removal contended for the lock(1) budget",
      { context: { memberId, linkId } },
    );
    if (contended) return contended;
    throw err;
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return connectionJson(req, { message: result.message }, PARTNER_LINK_REMOVED_CONNECTION_SHAPE);
}
