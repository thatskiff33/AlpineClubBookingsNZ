import type { AgeTier, Prisma, PrismaClient } from "@prisma/client";
import {
  formatMemberProfileMissingField,
  getMemberProfileCompleteness,
  type MemberProfileCompletenessResult,
} from "@/lib/member-profile-completeness";

export type BookingGuestPricingInput = {
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
};

export type BookingGuestInput = BookingGuestPricingInput & {
  firstName: string;
  lastName: string;
};

type BookingGuestAgeTierSource = {
  ageTier: AgeTier;
  member?: { ageTier: AgeTier } | null;
};

type BookingGuestLookupDb =
  | Pick<PrismaClient, "familyGroupMember" | "member">
  | Pick<Prisma.TransactionClient, "familyGroupMember" | "member">;

export type LinkedBookingMember = {
  id: string;
  ageTier: AgeTier;
  active?: boolean | null;
  canLogin?: boolean | null;
  firstName?: string | null;
  lastName?: string | null;
  phoneCountryCode?: string | null;
  phoneAreaCode?: string | null;
  phoneNumber?: string | null;
  dateOfBirth?: Date | null;
  streetAddressLine1?: string | null;
  streetAddressLine2?: string | null;
  streetCity?: string | null;
  streetRegion?: string | null;
  streetPostalCode?: string | null;
  streetCountry?: string | null;
  postalAddressLine1?: string | null;
  postalAddressLine2?: string | null;
  postalCity?: string | null;
  postalRegion?: string | null;
  postalPostalCode?: string | null;
  postalCountry?: string | null;
  role?: string | null;
  profileCompletedAt?: Date | null;
  detailsConfirmedAt?: Date | null;
  detailsConfirmedByMemberId?: string | null;
  onboardingConfirmedAt?: Date | null;
};

export class BookingGuestValidationError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

export const GUEST_PROFILE_REQUIRED_ERROR_CODE = "GUEST_PROFILE_REQUIRED";

export type BookingGuestProfileAction =
  | "complete_details"
  | "own_login_required"
  | "pending_admin_approval"
  | "contact_admin";

export type GuestProfileRequiredMember = {
  memberId: string;
  name: string;
  canCurrentUserResolve: boolean;
  needsOwnLoginConfirmation: boolean;
  missingFields: string[];
  action: BookingGuestProfileAction;
};

export class BookingGuestProfileRequiredError extends BookingGuestValidationError {
  public code = GUEST_PROFILE_REQUIRED_ERROR_CODE;

  constructor(public members: GuestProfileRequiredMember[]) {
    super(
      "Some member guests need their details completed or confirmed before booking.",
      403
    );
  }

  toResponseBody() {
    return {
      code: this.code,
      error: this.message,
      members: this.members,
    };
  }
}

export type LinkedBookingMemberProfileGateContext = {
  actorRole?: string | null;
  onBehalfOfMemberId?: string | null;
};

function skipsMemberProfileGateForAdminOnBehalf(
  context?: LinkedBookingMemberProfileGateContext
) {
  return context?.actorRole === "ADMIN" && Boolean(context.onBehalfOfMemberId);
}

export function getBookingGuestValidationErrorResponse(
  error: BookingGuestValidationError
) {
  if (error instanceof BookingGuestProfileRequiredError) {
    return error.toResponseBody();
  }

  return { error: error.message };
}

function normalizeMemberIds(memberIds: Array<string | null | undefined>): string[] {
  return [...new Set(
    memberIds
      .map((memberId) => memberId?.trim())
      .filter((memberId): memberId is string => Boolean(memberId))
  )];
}

