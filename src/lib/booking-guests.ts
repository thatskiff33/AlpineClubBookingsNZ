import type { AgeTier, Prisma, PrismaClient } from "@prisma/client";

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
  firstName?: string | null;
  lastName?: string | null;
};

export class BookingGuestValidationError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
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
    select: { id: true, ageTier: true, firstName: true, lastName: true },
  });

  const linkedMemberMap = new Map(linkedMembers.map((member) => [member.id, member]));
  for (const memberId of normalizedMemberIds) {
    if (!linkedMemberMap.has(memberId)) {
      throw new BookingGuestValidationError("Linked member is inactive or not found", 400);
    }
  }

  return linkedMemberMap;
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
