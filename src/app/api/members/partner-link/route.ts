import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveSession } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import {
  getPartnerLinkState,
  getPendingPartnerInviteIntent,
  listOneStepPartnerCandidates,
  requestPartnerLink,
  respondToPartnerLink,
  removeOwnPartnerLink,
} from "@/lib/member-partner-link";
import { cancelOwnPartnerInviteToken } from "@/lib/partner-invite-token";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";

/**
 * GET /api/members/partner-link (#1742)
 * The signed-in member's partner-link state: their confirmed link (at most
 * one), pending requests they sent and received, the no-login family members
 * they may declare in one step (those they are the recorded details voucher for
 * and still share a family group with — #2284 (S4) replaced the old
 * family-group-admin gate; computed server-side so the UI renders policy rather
 * than re-implementing it), and any outstanding partner-invite token minted with
 * createPartnerLink.
 */
export async function GET() {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const memberId = guard.session.user.id;

  const [state, oneStepCandidates, pendingPartnerInvite] = await Promise.all([
    getPartnerLinkState(memberId),
    listOneStepPartnerCandidates(memberId),
    getPendingPartnerInviteIntent(memberId),
  ]);
  return NextResponse.json({ ...state, oneStepCandidates, pendingPartnerInvite });
}

const requestSchema = z
  .object({
    email: z.string().email("Invalid email address").optional(),
    memberId: z.string().min(1).optional(),
  })
  .refine((data) => Boolean(data.email) !== Boolean(data.memberId), {
    message: "Provide either an email or a family member",
  });

/**
 * POST /api/members/partner-link (#1742)
 * Declare a partner: by email (any registered login adult — they confirm from
 * their profile, mirroring the family ADULT_INVITE consent flow) or by
 * memberId (own family-group members only; a no-login member requires the
 * requester to be that group's admin and forms the link in one step).
 */
export async function POST(req: NextRequest) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;

  const rateLimited = await applyRateLimit(rateLimiters.familyGroupJoinRequest, req);
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  // A memberId (rather than email) target must share a family group with the
  // requester — the id path exists for family co-members and must not allow
  // probing arbitrary member ids.
  if (parsed.data.memberId) {
    const sharedGroup = await prisma.familyGroupMember.findFirst({
      where: {
        memberId: guard.session.user.id,
        familyGroup: { memberships: { some: { memberId: parsed.data.memberId } } },
      },
      select: { familyGroupId: true },
    });
    if (!sharedGroup) {
      return NextResponse.json(
        { error: "You can only select members of your own family group. Use their email instead." },
        { status: 404 }
      );
    }
  }

  const result = await requestPartnerLink({
    initiatorMemberId: guard.session.user.id,
    targetEmail: parsed.data.email,
    targetMemberId: parsed.data.memberId,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // By-email replies are deliberately sparse (D9): no linkId or link status,
  // and the service returns the same generic message whether or not a request
  // was created, so a target who already has a confirmed partner reads
  // identically to an eligible one. The Partner card refetches state rather
  // than reading this body. Family memberId targets keep the richer body —
  // that path is fenced to the requester's own family group above.
  if (parsed.data.email) {
    return NextResponse.json({ message: result.message }, { status: 201 });
  }

  return NextResponse.json(
    { message: result.message, linkId: result.linkId, status: result.status },
    { status: 201 }
  );
}

const respondSchema = z.object({
  linkId: z.string().min(1),
  action: z.enum(["accept", "decline"]),
});

/**
 * PUT /api/members/partner-link (#1742)
 * Confirm or decline a pending partner request addressed to the signed-in
 * member.
 */
export async function PUT(req: NextRequest) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = respondSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const result = await respondToPartnerLink({
    memberId: guard.session.user.id,
    linkId: parsed.data.linkId,
    action: parsed.data.action,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ message: result.message, status: result.status });
}

/**
 * DELETE /api/members/partner-link?id=LINK_ID (#1742)
 * DELETE /api/members/partner-link?inviteTokenId=TOKEN_ID (#1754)
 * Withdraw the member's own pending request, or dissolve their confirmed
 * partnership (either partner may; the other is notified). With
 * inviteTokenId instead, cancel the member's own outstanding declared-partner
 * invitation (a createPartnerLink token they minted that nobody has claimed).
 */
export async function DELETE(req: NextRequest) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;

  const linkId = req.nextUrl.searchParams.get("id")?.trim();
  const inviteTokenId = req.nextUrl.searchParams.get("inviteTokenId")?.trim();
  if (linkId && inviteTokenId) {
    return NextResponse.json(
      { error: "Provide either a partner link id or an invite token id, not both" },
      { status: 400 }
    );
  }

  if (inviteTokenId) {
    const cancelled = await cancelOwnPartnerInviteToken({
      tokenId: inviteTokenId,
      memberId: guard.session.user.id,
    });
    if (!cancelled) {
      return NextResponse.json(
        { error: "Partner invitation not found or already claimed." },
        { status: 404 }
      );
    }
    return NextResponse.json({ message: "Partner invitation cancelled." });
  }

  if (!linkId) {
    return NextResponse.json({ error: "Partner link id required" }, { status: 400 });
  }

  let result: Awaited<ReturnType<typeof removeOwnPartnerLink>>;
  try {
    result = await removeOwnPartnerLink({
      memberId: guard.session.user.id,
      linkId,
    });
  } catch (err) {
    // The removal and its share sweep are one lock(1) transaction (INV-LOCK-006).
    const contended = transactionContendedResponse(
      err,
      "Partner link removal contended for the lock(1) budget",
      { context: { linkId } },
    );
    if (contended) return contended;
    throw err;
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ message: result.message });
}
