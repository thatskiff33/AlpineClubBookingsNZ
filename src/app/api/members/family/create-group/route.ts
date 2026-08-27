import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { parseDateOnly } from "@/lib/date-only";
import { clubTimeZone, clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { clubSeasonYear } from "@/lib/financial-year";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import {
  sendAdminFamilyGroupRequestAlert,
  sendGroupCreateRequestConfirmationEmail,
  sendPartnerInviteEmail,
} from "@/lib/email";
import {
  buildPartnerInviteTokenData,
  getPartnerInviteTokenExpiryDate,
} from "@/lib/partner-invite-token-policy";
import { requestPartnerLink } from "@/lib/member-partner-link";
import { nameField } from "@/lib/zod-helpers";

const createGroupSchema = z.object({
  groupName: z
    .string()
    .min(1, "Group name cannot be empty")
    .max(100, "Group name must be 100 characters or fewer")
    .optional(),
  partnerEmail: z.string().email("Invalid email address").optional(),
  // #1742: the named partner is the requester's Partner/Husband/Wife. For an
  // unregistered partner this marks the minted invite token so claiming it
  // also forms the CONFIRMED MemberPartnerLink; a registered partner instead
  // receives a PENDING partner-link request to confirm from their profile.
  declarePartnerLink: z.boolean().default(false),
  children: z
    .array(
      z.object({
        firstName: nameField({ required: "First name required" }),
        lastName: nameField({ required: "Last name required" }),
        dateOfBirth: z
          .string({ error: "Date of birth is required" })
          .min(1, "Date of birth is required")
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be YYYY-MM-DD format"),
      })
    )
    .max(6, "A group creation request can include at most 6 infant/child/youth members")
    .default([]),
});

/**
 * POST /api/members/family/create-group (#1681, #1682)
 * A group-less adult member requests a brand-new family group: optional group
 * name, optional partner by email, optional infant/child/youth members. The
 * whole bundle goes to the admin queue: a memberless FamilyGroup row plus a
 * PENDING GROUP_CREATE request (and one standard CHILD_REQUEST per child) are
 * created up front; the requester's ADMIN membership and a registered partner's
 * ADULT_INVITE are only created when an admin approves the GROUP_CREATE request.
 * A partner email that matches no registered member is instead minted a
 * single-use PartnerInviteToken and emailed a claim link (#1682); the response
 * is identical to the registered-partner path so it cannot probe membership.
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createGroupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const children = parsed.data.children ?? [];

  // Fetch requester — must be an active adult with a login account.
  const requester = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      active: true,
      canLogin: true,
      ageTier: true,
      familyGroupMemberships: { select: { familyGroupId: true }, take: 1 },
    },
  });

  if (!requester || !requester.active) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  if (!requester.canLogin) {
    return NextResponse.json(
      { error: "Only members with login accounts can create a family group" },
      { status: 403 }
    );
  }

  if (requester.ageTier !== "ADULT") {
    return NextResponse.json(
      { error: "Only adults can create a family group" },
      { status: 403 }
    );
  }

  if (requester.familyGroupMemberships.length > 0) {
    return NextResponse.json(
      {
        error:
          "You are already in a family group. Use the invite and request options on your existing group instead.",
      },
      { status: 422 }
    );
  }

  // One pending GROUP_CREATE per requester, and no simultaneous pending
  // JOIN_REQUEST — a member cannot both join and create a group at once.
  const conflictingRequest = await prisma.familyGroupJoinRequest.findFirst({
    where: {
      requesterId: session.user.id,
      status: "PENDING",
      type: { in: ["GROUP_CREATE", "JOIN_REQUEST"] },
    },
    select: { id: true, type: true },
  });

  if (conflictingRequest?.type === "GROUP_CREATE") {
    return NextResponse.json(
      {
        error:
          "You already have a pending family group creation request. Please wait for it to be reviewed.",
      },
      { status: 422 }
    );
  }
  if (conflictingRequest) {
    return NextResponse.json(
      {
        error:
          "You already have a pending join request. Please wait for it to be reviewed before creating a new family group.",
      },
      { status: 422 }
    );
  }

  // Resolve the optional partner. A registered active login adult is carried on
  // the GROUP_CREATE request as invitedMemberId (auto-filed as an ADULT_INVITE
  // on approval). An email that matches NO member row at all is invited with a
  // single-use partner-invite token instead (#1682). Every other case — an
  // active login adult (invite), a registered non-invitable member (minor,
  // non-login, inactive, or dependent), and an unknown email (token) — returns
  // the SAME 201 body and mints no token/email difference an outsider can see,
  // so this route does not reveal a third party's membership status. (Naming
  // your own email still returns 422, but that only reveals your own account to
  // yourself.) A named-but-ineligible partner is handled by the admin at review.
  let partner: { id: string; firstName: string; lastName: string } | null = null;
  let unregisteredPartnerEmail: string | null = null;
  // Member row exists but is not an invitable adult: record the email for the
  // admin, mint no token, send no email.
  let ineligiblePartnerEmail: string | null = null;
  const normalizedPartnerEmail = parsed.data.partnerEmail?.toLowerCase().trim() || null;
  if (normalizedPartnerEmail) {
    const target = await prisma.member.findFirst({
      where: {
        email: normalizedPartnerEmail,
        canLogin: true,
        active: true,
      },
      select: { id: true, firstName: true, lastName: true, ageTier: true },
    });

    if (target) {
      if (target.id === session.user.id) {
        return NextResponse.json({ error: "You cannot invite yourself" }, { status: 422 });
      } else if (target.ageTier !== "ADULT") {
        // Active login member but not an adult: uniform success, no invite.
        ineligiblePartnerEmail = normalizedPartnerEmail;
      } else {
        partner = { id: target.id, firstName: target.firstName, lastName: target.lastName };
      }
    } else {
      // No active login member. Distinguish an email that already belongs to
      // some member row (inactive, non-login, or a dependent) from a genuinely
      // unknown email: minting a token for a non-login member's address is a
      // dead end (they can never claim), and a differential 422/404 there would
      // let the requester probe minor/deactivated members. So an existing row
      // is treated exactly like an ineligible partner (uniform 201, no token),
      // and only a truly unknown email mints an invite token.
      const anyMemberRow = await prisma.member.findFirst({
        where: { email: normalizedPartnerEmail },
        select: { id: true },
      });
      if (anyMemberRow) {
        ineligiblePartnerEmail = normalizedPartnerEmail;
      } else {
        unregisteredPartnerEmail = normalizedPartnerEmail;
      }
    }
  }

  // Per-child DOB sanity, mirroring request-child.
  const seasonStart = getSeasonStartDate(clubSeasonYear(await clubTimeZone()));
  // CT-4 (#2870): "in the future" means a later CLUB calendar day, taken from
  // the persisted ClubTimeSettings zone and not the container's TZ
  // (INV-CONFIG-002, INV-DATE-019). The date of birth takes no zone at all
  // (INV-DATE-010), and both sides stay UTC-midnight date-only values.
  const today = await clubTodayDateOnlyInstant();
  const parsedChildren: Array<{ firstName: string; lastName: string; dateOfBirth: Date }> = [];
  for (const child of children) {
    const childDob = parseDateOnly(child.dateOfBirth);
    if (Number.isNaN(childDob.getTime())) {
      return NextResponse.json(
        { error: "Date of birth must be a real calendar date" },
        { status: 422 }
      );
    }
    if (childDob > today) {
      return NextResponse.json(
        { error: "Date of birth cannot be in the future" },
        { status: 422 }
      );
    }
    const childAgeTier = await computeAgeTier(childDob, seasonStart);
    if (childAgeTier === "ADULT") {
      return NextResponse.json(
        { error: "Use the same-email adult request flow for adult members" },
        { status: 422 }
      );
    }
    parsedChildren.push({
      firstName: child.firstName.trim(),
      lastName: child.lastName.trim(),
      dateOfBirth: childDob,
    });
  }

  // Reject duplicate child rows within the submission (case-insensitive
  // name + DOB, mirroring request-child's duplicate-pending check).
  const seenChildKeys = new Set<string>();
  for (const child of parsedChildren) {
    const childKey = [
      child.firstName.toLowerCase(),
      child.lastName.toLowerCase(),
      child.dateOfBirth.toISOString(),
    ].join("|");
    if (seenChildKeys.has(childKey)) {
      return NextResponse.json(
        {
          error: `A request for ${child.firstName} ${child.lastName} is already included in this submission. Remove the duplicate row.`,
        },
        { status: 422 }
      );
    }
    seenChildKeys.add(childKey);
  }

  const groupName = parsed.data.groupName?.trim() || `${requester.lastName} Family`;

  // One transaction: memberless FamilyGroup + GROUP_CREATE + N CHILD_REQUESTs.
  // The group has zero FamilyGroupMember rows until admin approval, which keeps
  // it invisible everywhere (memberships drive all eligibility and UI).
  // Explicit createdAt values keep the GROUP_CREATE row above its bundled
  // child requests in the admin queue's `createdAt asc` ordering — rows
  // created inside one transaction can otherwise share an identical timestamp.
  const submittedAt = new Date();
  const { group, createRequest, childRequests, partnerInviteRawToken } =
    await prisma.$transaction(async (tx) => {
      const group = await tx.familyGroup.create({
        data: { name: groupName },
      });

      const createRequest = await tx.familyGroupJoinRequest.create({
        data: {
          familyGroupId: group.id,
          requesterId: session.user.id,
          type: "GROUP_CREATE",
          invitedMemberId: partner?.id ?? null,
          // Surface a named-but-ineligible partner to the reviewing admin
          // (no invite was sent) without repurposing the ADULT_REQUEST fields.
          // When they were also declared as the requester's partner (#1742),
          // say so — no partner link can be formed automatically for them, so
          // the admin is the only one who can record it (member detail page).
          requestNotes: ineligiblePartnerEmail
            ? `Partner ${ineligiblePartnerEmail} was named but is an existing member who cannot be invited by email (not an active adult login). Review and add manually if appropriate.${
                parsed.data.declarePartnerLink
                  ? " They were also declared as the requester's partner (husband/wife/partner); if appropriate, record the partner relationship from the member's admin page."
                  : ""
              }`
            : null,
          createdAt: submittedAt,
        },
      });

      const childRequests: Array<{ id: string }> = [];
      for (const [index, child] of parsedChildren.entries()) {
        childRequests.push(
          await tx.familyGroupJoinRequest.create({
            data: {
              familyGroupId: group.id,
              requesterId: session.user.id,
              type: "CHILD_REQUEST",
              childFirstName: child.firstName,
              childLastName: child.lastName,
              childDateOfBirth: child.dateOfBirth,
              createdAt: new Date(submittedAt.getTime() + index + 1),
            },
          })
        );
      }

      // Unregistered partner: mint the single-use invite token atomically with
      // the group so the invite is durable. The raw token is emailed once below.
      let partnerInviteRawToken: string | null = null;
      if (unregisteredPartnerEmail) {
        const { token, data } = buildPartnerInviteTokenData({
          familyGroupId: group.id,
          invitedEmail: unregisteredPartnerEmail,
          createdById: session.user.id,
          now: submittedAt,
          createPartnerLink: parsed.data.declarePartnerLink,
        });
        await tx.partnerInviteToken.create({ data });
        partnerInviteRawToken = token;
      }

      return { group, createRequest, childRequests, partnerInviteRawToken };
    });

  const childRequestIds = childRequests.map((request) => request.id);

  // #1742: a REGISTERED partner marked as the requester's declared partner
  // gets a normal PENDING partner-link request to confirm from their profile
  // (the family ADULT_INVITE still waits for admin approval of the group).
  // Failures — a business conflict such as an existing confirmed partner, or
  // an unexpected throw — must not fail the already-committed group request:
  // the outcome is logged and the response stays uniform, so this cannot be
  // used to probe another member's partner state. The target is passed by
  // email so the service applies its own active-login-adult lookup; the raw
  // memberId path is reserved for the family-co-member route guard.
  let partnerLinkRequested = false;
  if (parsed.data.declarePartnerLink && partner && normalizedPartnerEmail) {
    try {
      const partnerLinkResult = await requestPartnerLink({
        initiatorMemberId: session.user.id,
        targetEmail: normalizedPartnerEmail,
      });
      // A D9-suppressed outcome (target already partnered) reads as success
      // but created nothing — the audit flag records what actually happened.
      partnerLinkRequested = partnerLinkResult.ok && !partnerLinkResult.suppressed;
      if (!partnerLinkResult.ok) {
        logger.warn(
          { requesterId: session.user.id, partnerMemberId: partner.id, error: partnerLinkResult.error },
          "Partner link request skipped during family group creation"
        );
      }
    } catch (err) {
      logger.error(
        { err, requesterId: session.user.id, partnerMemberId: partner.id },
        "Partner link request failed during family group creation"
      );
    }
  }

  logAudit({
    action: "FAMILY_GROUP_CREATE_REQUESTED",
    memberId: session.user.id,
    targetId: group.id,
    subjectMemberId: session.user.id,
    entityType: "FamilyGroupJoinRequest",
    entityId: createRequest.id,
    category: "family",
    outcome: "success",
    summary: "Family group creation requested",
    details: JSON.stringify({
      familyGroupId: group.id,
      groupName,
      partnerMemberId: partner?.id ?? null,
      partnerInviteEmail: unregisteredPartnerEmail,
      ineligiblePartnerEmail,
      declarePartnerLink: parsed.data.declarePartnerLink,
      partnerLinkRequested,
      childCount: parsedChildren.length,
      childRequestIds,
    }),
    metadata: {
      familyGroupId: group.id,
      groupName,
      partnerMemberId: partner?.id ?? null,
      partnerInviteEmail: unregisteredPartnerEmail,
      ineligiblePartnerEmail,
      declarePartnerLink: parsed.data.declarePartnerLink,
      partnerLinkRequested,
      childCount: parsedChildren.length,
      childRequestIds,
    },
  });

  logger.info(
    {
      requestId: createRequest.id,
      requesterId: session.user.id,
      familyGroupId: group.id,
      partnerMemberId: partner?.id ?? null,
      childCount: parsedChildren.length,
    },
    "Family group creation request submitted"
  );

  // Requester confirmation (fire-and-forget).
  sendGroupCreateRequestConfirmationEmail(
    requester.email,
    `${requester.firstName} ${requester.lastName}`,
    groupName
  ).catch((err) => {
    logger.error(
      { err, requestId: createRequest.id },
      "Failed to send group create request confirmation email"
    );
  });

  // Unregistered partner invite (fire-and-forget). The claim link routes them
  // through the membership process and then into this (approved) group.
  if (partnerInviteRawToken && unregisteredPartnerEmail) {
    sendPartnerInviteEmail({
      email: unregisteredPartnerEmail,
      inviterName: `${requester.firstName} ${requester.lastName}`,
      groupName,
      token: partnerInviteRawToken,
      expiresAt: getPartnerInviteTokenExpiryDate(submittedAt),
    }).catch((err) => {
      logger.error(
        { err, requestId: createRequest.id },
        "Failed to send partner invite email"
      );
    });
  }

  // Admin alert (fire-and-forget).
  const detailParts = [`Wants to create the family group "${groupName}"`];
  if (partner) {
    detailParts.push(`inviting ${partner.firstName} ${partner.lastName} on approval`);
  }
  if (unregisteredPartnerEmail) {
    detailParts.push(`inviting ${unregisteredPartnerEmail} (not yet a member) by email`);
  }
  if (ineligiblePartnerEmail) {
    detailParts.push(`named ${ineligiblePartnerEmail} (existing member, cannot be invited — review manually)`);
  }
  if (parsedChildren.length > 0) {
    detailParts.push(
      `with ${parsedChildren.length} bundled infant/child/youth request${parsedChildren.length === 1 ? "" : "s"}`
    );
  }
  sendAdminFamilyGroupRequestAlert({
    requestType: "Group Create Request",
    requesterName: `${requester.firstName} ${requester.lastName}`,
    groupName,
    details: detailParts.join(", "),
  }).catch((err) => {
    logger.error(
      { err, requestId: createRequest.id },
      "Failed to send admin family group request alert"
    );
  });

  return NextResponse.json(
    {
      message: "Request submitted. An admin will review your new family group.",
      requestId: createRequest.id,
      familyGroupId: group.id,
      childRequestIds,
    },
    { status: 201 }
  );
}