export async function resolveLinkedBookingMembers(
  db: BookingGuestLookupDb,
  bookingMemberId: string,
  memberIds: Array<string | null | undefined>,
  options?: { skipAuthorization?: boolean }
): Promise<Map<string, LinkedBookingMember>> {
  const normalizedMemberIds = normalizeMemberIds(memberIds);

  if (normalizedMemberIds.length === 0) {
    return new Map();
  }

  if (!options?.skipAuthorization) {
    const allowedMemberIds = await getAllowedGuestMemberIds(db, bookingMemberId);
    for (const memberId of normalizedMemberIds) {
      if (!allowedMemberIds.has(memberId)) {
        throw new BookingGuestValidationError("Invalid guest member reference", 403);
      }
    }
  }

  const linkedMembers = await db.member.findMany({
    where: { id: { in: normalizedMemberIds }, active: true },
    select: {
      id: true,
      ageTier: true,
      active: true,
      canLogin: true,
      firstName: true,
      lastName: true,
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
      role: true,
      profileCompletedAt: true,
      detailsConfirmedAt: true,
      detailsConfirmedByMemberId: true,
      onboardingConfirmedAt: true,
    },
  });

  const linkedMemberMap = new Map(linkedMembers.map((member) => [member.id, member]));
  for (const memberId of normalizedMemberIds) {
    if (!linkedMemberMap.has(memberId)) {
      throw new BookingGuestValidationError("Linked member is inactive or not found", 400);
    }
  }

  return linkedMemberMap;
}

function hasProfileGateFields(member: LinkedBookingMember) {
  return (
    "canLogin" in member &&
    "detailsConfirmedAt" in member &&
    "detailsConfirmedByMemberId" in member
  );
}

function getMemberDisplayName(member: LinkedBookingMember) {
  return [member.firstName, member.lastName].filter(Boolean).join(" ").trim() || "Member";
}

function getBlockedGuestAction(params: {
  member: LinkedBookingMember;
  status: MemberProfileCompletenessResult;
  currentUserId: string;
  canCurrentUserResolve: boolean;
}): BookingGuestProfileAction {
  const { member, status, currentUserId, canCurrentUserResolve } = params;

  if (status.confirmationMode === "not_allowed") {
    return "contact_admin";
  }

  if (member.canLogin === true && member.id !== currentUserId) {
    return "own_login_required";
  }

  if (canCurrentUserResolve) {
    return "complete_details";
  }

  if (status.needsOwnLoginConfirmation) {
    return "own_login_required";
  }

  return "contact_admin";
}

export async function assertLinkedBookingMembersCanBeBooked(
  db: BookingGuestLookupDb,
  linkedMembers: Map<string, LinkedBookingMember>,
  currentUserId: string,
  context?: LinkedBookingMemberProfileGateContext
) {
  if (skipsMemberProfileGateForAdminOnBehalf(context)) {
    return;
  }

  const members = [...linkedMembers.values()].filter(hasProfileGateFields);
  if (members.length === 0) {
    return;
  }

  const confirmerIds = normalizeMemberIds(
    members.map((member) => member.detailsConfirmedByMemberId)
  );
  const participantIds = normalizeMemberIds([
    currentUserId,
    ...members.map((member) => member.id),
    ...confirmerIds,
  ]);

  const [familyLinks, resolverMembers] = await Promise.all([
    db.familyGroupMember.findMany({
      where: { memberId: { in: participantIds } },
      select: { memberId: true, familyGroupId: true },
    }),
    db.member.findMany({
      where: { id: { in: normalizeMemberIds([currentUserId, ...confirmerIds]) }, active: true },
      select: { id: true, active: true, canLogin: true, ageTier: true },
    }),
  ]);

  const groupsByMemberId = new Map<string, Set<string>>();
  for (const link of familyLinks) {
    const groups = groupsByMemberId.get(link.memberId) ?? new Set<string>();
    groups.add(link.familyGroupId);
    groupsByMemberId.set(link.memberId, groups);
  }

  const resolverMemberMap = new Map(
    resolverMembers.map((member) => [member.id, member])
  );

  function sharesFamilyGroup(memberId: string, otherMemberId: string) {
    const groups = groupsByMemberId.get(memberId);
    const otherGroups = groupsByMemberId.get(otherMemberId);
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
    const member = resolverMemberMap.get(memberId);
    return (
      member?.active === true &&
      member.canLogin === true &&
      member.ageTier === "ADULT"
    );
  }

  const blockedMembers: GuestProfileRequiredMember[] = [];

  for (const member of members) {
    const delegatedConfirmationValid =
      member.canLogin === false &&
      Boolean(member.detailsConfirmedByMemberId) &&
      isActiveLoginAdult(member.detailsConfirmedByMemberId!) &&
      sharesFamilyGroup(member.id, member.detailsConfirmedByMemberId!);

    const status = getMemberProfileCompleteness(member, {
      delegatedConfirmationValid,
    });

    if (status.canBeBookedAsMember) {
      continue;
    }

    const canCurrentUserConfirmDelegatedDetails =
      member.canLogin === false &&
      isActiveLoginAdult(currentUserId) &&
      sharesFamilyGroup(member.id, currentUserId);
    const canCurrentUserResolve =
      (member.canLogin === true && member.id === currentUserId) ||
      canCurrentUserConfirmDelegatedDetails;

    blockedMembers.push({
      memberId: member.id,
      name: getMemberDisplayName(member),
      canCurrentUserResolve,
      needsOwnLoginConfirmation: status.needsOwnLoginConfirmation,
      missingFields: status.missingFields.map(formatMemberProfileMissingField),
      action: getBlockedGuestAction({
        member,
        status,
        currentUserId,
        canCurrentUserResolve,
      }),
    });
  }

  if (blockedMembers.length > 0) {
    throw new BookingGuestProfileRequiredError(blockedMembers);
  }
}

