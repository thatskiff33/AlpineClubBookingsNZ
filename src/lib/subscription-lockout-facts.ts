import type {
  AgeTier,
  MembershipTypeSubscriptionBehavior,
  SubscriptionStatus,
} from "@prisma/client";

import { getAgeTierSettings, type AgeTierSettingData } from "@/lib/age-tier";
import { requiresPaidSubscriptionForAgeTier } from "@/lib/policies/subscription";

/**
 * "Does this member owe an unpaid season subscription?" — computed ONCE, for a
 * whole set of members, in one place (#2543).
 *
 * Before #2543 this question was answered twice with two different bodies of
 * code: `requiresPaidSubscriptionForMemberForBooking` answered it for the
 * BOOKING OWNER (one member, ageTier passed in by the caller) and
 * `findUnpaidMemberGuests` answered it for MEMBER GUESTS (a batch, ageTier read
 * from the Member row). That was survivable while the only consequence was a
 * 403 on both paths. It stops being survivable once the answer decides a PRICE:
 * a party where the owner and a guest are judged by subtly different rules would
 * be invoiced inconsistently, and the difference would be invisible until a
 * member noticed their bill.
 *
 * So this module owns the batch answer, and `findUnpaidMemberGuests` is now a
 * thin presentation layer over it (names, Xero invoice links, the D-8
 * cross-family refusal). The rules encoded here are exactly the ones those two
 * functions already agreed on, kept verbatim:
 *
 *  - a `NOT_REQUIRED` membership type never owes a subscription;
 *  - a `BASED_ON_AGE_TIER` type with a `NOT_REQUIRED` season row never owes one
 *    either — the row is authoritative and dominates a mid-season age promotion
 *    (#2041 decision Q4);
 *  - otherwise the per-age-tier `subscriptionRequiredForBooking` flag decides,
 *    read from the LIVE Member row;
 *  - a member id with no Member row is treated as OWING one. The safe direction:
 *    an id we cannot resolve must not silently price at member rates.
 *
 * It deliberately does NOT consult the club's lockout mode. Whether the club
 * hard-blocks, reprices or ignores an unpaid member is the caller's decision;
 * this module only reports the fact. Keeping the fact and the policy apart is
 * what lets the same numbers drive a 403 on one club and a non-member rate on
 * the next.
 */

/** Structural read seam: `PrismaClient` and a `Prisma.TransactionClient` both fit. */
export interface SubscriptionSettlementDb {
  memberSubscription: {
    findMany(args: {
      where: { memberId: { in: string[] }; seasonYear: number };
      select: { memberId: true; status: true };
    }): Promise<Array<{ memberId: string; status: SubscriptionStatus }>>;
  };
  member: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; ageTier: true };
    }): Promise<Array<{ id: string; ageTier: AgeTier }>>;
  };
}

/**
 * HOW THE AGE-TIER RULE IS READ, when the caller will not accept the cached
 * reader's fallback (#2376 AI Diagnostics).
 *
 * `getAgeTierSettings` below is the default and stays the default: it serves a
 * five-minute in-memory cache and CATCHES every database error to return
 * `AGE_TIER_DEFAULTS`. For a product path that is right — a booking screen with the
 * platform's documented tiers beats a booking screen with an error — and every
 * writer that reaches this module gets exactly that behaviour, unchanged.
 *
 * IT IS WRONG FOR EVIDENCE, and the failure is quiet in the worst way. The per-tier
 * `subscriptionRequiredForBooking` flag decides whether a named member owes a
 * subscription, so a swallowed read turns a club that exempts a tier into a club
 * that does not, and hands a diagnostic a confident financial accusation nobody
 * observed. An evidence caller therefore passes its own reader —
 * `getAgeTierSettingsStrict` bound to its read-only transaction — which REJECTS on a
 * failed read (so the caller reports evidence unavailable), distinguishes a genuinely
 * empty table from an unreadable one, touches no shared cache, and puts this read
 * under the same snapshot and statement timeout as every other read on its graph.
 *
 * A reader rather than a pre-read array on purpose: the settlement batch is reached
 * only inside `NON_MEMBER_PRICING` and only for a non-empty member set, so a caller
 * that handed over DATA would have to read the settings on every invocation
 * including the ones that consult no tier rule — paying for a read the rule does not
 * need and, worse, failing closed on evidence nothing was going to use.
 */
export type AgeTierSettingsReader = () => Promise<AgeTierSettingData[]>;

export interface MemberSubscriptionSettlement {
  /** The season gate says this member owes a paid subscription. */
  subscriptionRequired: boolean;
  /** A PAID season row exists for them. */
  subscriptionPaid: boolean;
}

/**
 * `true` when the member is clear: either nothing was required of them, or they
 * paid. The single predicate the paid-up-adult test and the hosting bridge read,
 * so "settled" can only ever mean one thing.
 */
export function subscriptionIsSettled(
  settlement: MemberSubscriptionSettlement | undefined,
): boolean {
  if (!settlement) {
    // No entry means the member was never asked about — nothing is owed.
    return true;
  }
  return !settlement.subscriptionRequired || settlement.subscriptionPaid;
}

