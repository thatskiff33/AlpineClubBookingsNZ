import type {
  AgeTier,
  MembershipTypeSubscriptionBehavior,
  SubscriptionStatus,
} from "@prisma/client";

import { getAgeTierSettings, type AgeTierSettingData } from "@/lib/age-tier";
import {
  MEMBERSHIP_LOCKOUT_SETTINGS_ID,
  loadMembershipLockoutSettingsStrict,
  normalizeMembershipLockoutSettings,
} from "@/lib/membership-lockout-settings";
import {
  NOT_CHOSEN_LIABILITY_SETTINGS,
  liabilityRuleFor,
  resolveMemberSubscriptionLiability,
  type SubscriptionLiabilitySettings,
} from "@/lib/policies/subscription";

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
 * cross-family refusal). Whether a member owes one at all is the ONE liability
 * rule billing also reads (`resolveMemberSubscriptionLiability`, #5190,
 * `INV-LOCKOUT-020`), on the access side of the club's settings:
 *
 *  - a `NOT_REQUIRED` membership type never owes a subscription;
 *  - while the club has not chosen its rule (`NOT_CHOSEN`, every club on
 *    upgrade), the pre-#5190 access rule holds exactly: a `BASED_ON_AGE_TIER`
 *    type with a `NOT_REQUIRED` season row never owes one (#2041 decision Q4),
 *    and otherwise the per-age-tier `subscriptionRequiredForBooking` flag
 *    decides from the STORED `Member.ageTier`, for a `REQUIRED` type too;
 *  - once chosen, the club's pair decides exactly as it does for billing, and
 *    the season row exempts nobody (Edge 2, owner decision 18 Nov 2026);
 *  - a member id with no Member row is treated as OWING one. The safe direction:
 *    an id we cannot resolve must not silently price at member rates.
 *
 * And whether one they owe is SETTLED: a `PAID` row, or an active coverage
 * claim on a `NO_INVOICE` charge (#5190). A no-invoice fee never sends an
 * invoice, so its member could never reach PAID; the claim, not the row status
 * (which the Xero sync may rewrite), is what proves they are covered.
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
      select: {
        memberId: true;
        status: true;
        chargeCoverage: typeof ACTIVE_NO_INVOICE_COVERAGE;
      };
    }): Promise<
      Array<{
        memberId: string;
        status: SubscriptionStatus;
        chargeCoverage: Array<{ id: string }>;
      }>
    >;
  };
  member: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; ageTier: true; dateOfBirth: true };
    }): Promise<Array<{ id: string; ageTier: AgeTier; dateOfBirth: Date | null }>>;
  };
  /**
   * The club's liability rule (#5190), read on the CALLER'S client: inside a
   * booking transaction that is the transaction's own connection and snapshot,
   * never a second pool connection. Optional only so narrow test doubles fit;
   * every Prisma client has it, and a client without it reads NOT_CHOSEN.
   */
  membershipLockoutSettings?: {
    findUnique(args: {
      where: { id: string };
      select: { requiredTypeAgeRule: true; liabilityAgeSource: true };
    }): Promise<{ requiredTypeAgeRule: string; liabilityAgeSource: string } | null>;
  };
}

/**
 * The coverage that settles a member without a payment: an ACTIVE claim
 * (`releasedAt` null, the #2147 "already billed" rule) on a `NO_INVOICE` charge.
 * One select, shared by every reader that decides "settled" (#5190).
 */
export const ACTIVE_NO_INVOICE_COVERAGE = {
  where: { releasedAt: null, charge: { billingBasis: "NO_INVOICE" } },
  take: 1,
  select: { id: true },
} as const;

/** Whether a season row read with {@link ACTIVE_NO_INVOICE_COVERAGE} carries a claim. */
export function hasActiveNoInvoiceCoverage(
  row: { chargeCoverage?: ReadonlyArray<unknown> } | null | undefined,
): boolean {
  return (row?.chargeCoverage?.length ?? 0) > 0;
}

/**
 * The club's liability settings, through the caller's client. A missing row is
 * NOT_CHOSEN; a failed read REJECTS, so neither a booking gate nor an evidence
 * path can judge an opted-in club by the default rule. A client with no
 * `membershipLockoutSettings` delegate (only a narrow test double: every Prisma
 * client has one) makes no read, so it reads NOT_CHOSEN rather than rejecting.
 */
export async function readSubscriptionLiabilitySettings(
  db: Pick<SubscriptionSettlementDb, "membershipLockoutSettings">,
): Promise<SubscriptionLiabilitySettings> {
  if (!db.membershipLockoutSettings) return NOT_CHOSEN_LIABILITY_SETTINGS;
  const row = await db.membershipLockoutSettings.findUnique({
    where: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID },
    select: { requiredTypeAgeRule: true, liabilityAgeSource: true },
  });
  const { requiredTypeAgeRule, liabilityAgeSource } =
    normalizeMembershipLockoutSettings(row);
  return { requiredTypeAgeRule, liabilityAgeSource };
}

