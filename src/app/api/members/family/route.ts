import { NextResponse } from "next/server";
import type { AgeTier } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  formatMemberProfileMissingField,
  getMemberProfileCompleteness,
  type MemberProfileCompletenessInput,
  type MemberProfileCompletenessResult,
} from "@/lib/member-profile-completeness";
import type { BookingGuestProfileAction } from "@/lib/booking-guests";

const FAMILY_MEMBER_PROFILE_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  ageTier: true,
  active: true,
  canLogin: true,
  role: true,
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
    select: {
      familyGroupId: true,
      familyGroup: { select: { id: true, name: true } },
    },
  },
} as const;

type FamilyMemberRecord = MemberProfileCompletenessInput & {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  active: boolean;
  canLogin: boolean;
  role: string;
  familyGroupMemberships?: Array<{
    familyGroupId: string;
    familyGroup?: { id: string; name: string | null } | null;
  }>;
};

type FamilyMemberRelationship = "self" | "partner" | "dependent";

type PendingFamilyRequest = {
  id: string;
  type: string;
  status: string;
  familyGroupId: string;
  requesterId: string;
  invitedMemberId: string | null;
  linkedMemberId: string | null;
  subjectMemberId: string | null;
  requestedFirstName: string | null;
  requestedLastName: string | null;
  requestedDateOfBirth: Date | null;
  requestedEmail: string | null;
  requestNotes: string | null;
  childFirstName: string | null;
  childLastName: string | null;
  childDateOfBirth: Date | null;
};

type FamilyMemberPendingRequest = Pick<
  PendingFamilyRequest,
  "id" | "type" | "status" | "familyGroupId"
>;

function getFamilyGroupMemberships(
  member: Partial<Pick<FamilyMemberRecord, "familyGroupMemberships">>
) {
  return Array.isArray(member.familyGroupMemberships)
    ? member.familyGroupMemberships
    : [];
}

function getDisplayName(member: { firstName?: string | null; lastName?: string | null }) {
  return [member.firstName, member.lastName].filter(Boolean).join(" ").trim() || "this member";
}

function toDateInputValue(value: Date | string | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().substring(0, 10);
  }
  return value.substring(0, 10);
}

function getFamilyMemberAction(params: {
  member: FamilyMemberRecord;
  selfId: string;
  canCurrentUserConfirmDetails: boolean;
  needsOwnLoginConfirmation: boolean;
  pendingRequestStatus: string | null;
}): BookingGuestProfileAction | null {
  const {
    member,
    selfId,
    canCurrentUserConfirmDetails,
    needsOwnLoginConfirmation,
    pendingRequestStatus,
  } = params;

  if (pendingRequestStatus) {
    return "pending_admin_approval";
  }

  if (member.canLogin && member.id !== selfId && needsOwnLoginConfirmation) {
    return "own_login_required";
  }

  if (member.id === selfId || canCurrentUserConfirmDetails) {
    return "complete_details";
  }

  if (needsOwnLoginConfirmation) {
    return "own_login_required";
  }

  return "contact_admin";
}

function requestTargetsMember(request: PendingFamilyRequest, memberId: string) {
  return (
    request.invitedMemberId === memberId ||
    request.linkedMemberId === memberId ||
    request.subjectMemberId === memberId
  );
}

function getPendingRequestsForMember(
  memberId: string,
  familyGroupIds: string[],
  pendingRequests: PendingFamilyRequest[]
) {
  const familyGroupIdSet = new Set(familyGroupIds);
  return pendingRequests.filter(
    (request) =>
      familyGroupIdSet.has(request.familyGroupId) &&
      requestTargetsMember(request, memberId)
  );
}

function serializeProfileStatus(status: MemberProfileCompletenessResult) {
  return {
    isProfileComplete: status.isProfileComplete,
    isDetailsConfirmed: status.isDetailsConfirmed,
    canBeBookedAsMember: status.canBeBookedAsMember,
    missingFields: status.missingFields.map(formatMemberProfileMissingField),
    needsOwnLoginConfirmation: status.needsOwnLoginConfirmation,
    confirmationMode: status.confirmationMode,
  };
}

