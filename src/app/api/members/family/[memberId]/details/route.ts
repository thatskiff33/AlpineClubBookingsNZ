import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { clubTimeZone } from "@/lib/club-time/server";
import { clubSeasonYear } from "@/lib/financial-year";
import { parseDateOnly } from "@/lib/date-only";
import { dateOnlyInstantOf } from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { logAudit } from "@/lib/audit";
import {
  isXeroConnected,
  syncManagedXeroContactGroupForMember,
  updateXeroContact,
} from "@/lib/xero";
import {
  buildXeroContactUpdatePayload,
  hasMemberXeroContactChanges,
  shouldRepairXeroContactNameOrder,
} from "@/lib/xero-contact-sync";
import {
  evaluateMemberProfileCompleteness,
  evaluateSelfServiceProfilePayload,
  getMissingMemberProfileFieldDetails,
} from "@/lib/member-profile-completeness";
import logger from "@/lib/logger";
import { nameField } from "@/lib/zod-helpers";
import {
  isOrganisationMember,
  resolveAccessRoleTokens,
} from "@/lib/access-roles";
import {
  loadMemberCurrentSeasonTypeExemption,
  resolveEnforcedAgeTier,
} from "@/lib/age-tier-enforcement";
import { reconcileEmailInheritanceForMemberChange } from "@/lib/member-email-inheritance";

const delegatedDetailsSchema = z.object({
  firstName: nameField({ required: "First name required" }),
  lastName: nameField({ required: "Last name required" }),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be YYYY-MM-DD format"),
  inheritContactFromSelf: z.literal(true),
});

const DELEGATED_MEMBER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  active: true,
  canLogin: true,
  role: true,
  accessRoles: { select: { role: true } },
  ageTier: true,
  xeroContactId: true,
  phoneCountryCode: true,
  phoneAreaCode: true,
  phoneNumber: true,
  dateOfBirth: true,
  streetAddressLine1: true,
  streetAddressLine2: true,
  streetCity: true,
  streetRegion: true,
  streetPostalCode: true,
  streetCountry: true,
  postalAddressLine1: true,
  postalAddressLine2: true,
  postalCity: true,
  postalRegion: true,
  postalPostalCode: true,
  postalCountry: true,
  profileCompletedAt: true,
  detailsConfirmedAt: true,
  detailsConfirmedByMemberId: true,
  onboardingConfirmedAt: true,
  familyGroupMemberships: {
    select: { familyGroupId: true },
  },
} as const;

function trimOrNull(value: string | null | undefined) {
  return value?.trim() || null;
}

function getSharedFamilyGroupIds(
  requesterGroups: Array<{ familyGroupId: string }>,
  targetGroups: Array<{ familyGroupId: string }>,
) {
  const targetGroupIds = new Set(
    targetGroups.map((group) => group.familyGroupId),
  );
  return requesterGroups
    .map((group) => group.familyGroupId)
    .filter((groupId) => targetGroupIds.has(groupId));
}

function serializeStatus(
  member: Parameters<typeof evaluateMemberProfileCompleteness>[0],
) {
  const status = evaluateMemberProfileCompleteness(member);
  return {
    ...status,
    missingFieldDetails: getMissingMemberProfileFieldDetails(
      status.missingFields,
    ),
  };
}

