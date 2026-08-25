import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { clubTimeZone } from "@/lib/club-time/server";
import { clubSeasonYear } from "@/lib/financial-year";
import {
  requiresPaidSubscriptionForMemberForBooking,
  resolveMembershipTypePolicyForMember,
} from "@/lib/membership-type-policy";
import { resolveSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import { formatUnpaidSubscriptionRateReason } from "@/lib/policies/subscription-lockout-pricing";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const seasonYear = clubSeasonYear(await clubTimeZone());
  const seasonDisplay = `${seasonYear}/${seasonYear + 1}`;

  const subscriptionSelect = {
    status: true,
    xeroInvoiceId: true,
    xeroInvoiceNumber: true,
    xeroOnlineInvoiceUrl: true,
  } as const;

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      role: true,
      ageTier: true,
      subscriptions: {
        where: { seasonYear },
        select: subscriptionSelect,
        take: 1,
      },
    },
  });

  const sub = member?.subscriptions[0] ?? null;
  const membershipTypePolicy = await resolveMembershipTypePolicyForMember(prisma, {
    memberId: session.user.id,
    seasonYear,
  });
  // Reports NOT_REQUIRED when the effective booking lockout does not apply:
  // operational roles, membership types that opt out, non-billable age tiers,
  // or Xero/lockout disabled. Raw invoice fields remain available below.
  const subscriptionRequired = await requiresPaidSubscriptionForMemberForBooking(prisma, {
    memberId: session.user.id,
    seasonYear,
    ageTier: member?.ageTier,
  });
  const subscriptionLockoutMode = await resolveSubscriptionLockoutMode();
  const status = sub?.status ?? "NOT_INVOICED";
  const effectiveStatus = subscriptionRequired ? status : "NOT_REQUIRED";
  // "Told them why" (#2533). When the booking lockout applies to this member and
  // their subscription is not paid, surface a plain-English sentence the booking
  // wizard can show — member rates are unavailable while the subscription is
  // unpaid. Null the moment a subscription is not required (lockout off, Xero
  // off, opted-out type, exempt tier) or once it is paid, so it never appears for
  // a member the rule does not touch. The reason is intentionally worded to be
  // true under today's hard-block lockout as well as the decided non-member-rate
  // direction (#2533), so it can be shown now without over-promising a booking.
  const memberRateNotice =
    subscriptionRequired && status !== "PAID"
      ? formatUnpaidSubscriptionRateReason(seasonDisplay)
      : null;
  const effectiveStatusReason = subscriptionRequired
    ? "REQUIRED"
    : // #2149: role carries no subscription exemption. A bare ADMIN/LODGE account
      // resolves (via the role→default-type fallback) to its own NOT_REQUIRED
      // built-in membership type, so it reports MEMBERSHIP_TYPE_NOT_REQUIRED like
      // any other opted-out type — role is no longer a distinct reason.
      membershipTypePolicy?.subscriptionBehavior === "NOT_REQUIRED"
      ? "MEMBERSHIP_TYPE_NOT_REQUIRED"
      : // BASED_ON_AGE_TIER (issue #2041): the type defers to the per-age-tier
        // flag; when the member's tier does not require a subscription (or a
        // NOT_REQUIRED season row dominates), report the age-tier reason so the
        // member sees "not required for your age tier" rather than the generic
        // lockout-disabled bucket.
        membershipTypePolicy?.subscriptionBehavior === "BASED_ON_AGE_TIER"
        ? "MEMBERSHIP_TYPE_AGE_TIER_NOT_REQUIRED"
        : "LOCKOUT_DISABLED_OR_AGE_TIER_NOT_REQUIRED";

  return NextResponse.json({
    status: effectiveStatus,
    rawStatus: status,
    subscriptionRequired,
    effectiveStatusReason,
    seasonDisplay,
    invoiceUrl: subscriptionRequired ? sub?.xeroOnlineInvoiceUrl ?? null : null,
    invoiceNumber: subscriptionRequired ? sub?.xeroInvoiceNumber ?? null : null,
    rawInvoiceUrl: sub?.xeroOnlineInvoiceUrl ?? null,
    rawInvoiceNumber: sub?.xeroInvoiceNumber ?? null,
    membershipTypeKey: membershipTypePolicy?.membershipType.key ?? null,
    membershipTypeName: membershipTypePolicy?.membershipType.name ?? null,
    membershipTypeSubscriptionBehavior:
      membershipTypePolicy?.subscriptionBehavior ?? null,
    memberRateNotice,
    /**
     * #2543 — the club's effective lockout policy, so the member surfaces can
     * say the true thing. Under HARD_BLOCK the banner means "you cannot book";
     * under NON_MEMBER_PRICING it means "you can book, at non-member rates, with
     * a paid-up adult member along". Same underlying facts, different sentence,
     * and the client has no other way to tell them apart.
     */
    subscriptionLockoutMode,
  });
}