async function getAllowedGuestMemberIds(
  db: BookingGuestLookupDb,
  bookingMemberId: string
): Promise<Set<string>> {
  const allowedMemberIds = new Set<string>([bookingMemberId]);
  const familyLinks = await db.familyGroupMember.findMany({
    where: { memberId: bookingMemberId },
    select: { familyGroupId: true },
  });

  const groupIds = familyLinks
    .map((link) => link.familyGroupId)
    .filter((familyGroupId): familyGroupId is string => Boolean(familyGroupId));

  if (groupIds.length === 0) {
    return allowedMemberIds;
  }

  const familyMembers = await db.familyGroupMember.findMany({
    where: { familyGroupId: { in: groupIds } },
    select: { memberId: true },
  });

  for (const familyMember of familyMembers) {
    if (familyMember.memberId) {
      allowedMemberIds.add(familyMember.memberId);
    }
  }

  return allowedMemberIds;
}

export function normalizeBookingGuestPricingInputs(
  guests: BookingGuestPricingInput[],
  linkedMembers: Map<string, LinkedBookingMember>
): BookingGuestPricingInput[] {
  return guests.map((guest) => {
    const memberId = guest.memberId?.trim();
    if (!memberId) {
      return { ...guest, isMember: false, memberId: undefined };
    }

    const linkedMember = linkedMembers.get(memberId);
    if (!linkedMember) {
      return { ...guest, isMember: false, memberId: undefined };
    }

    return {
      ...guest,
      ageTier: linkedMember.ageTier,
      isMember: true,
      memberId,
    };
  });
}

export function normalizeBookingGuestInputs(
  guests: BookingGuestInput[],
  linkedMembers: Map<string, LinkedBookingMember>
): BookingGuestInput[] {
  return guests.map((guest) => {
    const memberId = guest.memberId?.trim();
    if (!memberId) {
      return { ...guest, isMember: false, memberId: undefined };
    }

    const linkedMember = linkedMembers.get(memberId);
    if (!linkedMember) {
      return { ...guest, isMember: false, memberId: undefined };
    }

    return {
      ...guest,
      firstName: linkedMember.firstName || guest.firstName,
      lastName: linkedMember.lastName || guest.lastName,
      ageTier: linkedMember.ageTier,
      isMember: true,
      memberId,
    };
  });
}

export function getBookingGuestDisplayAgeTier(
  guest: BookingGuestAgeTierSource
): AgeTier {
  return (guest.member?.ageTier ?? guest.ageTier) as AgeTier;
}
