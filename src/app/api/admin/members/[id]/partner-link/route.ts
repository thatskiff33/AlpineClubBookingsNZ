import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";
import {
  getPartnerLinkState,
  adminAssignPartnerLink,
  adminRemovePartnerLink,
} from "@/lib/member-partner-link";

/**
 * GET /api/admin/members/[id]/partner-link (#1742)
 * Partner-link state for one member (confirmed link + pending requests) for
 * the admin member-detail card. Permission: membership view (inferred from
 * the /api/admin/members path).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const { id: memberId } = await params;
  const state = await getPartnerLinkState(memberId);
  return NextResponse.json(state);
}

const assignSchema = z.object({
  partnerMemberId: z.string().min(1, "Partner member is required"),
  // #1769a: absent/undefined = notify (default), false = suppress the emails.
  notifyMember: z.boolean().optional(),
});

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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = assignSchema.safeParse(body);
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

  return NextResponse.json(
    { message: result.message, linkId: result.linkId },
    { status: 201 }
  );
}

/**
 * DELETE /api/admin/members/[id]/partner-link?id=LINK_ID (#1742)
 * Remove a partner link (pending or confirmed) involving member [id].
 * Permission: membership edit.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const linkId = req.nextUrl.searchParams.get("id")?.trim();
  if (!linkId) {
    return NextResponse.json({ error: "Partner link id required" }, { status: 400 });
  }

  // #1769a: an optional JSON body carries the admin's notify choice for a
  // CONFIRMED removal. A bodyless DELETE (pending removal) must still succeed,
  // so a missing/invalid-JSON body is treated as an empty object.
  const deleteSchema = z.object({ notifyMember: z.boolean().optional() });
  let rawBody: unknown = {};
  try {
    rawBody = await req.json();
  } catch {
    rawBody = {};
  }
  const parsedBody = deleteSchema.safeParse(rawBody);
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
    // INV-LOCK-005: the removal's transaction is the first write.
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

  return NextResponse.json({ message: result.message });
}