/** The complement: required, and not paid. The class #2543's rule is about. */
export function subscriptionIsUnpaid(
  settlement: MemberSubscriptionSettlement | undefined,
): boolean {
  return settlement !== undefined && !subscriptionIsSettled(settlement);
}

/**
 * THE RULE, as a pure function of one member's already-loaded facts.
 *
 * Both loaders below and `findUnpaidMemberGuests` call this and nothing else, so
 * the owner gate, the member-guest gate and the pricing reprice cannot drift
 * apart no matter how differently they read their rows. Keep every branch here
 * — a caller that "just adds one more condition" at its own call site is the
 * exact failure this function exists to prevent.
 */
export function resolveMemberSubscriptionSettlement(input: {
  /** The member's effective membership-type subscription behaviour, if resolved. */
  subscriptionBehavior: MembershipTypeSubscriptionBehavior | null | undefined;
  /** Their season `MemberSubscription.status`, if a row exists. */
  subscriptionStatus: SubscriptionStatus | null | undefined;
  /**
   * The LIVE `Member.ageTier`, or `null` when no Member row resolved. Null means
   * "owes one": an id we cannot resolve must never silently price at member
   * rates.
   */
  ageTier: AgeTier | null | undefined;
  ageTierSettings: AgeTierSettingData[];
}): MemberSubscriptionSettlement {
  const subscriptionPaid = input.subscriptionStatus === "PAID";

  if (input.subscriptionBehavior === "NOT_REQUIRED") {
    return { subscriptionRequired: false, subscriptionPaid };
  }
  // #2041 decision Q4: a NOT_REQUIRED season row is authoritative for a
  // tier-exempt member and dominates a mid-season age promotion. Scoped to
  // BASED_ON_AGE_TIER so REQUIRED types are byte-unchanged.
  if (
    input.subscriptionBehavior === "BASED_ON_AGE_TIER" &&
    input.subscriptionStatus === "NOT_REQUIRED"
  ) {
    return { subscriptionRequired: false, subscriptionPaid };
  }
  const subscriptionRequired =
    input.ageTier == null ||
    requiresPaidSubscriptionForAgeTier(input.ageTier, input.ageTierSettings);
  return { subscriptionRequired, subscriptionPaid };
}

/**
 * Load the season subscription settlement for a batch of members.
 *
 * Returns an entry for every requested id (de-duplicated); an empty map for an
 * empty request, without touching the database. Callers must have already
 * decided that the subscription regime applies at all — see
 * `resolveSubscriptionLockoutMode`.
 *
 * `subscriptionBehaviorByMember` is a REQUIRED input rather than something this
 * module resolves for itself, and that is a dependency decision, not laziness:
 * the effective membership-type policy lives in `membership-type-policy.ts`,
 * which must import THIS module to reprice, so resolving it here would close an
 * import cycle. Callers hand in the map they already have —
 * `resolveGuestRateMembershipTypes` has literally just built it.
 */
export async function loadMemberSubscriptionSettlements(
  db: SubscriptionSettlementDb,
  params: {
    memberIds: ReadonlyArray<string | null | undefined>;
    seasonYear: number;
    subscriptionBehaviorByMember: ReadonlyMap<
      string,
      MembershipTypeSubscriptionBehavior
    >;
    /**
     * How to read the club's age-tier rule. Omitted by every product caller, which
     * gets the cached, fallback-serving reader exactly as before; supplied by an
     * EVIDENCE caller, which cannot accept a swallowed database failure becoming the
     * club's own tier policy. See `AgeTierSettingsReader`.
     */
    readAgeTierSettings?: AgeTierSettingsReader;
  },
): Promise<Map<string, MemberSubscriptionSettlement>> {
  const memberIds = [
    ...new Set(
      params.memberIds
        .map((id) => id?.trim())
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const settlements = new Map<string, MemberSubscriptionSettlement>();
  if (memberIds.length === 0) return settlements;

  // The default is the cached product reader, called exactly where and as it was
  // called before, so a writer's behaviour is byte-identical.
  const ageTierSettings = await (params.readAgeTierSettings ??
    getAgeTierSettings)();
  const [subscriptions, members] = await Promise.all([
    db.memberSubscription.findMany({
      where: { memberId: { in: memberIds }, seasonYear: params.seasonYear },
      select: { memberId: true, status: true },
    }),
    db.member.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, ageTier: true },
    }),
  ]);

  const subscriptionByMember = new Map(
    subscriptions.map((subscription) => [subscription.memberId, subscription]),
  );
  const memberById = new Map(members.map((member) => [member.id, member]));

  for (const memberId of memberIds) {
    settlements.set(
      memberId,
      resolveMemberSubscriptionSettlement({
        subscriptionBehavior:
          params.subscriptionBehaviorByMember.get(memberId),
        subscriptionStatus: subscriptionByMember.get(memberId)?.status,
        ageTier: memberById.get(memberId)?.ageTier ?? null,
        ageTierSettings,
      }),
    );
  }

  return settlements;
}