/**
 * PUT /api/members/family/[memberId]/details
 * Complete and confirm details for a non-login member in a shared family group.
 *
 * AUTHORIZATION (#2284): this is NOT admin- or group-lead-gated. Any ACTIVE,
 * ADULT, login-holding member with a complete profile who shares a family group
 * with the (non-login) target may confirm here — the equal "all adults in a
 * family group" boundary, not a designated responsible adult. The write stamps
 * `detailsConfirmedByMemberId` to the requester, overwriting any prior voucher;
 * because that same pointer is what the one-step partner declaration keys on
 * (`src/lib/member-partner-link.ts`), any such adult can, in effect, become the
 * voucher. That is intended under #2284's invariant — but it is why no code may
 * treat this pointer as identifying a single, lead-appointed responsible adult.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { memberId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = delegatedDetailsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 422 },
    );
  }

  const requester = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: DELEGATED_MEMBER_SELECT,
  });

  if (!requester || !requester.active) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  if (!requester.canLogin || requester.ageTier !== "ADULT") {
    return NextResponse.json(
      {
        error:
          "Only active adult members with login accounts can confirm family member details",
      },
      { status: 403 },
    );
  }

  const requesterProfile = evaluateSelfServiceProfilePayload(requester);
  if (!requesterProfile.isProfileComplete) {
    return NextResponse.json(
      {
        error:
          "Complete your own contact and address details before confirming another family member.",
        missingFields: getMissingMemberProfileFieldDetails(
          requesterProfile.missingFields,
        ),
      },
      { status: 422 },
    );
  }

  const target = await prisma.member.findUnique({
    where: { id: memberId },
    select: DELEGATED_MEMBER_SELECT,
  });

  if (!target || !target.active) {
    return NextResponse.json(
      { error: "Family member not found" },
      { status: 404 },
    );
  }

  if (target.canLogin) {
    return NextResponse.json(
      {
        error:
          "Members with their own login must sign in and confirm their own details",
      },
      { status: 403 },
    );
  }

  const sharedFamilyGroupIds = getSharedFamilyGroupIds(
    requester.familyGroupMemberships,
    target.familyGroupMemberships,
  );
  if (sharedFamilyGroupIds.length === 0) {
    return NextResponse.json(
      {
        error: "You can only confirm details for members in your family group",
      },
      { status: 403 },
    );
  }

  const dob = parseDateOnly(parsed.data.dateOfBirth);
  if (Number.isNaN(dob.getTime())) {
    return NextResponse.json(
      { error: "Invalid date of birth" },
      { status: 422 },
    );
  }
  // CT-4 (#2870): "in the future" means a later CLUB calendar day, taken from
  // the persisted ClubTimeSettings zone and not the container's TZ
  // (INV-CONFIG-002, INV-DATE-019). The date of birth takes no zone at all
  // (INV-DATE-010), and both sides stay UTC-midnight date-only values.
  const today = dateOnlyInstantOf((await clubTime()).today());
  if (dob > today) {
    return NextResponse.json(
      { error: "Date of birth cannot be in the future" },
      { status: 422 },
    );
  }

  const now = new Date();
  // #2106: recompute the tier from the DOB, then apply enforcement so a FORCED
  // membership type (or an org account) keeps N/A and an ALLOWED-type manual N/A
  // is preserved. The delegate never submits a tier directly.
  // ONE season for both halves of this decision, from the club's PERSISTED zone
  // (CT-4, #2870): the tier the date of birth implies and the exemption that may
  // override it must be judged in the same season, and that tier decides a price
  // band.
  const clubCurrentSeasonYear = clubSeasonYear(await clubTimeZone());
  const dobDerivedTier = await computeAgeTier(
    dob,
    getSeasonStartDate(clubCurrentSeasonYear),
  );
  const typeExemption = await loadMemberCurrentSeasonTypeExemption(
    prisma,
    target.id,
    clubCurrentSeasonYear,
  );
  const enforced = resolveEnforcedAgeTier({
    isOrganisation: isOrganisationMember({
      accessRoleTokens: resolveAccessRoleTokens(target),
      legacyRole: target.role,
    }),
    typeExemption,
    currentAgeTier: target.ageTier,
    restorePersonTier: dobDerivedTier,
  });
  // Only an explicit manual N/A request can fail; delegates never send one.
  const ageTier = enforced.ok ? enforced.ageTier : dobDerivedTier;

  // #2821: wrapped in an interactive transaction so the age-tier write and the
  // email-inheritance re-resolution commit together or not at all. An age tier
  // decides whether this member may be anybody's contact of record
  // (`isUsableEmailSource` requires ADULT), and a delegate correcting a date of
  // birth can move them across that line — leaving a dependant pointing at
  // somebody the rule no longer permits. Doing it after the write would make
  // the guarantee a best effort, which is exactly what the reconciler's own
  // docblock warns against.
  const updated = await prisma.$transaction(async (tx) => {
    const member = await tx.member.update({
      where: { id: target.id },
      data: {
        firstName: parsed.data.firstName.trim(),
        lastName: parsed.data.lastName.trim(),
        dateOfBirth: dob,
        ageTier,
        phoneCountryCode: trimOrNull(requester.phoneCountryCode),
        phoneAreaCode: trimOrNull(requester.phoneAreaCode),
        phoneNumber: trimOrNull(requester.phoneNumber),
        streetAddressLine1: trimOrNull(requester.streetAddressLine1),
        streetAddressLine2: trimOrNull(requester.streetAddressLine2),
        streetCity: trimOrNull(requester.streetCity),
        streetRegion: trimOrNull(requester.streetRegion),
        streetPostalCode: trimOrNull(requester.streetPostalCode),
        streetCountry: trimOrNull(requester.streetCountry),
        postalAddressLine1: trimOrNull(requester.postalAddressLine1),
        postalAddressLine2: trimOrNull(requester.postalAddressLine2),
        postalCity: trimOrNull(requester.postalCity),
        postalRegion: trimOrNull(requester.postalRegion),
        postalPostalCode: trimOrNull(requester.postalPostalCode),
        postalCountry: trimOrNull(requester.postalCountry),
        profileCompletedAt: now,
        detailsConfirmedAt: now,
        detailsConfirmedByMemberId: requester.id,
      },
      select: DELEGATED_MEMBER_SELECT,
    });
    await reconcileEmailInheritanceForMemberChange(tx, [target.id], {
      // A delegate confirming/editing the member's own details (address, etc.):
      // a direct source-member change, attributed to the acting delegate (#2822).
      trigger: "source-member-change",
      actorMemberId: requester.id,
    });
    return member;
  });

  logAudit({
    action: "FAMILY_MEMBER_DETAILS_DELEGATED_CONFIRMED",
    memberId: requester.id,
    targetId: updated.id,
    subjectMemberId: updated.id,
    entityType: "Member",
    entityId: updated.id,
    category: "family",
    outcome: "success",
    summary: "Family member details confirmed by delegate",
    details: JSON.stringify({
      familyGroupIds: sharedFamilyGroupIds,
      inheritedContactFromMemberId: requester.id,
    }),
    metadata: {
      familyGroupIds: sharedFamilyGroupIds,
      inheritedContactFromMemberId: requester.id,
    },
  });

  logger.info(
    {
      requesterId: requester.id,
      targetMemberId: updated.id,
      familyGroupIds: sharedFamilyGroupIds,
    },
    "Family member details confirmed by delegate",
  );

  const hasMappedContactUpdate = updated.xeroContactId
    ? hasMemberXeroContactChanges(target, updated)
    : false;
  const shouldRepairContactNameOrder = updated.xeroContactId
    ? await shouldRepairXeroContactNameOrder(updated)
    : false;
  const needsContactUpdate = Boolean(
    updated.xeroContactId &&
    (hasMappedContactUpdate || shouldRepairContactNameOrder),
  );
  const needsContactGroupSync =
    updated.xeroContactId && target.ageTier !== updated.ageTier;

  if (updated.xeroContactId && (needsContactUpdate || needsContactGroupSync)) {
    try {
      if (await isXeroConnected()) {
        if (needsContactUpdate) {
          await updateXeroContact(
            updated.xeroContactId,
            buildXeroContactUpdatePayload(updated),
            {
              localModel: "Member",
              localId: updated.id,
              createdByMemberId: requester.id,
              preserveXeroName: !shouldRepairContactNameOrder,
            },
          );
        }

        if (needsContactGroupSync) {
          await syncManagedXeroContactGroupForMember(updated.id, {
            createdByMemberId: requester.id,
          });
        }
      }
    } catch (xeroErr) {
      logger.error(
        { err: xeroErr, requesterId: requester.id, targetMemberId: updated.id },
        "Xero sync failed for delegated family member details update",
      );
    }
  }

  return NextResponse.json({
    member: {
      id: updated.id,
      firstName: updated.firstName,
      lastName: updated.lastName,
      ageTier: updated.ageTier,
      canLogin: updated.canLogin,
    },
    profileStatus: serializeStatus(updated),
  });
}
