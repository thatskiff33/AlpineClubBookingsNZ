import { getSeasonYear } from "@/lib/utils";

interface BookingGuestLike {
  isMember: boolean;
  memberId?: string | null;
}

interface BookingMemberGuestSubscriptionDb {
  memberSubscription: {
    findMany(args: {
      where: {
        memberId: { in: string[] };
        seasonYear: number;
        status: "PAID";
      };
      select: { memberId: true };
    }): Promise<Array<{ memberId: string }>>;
  };
  member: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; firstName: true; lastName: true };
    }): Promise<Array<{ id: string; firstName: string; lastName: string }>>;
  };
}

export async function findUnpaidMemberGuestNames(
  db: BookingMemberGuestSubscriptionDb,
  params: {
    bookingMemberId: string;
    checkIn: Date;
    guests: BookingGuestLike[];
  }
): Promise<string[]> {
  const memberGuestIds = params.guests
    .filter(
      (guest) =>
        guest.isMember &&
        guest.memberId &&
        guest.memberId !== params.bookingMemberId
    )
    .map((guest) => guest.memberId as string);

  if (memberGuestIds.length === 0) {
    return [];
  }

  const uniqueIds = [...new Set(memberGuestIds)];
  const paidSubscriptions = await db.memberSubscription.findMany({
    where: {
      memberId: { in: uniqueIds },
      seasonYear: getSeasonYear(params.checkIn),
      status: "PAID",
    },
    select: { memberId: true },
  });

  const paidMemberIds = new Set(
    paidSubscriptions.map((subscription) => subscription.memberId)
  );
  const unpaidMemberIds = uniqueIds.filter((id) => !paidMemberIds.has(id));

  if (unpaidMemberIds.length === 0) {
    return [];
  }

  const unpaidMembers = await db.member.findMany({
    where: { id: { in: unpaidMemberIds } },
    select: { id: true, firstName: true, lastName: true },
  });

  const nameById = new Map(
    unpaidMembers.map((member) => [
      member.id,
      `${member.firstName} ${member.lastName}`.trim() || member.id,
    ])
  );

  return unpaidMemberIds.map((id) => nameById.get(id) ?? id);
}
