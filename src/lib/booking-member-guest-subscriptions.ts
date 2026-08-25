import type { AgeTier, SubscriptionStatus } from "@prisma/client";
import { getAgeTierSettings } from "@/lib/age-tier";
import { memberGuestCrossFamilyRefusal } from "@/lib/booking-guests";
import { isSubscriptionEnforcementActive } from "@/lib/member-subscription-eligibility";
import { resolveMembershipTypePoliciesForMembers } from "@/lib/membership-type-policy";
import {
  resolveMemberSubscriptionSettlement,
  subscriptionIsUnpaid,
} from "@/lib/subscription-lockout-facts";
import { seasonYearOfStoredDate } from "@/lib/financial-year";

interface BookingGuestLike {
  isMember: boolean;
  memberId?: string | null;
  /**
   * This guest is a member being added from beyond the booker's family group
   * ("+ Add Member Guest", epic #2305, MG2 #2307, owner decision **D-8**). Set by
   * the add paths; absent everywhere else, which is the pre-MG2 behaviour.
   */
  crossFamilyMemberGuest?: boolean | null;
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
  const seasonYear = seasonYearOfStoredDate(params.checkIn);
  const ageTierSettings = await getAgeTierSettings();
  const subscriptions = await db.memberSubscription.findMany({
    where: {
      memberId: { in: uniqueIds },
      seasonYear,
    },
    select: {
      memberId: true,
      status: true,
      xeroOnlineInvoiceUrl: true,
      xeroInvoiceNumber: true,
    },
  });
  const membershipTypePolicies = await resolveMembershipTypePoliciesForMembers(db, {
    memberIds: uniqueIds,
    seasonYear,
  });

  const subscriptionById = new Map(
    subscriptions.map((subscription) => [subscription.memberId, subscription])
  );
  const linkedMembers = await db.member.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, firstName: true, lastName: true, ageTier: true },
  });

  const memberById = new Map(linkedMembers.map((member) => [member.id, member]));
  // #2543: the RULE itself now lives in `resolveMemberSubscriptionSettlement`,
  // shared verbatim with the booking-owner gate and the pricing reprice. This
  // function keeps its own queries (and so its own call shape) but no longer
  // keeps its own copy of the decision — the three used to be three
  // hand-maintained branches of the same logic, and once one of them decides a
  // PRICE they cannot be allowed to drift.
  const billableUnpaidMemberIds = uniqueIds.filter((id) =>
    subscriptionIsUnpaid(
      resolveMemberSubscriptionSettlement({
        subscriptionBehavior: membershipTypePolicies.get(id)?.subscriptionBehavior,
        subscriptionStatus: subscriptionById.get(id)?.status,
        ageTier: memberById.get(id)?.ageTier ?? null,
        ageTierSettings,
      }),
    ),
  );

  if (billableUnpaidMemberIds.length === 0) {
    return [];
  }

  // D-8 (MG2 #2307) — a cross-family member guest with an unpaid subscription is
  // refused NEUTRALLY, and this function throws rather than returning a row.
  //
  // This refusal was the most disclosive of the three D-8 collapses: the create
  // route returned the member's NAME, their subscription STATUS, their Xero
  // invoice NUMBER and a link to their invoice, and the guest-add route returned
  // their name in the message text. Against a member of the booker's own family
  // that is the helpful thing to do — someone in the household can act on it —
  // and family-scope adds keep it verbatim. Against a member the caller may never
  // have met it is a financial-status oracle that any logged-in member could
  // query one id at a time.
  //
  // Refusing here rather than at each route is deliberate, and follows the same
  // rule as the person-night guard: the marker rides the guest, so the collapse
  // reaches every caller of this helper (the create route, the guest-add route,
  // and anything added later) instead of the two that remembered.
  const refusedCrossFamilyMemberIds = params.guests
    .filter(
      (guest) =>
        guest.crossFamilyMemberGuest === true &&
        guest.memberId &&
        billableUnpaidMemberIds.includes(guest.memberId),
    )
    .map((guest) => guest.memberId!)
    // #2388: the refusal carries WHICH beyond-family members it was about, so the
    // route can write one audit row per target without recomputing the boundary.
    .filter((memberId, index, all) => all.indexOf(memberId) === index);
  if (refusedCrossFamilyMemberIds.length > 0) {
    throw memberGuestCrossFamilyRefusal(refusedCrossFamilyMemberIds);
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