/**
 * Whether one member owes a subscription on the access side of the liability
 * rule, reading the club's settings and age tiers itself (#5190). For the Xero
 * sync (`checkMembershipStatus`), which judges one member outside any booking
 * transaction: while the club has not chosen its rule that is the pre-#5190 sync
 * rule exactly — a `BASED_ON_AGE_TIER` member whose season row is already
 * `NOT_REQUIRED` stays not required (#2041 dominance, so a mid-season tier
 * promotion cannot re-mint an invoice), and otherwise the stored tier decides.
 * Once chosen, the club's pair decides and the row exempts nobody. The
 * settings read is strict: a failed read rejects rather than falling back to
 * NOT_CHOSEN, because the sync persists its answer as the season row.
 */
export async function owesSubscriptionForAccess(
  input: Omit<
    Parameters<typeof resolveMemberSubscriptionLiability>[0],
    "rule" | "ageTierSettings"
  >,
): Promise<boolean> {
  const [lockoutSettings, ageTierSettings] = await Promise.all([
    loadMembershipLockoutSettingsStrict(),
    getAgeTierSettings(),
  ]);
  return resolveMemberSubscriptionLiability({
    ...input,
    rule: liabilityRuleFor("access", lockoutSettings),
    ageTierSettings,
  }).owes;
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
  /**
   * The season gate says this member owes a paid subscription: the liability
   * rule says they owe one, and no no-invoice fee already covers it (#5190).
   */
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
 * apart no matter how differently they read their rows. Liability itself is
 * `resolveMemberSubscriptionLiability`, the rule billing shares (#5190); keep
 * every branch there or here — a caller that "just adds one more condition" at
 * its own call site is the exact failure this function exists to prevent.
 */
export function resolveMemberSubscriptionSettlement(input: {
  /** The member's effective membership-type subscription behaviour, if resolved. */
  subscriptionBehavior: MembershipTypeSubscriptionBehavior | null | undefined;
  /** Their season `MemberSubscription.status`, if a row exists. */
  subscriptionStatus: SubscriptionStatus | null | undefined;
  /** An active coverage claim on a `NO_INVOICE` charge settles them (#5190). */
  coveredByNoInvoiceCharge: boolean;
  /**
   * The LIVE Member row's tier and date of birth, or `null` when no Member row
   * resolved. Null means "owes one": an id we cannot resolve must never
   * silently price at member rates.
   */
  member: { dateOfBirth: Date | null; ageTier: AgeTier } | null | undefined;
  seasonYear: number;
  ageTierSettings: AgeTierSettingData[];
  liabilitySettings: SubscriptionLiabilitySettings;
}): MemberSubscriptionSettlement {
  const { owes } = resolveMemberSubscriptionLiability({
    subscriptionBehavior: input.subscriptionBehavior,
    member: input.member,
    seasonRowStatus: input.subscriptionStatus,
    seasonYear: input.seasonYear,
    rule: liabilityRuleFor("access", input.liabilitySettings),
    ageTierSettings: input.ageTierSettings,
  });
  // A no-invoice fee settles the member without a payment: nothing is left for
  // them to pay, so no paid subscription is required of them (#5190).
  return {
    subscriptionRequired: owes && !input.coveredByNoInvoiceCharge,
    subscriptionPaid: input.subscriptionStatus === "PAID",
  };
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
    /**
     * The club's liability settings when the caller already holds them (#5190);
     * otherwise read once through `db` (see `readSubscriptionLiabilitySettings`).
     */
    liabilitySettings?: SubscriptionLiabilitySettings;
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
  const [liabilitySettings, subscriptions, members] = await Promise.all([
    params.liabilitySettings ?? readSubscriptionLiabilitySettings(db),
    db.memberSubscription.findMany({
      where: { memberId: { in: memberIds }, seasonYear: params.seasonYear },
      select: {
        memberId: true,
        status: true,
        chargeCoverage: ACTIVE_NO_INVOICE_COVERAGE,
      },
    }),
    db.member.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, ageTier: true, dateOfBirth: true },
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
        coveredByNoInvoiceCharge: hasActiveNoInvoiceCoverage(
          subscriptionByMember.get(memberId),
        ),
        member: memberById.get(memberId) ?? null,
        seasonYear: params.seasonYear,
        ageTierSettings,
        liabilitySettings,
      }),
    );
  }

  return settlements;
}