/**
 * GET /api/members/family
 * Returns self + all active members from all family groups the user belongs to.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const self = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: FAMILY_MEMBER_PROFILE_SELECT,
  });

  if (!self) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const currentMember = self;
  const groupIds = getFamilyGroupMemberships(currentMember).map(
    (membership) => membership.familyGroupId
  );

  const groupMemberships = groupIds.length > 0
    ? await prisma.familyGroupMember.findMany({
        where: {
          familyGroupId: { in: groupIds },
          memberId: { not: session.user.id },
          member: { active: true },
        },
        include: {
          member: {
            select: FAMILY_MEMBER_PROFILE_SELECT,
          },
        },
        orderBy: { member: { firstName: "asc" } },
      })
    : [];

  const rawPendingRequests = groupIds.length > 0
    && typeof prisma.familyGroupJoinRequest?.findMany === "function"
    ? await prisma.familyGroupJoinRequest.findMany({
        where: {
          familyGroupId: { in: groupIds },
          status: "PENDING",
        },
        select: {
          id: true,
          type: true,
          status: true,
          familyGroupId: true,
          requesterId: true,
          invitedMemberId: true,
          linkedMemberId: true,
          subjectMemberId: true,
          requestedFirstName: true,
          requestedLastName: true,
          requestedDateOfBirth: true,
          requestedEmail: true,
          requestNotes: true,
          childFirstName: true,
          childLastName: true,
          childDateOfBirth: true,
        },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const pendingRequests = Array.isArray(rawPendingRequests) ? rawPendingRequests : [];

  const allMembers = [currentMember, ...groupMemberships.map((membership) => membership.member)];
  const memberById = new Map(allMembers.map((member) => [member.id, member]));
  const groupIdsByMemberId = new Map<string, Set<string>>();
  for (const member of allMembers) {
    groupIdsByMemberId.set(
      member.id,
      new Set(
        getFamilyGroupMemberships(member).map((membership) => membership.familyGroupId)
      )
    );
  }

  function sharesFamilyGroup(memberId: string, otherMemberId: string) {
    const groups = groupIdsByMemberId.get(memberId);
    const otherGroups = groupIdsByMemberId.get(otherMemberId);
    if (!groups || !otherGroups) {
      return false;
    }

    for (const groupId of groups) {
      if (otherGroups.has(groupId)) {
        return true;
      }
    }
    return false;
  }

  function isActiveLoginAdult(memberId: string) {
    const member = memberById.get(memberId);
    return (
      member?.active === true &&
      member.canLogin === true &&
      member.ageTier === "ADULT"
    );
  }

  function hasValidDelegatedConfirmation(member: FamilyMemberRecord) {
    return (
      member.canLogin === false &&
      Boolean(member.detailsConfirmedByMemberId) &&
      isActiveLoginAdult(member.detailsConfirmedByMemberId!) &&
      sharesFamilyGroup(member.id, member.detailsConfirmedByMemberId!)
    );
  }

  const seen = new Set<string>();
  const familyMembers: Array<{
    id: string;
    firstName: string;
    lastName: string;
    ageTier: AgeTier;
    relationship: FamilyMemberRelationship;
    canLogin: boolean;
    profileStatus: ReturnType<typeof serializeProfileStatus>;
    canBeBooked: boolean;
    missingFields: string[];
    needsOwnLoginConfirmation: boolean;
    canCurrentUserConfirmDetails: boolean;
    pendingRequestStatus: string | null;
    pendingRequestType: string | null;
    pendingRequests: FamilyMemberPendingRequest[];
    pendingRequestFamilyGroupIds: string[];
    bookableFamilyGroupIds: string[];
    action: BookingGuestProfileAction | null;
    dateOfBirth: string | null;
    familyGroupIds: string[];
  }> = [];

  function addMember(member: FamilyMemberRecord, relationship: FamilyMemberRelationship) {
    if (seen.has(member.id)) return;
    seen.add(member.id);

    const profileStatus = getMemberProfileCompleteness(member, {
      delegatedConfirmationValid: hasValidDelegatedConfirmation(member),
    });
    const sharedFamilyGroupIds = getFamilyGroupMemberships(member)
      .map((membership) => membership.familyGroupId)
      .filter((groupId) => groupIds.includes(groupId));
    const memberPendingRequests = getPendingRequestsForMember(
      member.id,
      sharedFamilyGroupIds,
      pendingRequests
    );
    const pendingRequestFamilyGroupIds = [
      ...new Set(memberPendingRequests.map((request) => request.familyGroupId)),
    ];
    const pendingRequestFamilyGroupIdSet = new Set(pendingRequestFamilyGroupIds);
    const bookableFamilyGroupIds = sharedFamilyGroupIds.filter(
      (groupId) => !pendingRequestFamilyGroupIdSet.has(groupId)
    );
    const allSharedMembershipsBlocked =
      sharedFamilyGroupIds.length > 0 &&
      bookableFamilyGroupIds.length === 0 &&
      memberPendingRequests.length > 0;
    const effectivePendingRequest = allSharedMembershipsBlocked
      ? memberPendingRequests[0] ?? null
      : null;
    const canCurrentUserConfirmDetails =
      member.canLogin === false &&
      isActiveLoginAdult(currentMember.id) &&
      sharesFamilyGroup(member.id, currentMember.id);
    const action = profileStatus.canBeBookedAsMember
      ? null
      : getFamilyMemberAction({
          member,
          selfId: currentMember.id,
          canCurrentUserConfirmDetails,
          needsOwnLoginConfirmation: profileStatus.needsOwnLoginConfirmation,
          pendingRequestStatus: effectivePendingRequest?.status ?? null,
        });
    const serializedStatus = serializeProfileStatus(profileStatus);

    familyMembers.push({
      id: member.id,
      firstName: member.firstName,
      lastName: member.lastName,
      ageTier: member.ageTier,
      relationship,
      canLogin: member.canLogin,
      profileStatus: serializedStatus,
      canBeBooked: serializedStatus.canBeBookedAsMember && !allSharedMembershipsBlocked,
      missingFields: serializedStatus.missingFields,
      needsOwnLoginConfirmation: serializedStatus.needsOwnLoginConfirmation,
      canCurrentUserConfirmDetails,
      pendingRequestStatus: effectivePendingRequest?.status ?? null,
      pendingRequestType: effectivePendingRequest?.type ?? null,
      pendingRequests: memberPendingRequests.map((request) => ({
        id: request.id,
        type: request.type,
        status: request.status,
        familyGroupId: request.familyGroupId,
      })),
      pendingRequestFamilyGroupIds,
      bookableFamilyGroupIds,
      action,
      dateOfBirth: toDateInputValue(member.dateOfBirth),
      familyGroupIds: sharedFamilyGroupIds,
    });
  }

  addMember(currentMember, "self");
  for (const membership of groupMemberships) {
    addMember(
      membership.member,
      membership.member.ageTier === "ADULT" ? "partner" : "dependent"
    );
  }

  const firstGroup = getFamilyGroupMemberships(currentMember)[0]?.familyGroup ?? null;

  return NextResponse.json({
    familyGroupId: firstGroup?.id ?? null,
    familyGroupName: firstGroup?.name ?? null,
    familyGroupIds: groupIds,
    displayName: getDisplayName(currentMember),
    familyMembers,
    pendingRequests: pendingRequests.map((request) => ({
      id: request.id,
      type: request.type,
      status: request.status,
      familyGroupId: request.familyGroupId,
      requesterId: request.requesterId,
      invitedMemberId: request.invitedMemberId,
      linkedMemberId: request.linkedMemberId,
      subjectMemberId: request.subjectMemberId,
      requestedFirstName: request.requestedFirstName,
      requestedLastName: request.requestedLastName,
      requestedDateOfBirth: toDateInputValue(request.requestedDateOfBirth),
      requestedEmail: request.requestedEmail,
      requestNotes: request.requestNotes,
      childFirstName: request.childFirstName,
      childLastName: request.childLastName,
      childDateOfBirth: toDateInputValue(request.childDateOfBirth),
    })),
  });
}
