import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  MEMBER_ONBOARDING_FAMILY_SELECT,
  MEMBER_ONBOARDING_PROFILE_SELECT,
  getMemberDisplayName,
  getMemberOnboardingStatus,
  serializeMemberProfile,
  shouldShowMemberOnboarding,
  type MemberOnboardingProfile,
} from "@/lib/member-onboarding";
import { buildMemberFacingParentLinks } from "@/lib/member-parent-links";
import { getMissingMemberProfileFieldDetails } from "@/lib/member-profile-completeness";
import { loadMemberFieldsFlags } from "@/lib/member-fields-settings";
import { formatDateOnly } from "@/lib/date-only";
import {
  grantSelfDietaryAccess,
  loadDietaryRequirementsForDisplay,
} from "@/lib/member-dietary";

function serializeStatus(member: MemberOnboardingProfile) {
  const status = getMemberOnboardingStatus(member);

  return {
    ...status,
    missingFieldDetails: getMissingMemberProfileFieldDetails(status.missingFields),
  };
}

function serializeFamilyMember(
  member: MemberOnboardingProfile,
  currentMemberId: string,
  /**
   * #2424: the VIEWER's own family groups. A parent recorded against a family
   * member need not be in any of them — parent links carry no shared-group
   * requirement — and a parent outside them all is returned without an email
   * address.
   */
  viewerFamilyGroupIds: string[]
) {
  const status = serializeStatus(member);
  const isCurrentUser = member.id === currentMemberId;
  const needsAttention =
    status.confirmationMode !== "not_allowed" &&
    (
      !status.isProfileComplete ||
      !status.isDetailsConfirmed ||
      (isCurrentUser && !status.hasCompletedOnboarding)
    );
  const nextAction = isCurrentUser
    ? "current_user"
    : status.confirmationMode === "not_allowed"
      ? "confirmation_not_required"
      : member.canLogin
        ? needsAttention
          ? "self_confirmation_required"
          : "complete"
        : needsAttention
          ? "delegated_placeholder"
          : "complete";

  return {
    id: member.id,
    name: getMemberDisplayName(member),
    firstName: member.firstName,
    lastName: member.lastName,
    email: member.email,
    ageTier: member.ageTier,
    active: member.active,
    canLogin: member.canLogin,
    role: member.role,
    isCurrentUser,
    status,
    nextAction,
    parentLinks: buildMemberFacingParentLinks(member, viewerFamilyGroupIds),
    notificationEmailFromId: member.inheritEmailFromId ?? null,
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const currentMember = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      ...MEMBER_ONBOARDING_PROFILE_SELECT,
      forcePasswordChange: true,
      occupation: true,
      familyGroupMemberships: {
        select: {
          familyGroupId: true,
          familyGroup: {
            select: {
              id: true,
              name: true,
              memberships: {
                where: { member: { active: true } },
                select: {
                  // #2520: no `role` here. The column is dropped
                  // (20260803030000) and the payload no longer exposes it (see
                  // `members` below).
                  member: {
                    // #2424: the family-scoped select — it carries each
                    // parent's family groups so the payload can decide, on the
                    // server, whether this viewer may have that parent's email.
                    select: MEMBER_ONBOARDING_FAMILY_SELECT,
                  },
                },
                orderBy: { member: { firstName: "asc" } },
              },
            },
          },
        },
      },
    },
  });

  if (!currentMember) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const groupIds = currentMember.familyGroupMemberships.map(
    (membership) => membership.familyGroupId
  );
  const requestFilters: Prisma.FamilyGroupJoinRequestWhereInput[] = [
    { requesterId: session.user.id },
    { invitedMemberId: session.user.id },
    { linkedMemberId: session.user.id },
  ];

  if (groupIds.length > 0) {
    requestFilters.push({ familyGroupId: { in: groupIds } });
  }

  const pendingRequests = await prisma.familyGroupJoinRequest.findMany({
    where: {
      status: "PENDING",
      OR: requestFilters,
    },
    select: {
      id: true,
      type: true,
      status: true,
      createdAt: true,
      familyGroupId: true,
      requesterId: true,
      invitedMemberId: true,
      linkedMemberId: true,
      subjectMemberId: true,
      requestedFirstName: true,
      requestedLastName: true,
      requestedDateOfBirth: true,
      childFirstName: true,
      childLastName: true,
      childDateOfBirth: true,
      familyGroup: { select: { id: true, name: true } },
      requester: { select: { id: true, firstName: true, lastName: true } },
      invitedMember: { select: { id: true, firstName: true, lastName: true } },
      linkedMember: { select: { id: true, firstName: true, lastName: true } },
      subjectMember: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const currentStatus = serializeStatus(currentMember);
  const shouldShow = shouldShowMemberOnboarding(currentMember);
  const memberFieldsFlags = await loadMemberFieldsFlags();
  // #2941 (INV-PRIV-022): the viewer's OWN dietary value only, through the one
  // dietary door, and only while the field is ON. Family members serialised
  // below never carry it — a relationship is not a grant.
  const dietary = await loadDietaryRequirementsForDisplay(
    grantSelfDietaryAccess(session),
    session.user.id,
    { enabled: memberFieldsFlags.showDietaryRequirements },
  );

  return NextResponse.json({
    shouldShow,
    currentMember: {
      id: currentMember.id,
      name: getMemberDisplayName(currentMember),
      canLogin: currentMember.canLogin,
      active: currentMember.active,
      role: currentMember.role,
      ageTier: currentMember.ageTier,
      showOccupation: memberFieldsFlags.showOccupation,
      showDietaryRequirements: dietary.enabled,
      profile: {
        ...serializeMemberProfile(currentMember),
        occupation: currentMember.occupation ?? "",
        ...(dietary.enabled ? { dietaryRequirements: dietary.value ?? "" } : {}),
      },
      status: currentStatus,
      needsOwnDetailsConfirmation:
        currentStatus.confirmationMode === "self" &&
        (!currentStatus.isDetailsConfirmed || !currentStatus.hasCompletedOnboarding),
    },
    familyGroups: currentMember.familyGroupMemberships.map((membership) => ({
      id: membership.familyGroup.id,
      name: membership.familyGroup.name,
      // #2520: `groupRole` is gone from the payload. It exposed the
      // FamilyGroupMember.role column — now dropped (20260803030000) — to the
      // member-facing onboarding wizard, which declared the field in its type
      // and never rendered it.
      members: membership.familyGroup.memberships.map((groupMember) =>
        serializeFamilyMember(groupMember.member, currentMember.id, groupIds)
      ),
    })),
    pendingRequests: pendingRequests.map((request) => ({
      id: request.id,
      type: request.type,
      status: request.status,
      createdAt: request.createdAt,
      familyGroupId: request.familyGroupId,
      familyGroupName: request.familyGroup.name,
      requester: request.requester
        ? {
            id: request.requester.id,
            name: getMemberDisplayName(request.requester),
          }
        : null,
      invitedMember: request.invitedMember
        ? {
            id: request.invitedMember.id,
            name: getMemberDisplayName(request.invitedMember),
          }
        : null,
      linkedMember: request.linkedMember
        ? {
            id: request.linkedMember.id,
            name: getMemberDisplayName(request.linkedMember),
          }
        : null,
      subjectMember: request.subjectMember
        ? {
            id: request.subjectMember.id,
            name: getMemberDisplayName(request.subjectMember),
          }
        : null,
      requestedName:
        request.requestedFirstName && request.requestedLastName
          ? `${request.requestedFirstName} ${request.requestedLastName}`
          : null,
      requestedDateOfBirth: request.requestedDateOfBirth
        ? formatDateOnly(request.requestedDateOfBirth)
        : null,
      childName:
        request.childFirstName && request.childLastName
          ? `${request.childFirstName} ${request.childLastName}`
          : null,
      childDateOfBirth: request.childDateOfBirth
        ? formatDateOnly(request.childDateOfBirth)
        : null,
      direction:
        request.requesterId === currentMember.id
          ? "submitted"
          : request.invitedMemberId === currentMember.id
            ? "invitation"
            : "family_group",
      isPendingAdminRequest: request.type !== "ADULT_INVITE",
    })),
  });
}
