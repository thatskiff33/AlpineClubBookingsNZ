import type { AgeTier, SubscriptionStatus } from "@prisma/client";
import { getAgeTierSettings } from "@/lib/age-tier";
import {
  isSubscriptionEnforcementActive,
  requiresPaidSubscriptionForAgeTier,
} from "@/lib/member-subscription-eligibility";
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
      };
      select: {
        memberId: true;
        status: true;
        xeroOnlineInvoiceUrl: true;
        xeroInvoiceNumber: true;
      };
    }): Promise<
      Array<{
        memberId: string;
        status: SubscriptionStatus;
        xeroOnlineInvoiceUrl: string | null;
        xeroInvoiceNumber: string | null;
      }>
    >;
  };
  member: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; firstName: true; lastName: true; ageTier: true };
    }): Promise<
      Array<{ id: string; firstName: string; lastName: string; ageTier: AgeTier }>
    >;
  };
}

export interface UnpaidMemberGuestInfo {
  memberId: string;
  name: string;
  status: SubscriptionStatus;
  invoiceUrl: string | null;
  invoiceNumber: string | null;
}

export async function findUnpaidMemberGuests(
  db: BookingMemberGuestSubscriptionDb,
  params: {
    bookingMemberId: string;
    checkIn: Date;
    guests: BookingGuestLike[];
  }
): Promise<UnpaidMemberGuestInfo[]> {
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

  // With the Xero module effectively off, subscriptions cannot be invoiced or
  // paid, so member guests are never blocked on subscription status.
  if (!(await isSubscriptionEnforcementActive())) {
    return [];
  }

  const uniqueIds = [...new Set(memberGuestIds)];
  const ageTierSettings = await getAgeTierSettings();
  const subscriptions = await db.memberSubscription.findMany({
    where: {
      memberId: { in: uniqueIds },
      seasonYear: getSeasonYear(params.checkIn),
    },
    select: {
      memberId: true,
      status: true,
      xeroOnlineInvoiceUrl: true,
      xeroInvoiceNumber: true,
    },
  });

  const subscriptionById = new Map(
    subscriptions.map((subscription) => [subscription.memberId, subscription])
  );
  const linkedMembers = await db.member.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, firstName: true, lastName: true, ageTier: true },
  });

  const memberById = new Map(linkedMembers.map((member) => [member.id, member]));
  const billableUnpaidMemberIds = uniqueIds.filter(
    (id) => subscriptionById.get(id)?.status !== "PAID"
      && (!memberById.has(id)
        || requiresPaidSubscriptionForAgeTier(
          memberById.get(id)!.ageTier,
          ageTierSettings
        ))
  );

  if (billableUnpaidMemberIds.length === 0) {
    return [];
  }

  const nameById = new Map(
    linkedMembers.map((member) => [
      member.id,
      `${member.firstName} ${member.lastName}`.trim() || member.id,
    ])
  );

  return billableUnpaidMemberIds.map((id) => {
    const subscription = subscriptionById.get(id);
    return {
      memberId: id,
      name: nameById.get(id) ?? id,
      status: subscription?.status ?? "NOT_INVOICED",
      invoiceUrl: subscription?.xeroOnlineInvoiceUrl ?? null,
      invoiceNumber: subscription?.xeroInvoiceNumber ?? null,
    };
  });
}

export async function findUnpaidMemberGuestNames(
  db: BookingMemberGuestSubscriptionDb,
  params: {
    bookingMemberId: string;
    checkIn: Date;
    guests: BookingGuestLike[];
  }
): Promise<string[]> {
  const unpaidMembers = await findUnpaidMemberGuests(db, params);
  return unpaidMembers.map((member) => member.name);
}
