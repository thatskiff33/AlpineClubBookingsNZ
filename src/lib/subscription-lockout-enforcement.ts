import type {
  AgeTier,
  MemberGuestConsentStatus,
  PrismaClient,
} from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import { isOperationallyPresentConsent } from "@/lib/member-guest-consent";
import {
  aggregatePolicyExceptionViolations,
  type AggregatedPolicyExceptions,
  type PaidUpAdultMemberPolicyExceptionViolation,
  type PolicyExceptionViolation,
} from "@/lib/booking-policy-exceptions";
import {
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import type { SubscriptionLockoutMode } from "@/lib/membership-lockout-settings";
import { peekSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import { resolveMembershipTypePoliciesForMembers } from "@/lib/membership-type-policy";
import type { HostingMemberFacts } from "@/lib/policies/adult-member-hosting";
import {
  buildPaidUpAdultMemberViolation,
  evaluatePaidUpAdultPresence,
  formatUnpaidSubscriptionRateReason,
  memberUnpaidSubscriptionForcesNonMemberRate,
  type PaidUpAdultParticipant,
} from "@/lib/policies/subscription-lockout-pricing";
import {
  loadMemberSubscriptionSettlements,
  subscriptionIsSettled,
  subscriptionIsUnpaid,
  type AgeTierSettingsReader,
  type MemberSubscriptionSettlement,
} from "@/lib/subscription-lockout-facts";
import { getSeasonYear } from "@/lib/utils";

/**
 * The ONE place the five booking write paths ask "what does this club's
 * subscription-lockout policy say about this party?" (#2543).
 *
 * The five paths are `POST /api/bookings`, `POST /api/bookings/[id]/confirm-draft`,
 * `POST /api/bookings/[id]/modify-quote`, `POST /api/bookings/[id]/guests`, and
 * the group-booking join in `group-booking.ts`. Each keeps its own
 * already-reviewed HARD_BLOCK refusal (they differ in shape — one returns a
 * `NextResponse`, one throws `ApiError`, one throws `GroupBookingError` — and
 * rewriting four working refusals to share a fifth shape would be churn with
 * risk and no gain). What they must NOT each own is the NEW behaviour, so
 * everything `NON_MEMBER_PRICING` adds lives here and is called identically from
 * all five.
 *
 * Division of labour with the rest of the #2543 stack:
 *
 *  - `member-subscription-eligibility.ts` resolves the club's MODE;
 *  - `subscription-lockout-facts.ts` answers "does this member owe?";
 *  - `policies/subscription-lockout-pricing.ts` is the pure RULE and the
 *    member-facing wording;
 *  - `membership-type-policy.ts` applies the reprice at the single pricing gate;
 *  - THIS module loads the party's live facts and turns the rule into the
 *    refusal, the notice, and the exception-eligible violation.
 *
 * It deliberately performs the paid-up-adult test and nothing about pricing: the
 * price is already guaranteed by the pricing gate, and a second, parallel
 * computation of the same money here is exactly the drift #2543 removes.
 */

/** The narrow client this module needs; a `Prisma.TransactionClient` satisfies it. */
export type SubscriptionLockoutDb = Pick<
  PrismaClient,
  "member" | "memberSubscription" | "seasonalMembershipAssignment" | "membershipType"
>;

/**
 * One participant of the proposed or live party, in the shape every caller can
 * cheaply produce.
 *
 * Nights are optional: `nights` wins when the caller holds per-night rows,
 * otherwise the guest's own `stayStart`/`stayEnd` window, otherwise the booking
 * envelope. Only `affectedNights` on the violation depends on them, so a caller
 * that legitimately has no per-guest detail still gets a correct refusal.
 */
export interface SubscriptionLockoutParticipant {
  /** Pricing-time snapshot. A false `isMember` row is never repriced. */
  isMember: boolean;
  memberId?: string | null;
  /** D-12 operational presence; absent means present, as in #2364. */
  operationallyPresent?: boolean;
  /**
   * NZ date-only lodge nights. A string is accepted (and read as `YYYY-MM-DD`)
   * because the create and group-join paths carry the member's raw request
   * values this far; parsing it here rather than making five callers convert is
   * what keeps them from each inventing their own conversion.
   */
  stayStart?: Date | string | null;
  stayEnd?: Date | string | null;
  nights?: ReadonlyArray<string | Date | { stayDate: string | Date }> | null;
}

export interface NonMemberPricingRequirements {
  /**
   * Members whose own nights this booking prices at the built-in NON_MEMBER
   * rate because their season subscription is required and unpaid. Sorted, so
   * two evaluations of one party produce the same list.
   */
  repricedMemberIds: string[];
  /** At least one paid-up adult member is staying on this booking. */
  hasPaidUpAdultMember: boolean;
  /**
   * Whether the paid-up-adult requirement applies to this party at all.
   *
   * TRUE when the club is in `NON_MEMBER_PRICING` and EITHER this party contains
   * somebody being repriced for an unpaid subscription, OR the booking owner is
   * an unfinancial member — whether or not they are staying. See the `violation`
   * note below for both triggers and why the requirement is still not
   * unconditional.
   */
  paidUpAdultMemberRequired: boolean;
  /**
   * The "told why" sentence to show the member, or null when nobody is
   * repriced. Names no one and no amount — it is rendered straight into booking
   * and quote responses that a family member may be reading.
   *
   * KEYED ON THE REPRICE, not on `paidUpAdultMemberRequired`, and the two are no
   * longer the same question. An unfinancial booking owner who is not staying
   * triggers the requirement without anybody's nights being repriced, and this
   * sentence says that "member rates aren't available for those nights" — which
   * would be a claim about a price nobody was charged. That party gets the
   * refusal (or the quote's early warning) and no rate notice, because there is
   * no rate to explain.
   */
  memberRateNotice: string | null;
  /**
   * The frozen, exception-eligible violation when this party owes a paid-up adult
   * member and has none; null otherwise. A caller that receives one MUST refuse
   * the booking and offer the override-request path.
   *
   * THE REQUIREMENT HAS TWO TRIGGERS, and it is still not unconditional. It fires
   * when somebody STAYING on this party is being repriced for an unpaid
   * subscription, and — owner decision, 3 Aug 2026 — when the BOOKING OWNER is an
   * unfinancial member, whether or not they stay.
   *
   * THE FIRST TRIGGER is the owner's original rule about the unpaid member: "they
   * get charged non-member rates, and there still has to be at least one paid-up
   * adult member on the booking".
   *
   * THE SECOND TRIGGER WAS ADDED DELIBERATELY, over the objection this comment
   * used to record. The objection was that `NON_MEMBER_PRICING` is a RELAXATION of
   * the hard block and must not newly refuse bookings that are legal today, and it
   * is still why the requirement is not applied to every booking: a paid-up Youth
   * member booking their own bed, a family booking whose only member row is a
   * child, and an all-non-member party are all untouched by either trigger. But
   * the reasoning had a hole, and it was the wrong one to leave open. HARD_BLOCK
   * refuses an unfinancial member AS A PERSON — they cannot book at all, even for
   * a party of non-members they will not join. Keyed only on who stays, the
   * relaxed mode let exactly that booking through with no reprice, no requirement
   * and no notice, so switching a club to the softer rule quietly opened the one
   * case the strict rule most reliably closed, and lapsing would have cost a
   * member nothing so long as they booked for others.
   *
   * SO THE REQUIREMENT FOLLOWS THE UNFINANCIAL MEMBER, not only their bed. In that
   * case it is still gentler than HARD_BLOCK rather than stricter: a flat 403
   * becomes a 409 with an override door and the beds held, so a booking a Booking
   * Officer is willing to approve can proceed. An unfinancial owner can never
   * satisfy their own requirement — they fail the money half of
   * `participantIsPaidUpAdultMember` — and a paid-up adult member in the PARTY
   * satisfies it exactly as before, which is what keeps the intended family case
   * working: the financial spouse is on the booking, so it books.
   *
   * "Is there a responsible adult member present?" in the GENERAL case remains the
   * adult-member-hosting policy's question (#2364), which a club configures per
   * lodge and which composes with this one; this stays the narrow
   * financial-integrity guard on the money mode.
   *
   * THE FROZEN VIOLATION SHAPE IS UNCHANGED by the second trigger. `requirements`
   * still carries counts and no identities, and it must keep both counts: the
   * officer's snapshot is hashed from them (`booking-exception-requests.ts` folds
   * `repriced=` and `party=` into the open-state fingerprint), so redacting them
   * here would change which refusals count as "the same hazard".
   *
   * WHAT THE COUNTS DISCLOSE, AND TO WHOM. An owner-triggered refusal reads
   * `repricedUnpaidMemberCount: 0`, so it says the trigger was NOT a member of the
   * party. On ten of the eleven sites that is a fact the recipient already holds,
   * because the unfinancial member IS the recipient: create, quote, confirm-draft,
   * modify-quote, guest-add, the modify apply path and both waitlist confirms all
   * run for the booking's own owner, an admin is exempt from the whole check, and
   * the group-join gate passes the JOINER as the owner of the booking they are
   * making (`group-booking.ts`), not the group booking's owner.
   *
   * THE ELEVENTH SITE IS THE EXCEPTION, and it is why the RESPONSE body is
   * audience-scoped rather than the violation. `removeBookingGuestInTransaction`
   * lets a member take their OWN guest row off somebody else's booking, so there
   * the refusal can be delivered to a member of another family while the trigger
   * is the booking OWNER's unpaid subscription — a member who can see that
   * person's financial standing nowhere else in the app. Pre-#2543-owner-decision
   * the same refusal could only fire with `repricedUnpaidMemberCount >= 1`, i.e.
   * about the party, never about the owner. So `buildPaidUpAdultRefusalBody` takes
   * an `audience`, and the removal path asks for `"OTHER_PARTY_MEMBER"` when the
   * actor does not own the booking, which the route answers with
   * `buildPaidUpAdultRefusalBodyForOtherPartyMember`: same refusal, same override
   * door, without the field that distinguishes the two triggers.
   */
  violation: PaidUpAdultMemberPolicyExceptionViolation | null;
}

/**
 * Who is reading this refusal.
 *
 * `BOOKER` — the member who owns (or is creating) the booking, or an admin. The
 * default, and true on every site but one.
 *
 * `OTHER_PARTY_MEMBER` — somebody who is on the booking but does not own it,
 * reachable only through the single-guest removal path's self-removal arm. See
 * `NonMemberPricingRequirements.violation` for why the distinction exists.
 */
export type PaidUpAdultRefusalAudience = "BOOKER" | "OTHER_PARTY_MEMBER";

/**
 * The refusal a booking path raises when the party has no paid-up adult member.
 *
 * 409, not 403. A 403 says "you may not do this"; this booking IS permitted, by
 * a Booking Officer, through the #2365 exception-request workflow — the state of
 * the party is what conflicts. It also keeps the code out of the
 * `HARD_STOP_BOOKING_FAILURE_CODES` family, which is precisely the set of
 * refusals that may NOT enter exception review.
 */
export class PaidUpAdultMemberRequiredError extends ApiError {
  readonly code = "PAID_UP_ADULT_MEMBER_REQUIRED";
  readonly violation: PaidUpAdultMemberPolicyExceptionViolation;
  readonly exceptionReview: AggregatedPolicyExceptions;
  /**
   * Carried on the error because the SERVICE knows it and the route does not: by
   * the time the route catches this, the booking read that established who owns it
   * has rolled back with the transaction. Defaults to `BOOKER` so every existing
   * throw site keeps its exact body.
   */
  readonly audience: PaidUpAdultRefusalAudience;

  constructor(
    violation: PaidUpAdultMemberPolicyExceptionViolation,
    audience: PaidUpAdultRefusalAudience = "BOOKER",
  ) {
    super(violation.message, 409);
    this.name = "PaidUpAdultMemberRequiredError";
    this.violation = violation;
    this.exceptionReview = aggregatePolicyExceptionViolations([violation]);
    this.audience = audience;
  }
}

/**
 * The response body every path returns for this refusal.
 *
 * Shared so the paths cannot describe the same refusal several ways — and so the
 * member-facing client can rely on `exceptionReview.capacityMode === "HOLD"` to
 * promise that requesting an override keeps the beds.
 *
 * This is the `BOOKER` form. A reader who does not own the booking gets
 * `buildPaidUpAdultRefusalBodyForOtherPartyMember` below instead.
 */
export function buildPaidUpAdultRefusalBody(
  violation: PaidUpAdultMemberPolicyExceptionViolation,
) {
  const exceptionReview = aggregatePolicyExceptionViolations([violation]);
  return {
    error: violation.message,
    code: "PAID_UP_ADULT_MEMBER_REQUIRED" as const,
    details: violation.message,
    violations: exceptionReview.violations,
    exceptionReview,
    /**
     * Where the member goes next. Stated in the payload rather than assumed by
     * the client, because "you were refused but you may ask" is useless advice
     * if the caller cannot find the door.
     */
    exceptionRequestPath: "/api/bookings/exception-requests",
  };
}

/**
 * The same body with ONE field withheld: `requirements.repricedUnpaidMemberCount`.
 *
 * For a refusal delivered to somebody who is on the booking but does not own it —
 * only reachable through single-guest self-removal. That count is what separates
 * the requirement's two triggers, so a `0` tells the reader the trigger was not in
 * the party, i.e. that the booking OWNER's subscription is unpaid. Everything the
 * member acts on is unchanged: the rule (`requiredPaidUpAdultMembers`), the
 * message, the affected nights, the HOLD promise and the exception door.
 *
 * A separate function rather than a flag on the one above, so the shared body keeps
 * its exact type for the ten call sites that use it, and so the narrowing is
 * visible at the site that asks for it. The frozen violation the officer reviews is
 * never touched — this returns copies.
 */
export function buildPaidUpAdultRefusalBodyForOtherPartyMember(
  violation: PaidUpAdultMemberPolicyExceptionViolation,
) {
  const body = buildPaidUpAdultRefusalBody(violation);
  const violations = body.violations.map(withheldTriggerCount);
  return {
    ...body,
    violations,
    exceptionReview: { ...body.exceptionReview, violations },
  };
}

/**
 * Drop `repricedUnpaidMemberCount` from a paid-up-adult violation, leaving every
 * other violation shape alone.
 *
 * Written as an ALLOWLIST rather than as "spread and omit one", so a field added to
 * `requirements` later has to be named here before it reaches a reader who does not
 * own the booking. For a narrowing that exists to withhold something, defaulting to
 * "not disclosed" is the safe direction; a client that needs the new field will fail
 * visibly on this path instead of the field leaking silently.
 */
function withheldTriggerCount(violation: PolicyExceptionViolation) {
  if (violation.reasonCode !== "PAID_UP_ADULT_MEMBER_REQUIRED") return violation;
  const { kind, requiredPaidUpAdultMembers, participantCount } =
    violation.requirements;
  return {
    ...violation,
    requirements: { kind, requiredPaidUpAdultMembers, participantCount },
  };
}

/**
 * Turn persisted `BookingGuest` rows (or anything shaped like them) into
 * participants.
 *
 * The one thing worth centralising: a member guest whose invite is still
 * PENDING is NOT operationally present (D-12), so they cannot be the party's
 * paid-up adult — the kiosk, the arrival roster and bed allocation all already
 * leave them out, and a "responsible adult" who may never turn up is not one.
 *
 * THE COLUMN IS `consentStatus`, and naming it correctly is the whole guard.
 * This helper originally read `memberGuestConsentStatus`, a name that exists
 * nowhere in the schema (the Prisma column is `BookingGuest.consentStatus`, and
 * every other consumer reads that — `adult-member-hosting-review.ts`,
 * `admin-bed-allocation.ts`, `double-bed-sharing.ts`). Because the constraint
 * property was optional, `BookingGuest[]` still type-checked, every persisted row
 * read `undefined`, `isOperationallyPresentConsent(undefined)` returned true, and
 * the D-12 half of the paid-up-adult test never ran on a real party: a PENDING
 * cross-family invite could satisfy the requirement and then expire, leaving a
 * confirmed booking with no paid-up adult member on it and nothing to re-check.
 *
 * A PRE-PERSIST PARTY carries the same fact under a different name. The create
 * and guest-add paths hold `memberGuestConsent` — the write
 * `planMemberGuestConsentWrites` is about to make, carrying the PENDING status it
 * will store — so both shapes are read here rather than left to five callers to
 * remember. Absent under BOTH names means present, exactly as #2364 does: a
 * family-scope guest legitimately has no consent row.
 */
export function toSubscriptionLockoutParticipants<
  Guest extends {
    isMember: boolean;
    memberId?: string | null;
    // A string is accepted because the create path carries the member's raw
    // request values this far; `participantNights` parses either.
    stayStart?: Date | string | null;
    stayEnd?: Date | string | null;
    consentStatus?: MemberGuestConsentStatus | null;
    memberGuestConsent?: {
      consentStatus?: MemberGuestConsentStatus | null;
    } | null;
    nights?: ReadonlyArray<string | Date | { stayDate: string | Date }> | null;
  },
>(guests: ReadonlyArray<Guest>): SubscriptionLockoutParticipant[] {
  return guests.map((guest) => ({
    isMember: guest.isMember,
    memberId: guest.memberId ?? null,
    stayStart: guest.stayStart ?? null,
    stayEnd: guest.stayEnd ?? null,
    nights: guest.nights ?? null,
    operationallyPresent: isOperationallyPresentConsent(
      guest.consentStatus ?? guest.memberGuestConsent?.consentStatus ?? null,
    ),
  }));
}

/** Accept the date-only shapes the five paths already carry; reject nothing. */
function toDateOnly(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const parsed = parseDateOnly(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function participantNights(
  participant: SubscriptionLockoutParticipant,
  checkIn: Date,
  checkOut: Date,
): string[] {
  if (participant.nights && participant.nights.length > 0) {
    return participant.nights.map((entry) => {
      if (typeof entry === "string") return entry.slice(0, 10);
      if (entry instanceof Date) return formatDateOnly(entry);
      const stayDate = entry.stayDate;
      return typeof stayDate === "string"
        ? stayDate.slice(0, 10)
        : formatDateOnly(stayDate);
    });
  }
  const start = toDateOnly(participant.stayStart) ?? checkIn;
  const endExclusive = toDateOnly(participant.stayEnd) ?? checkOut;
  // A zero- or negative-width range yields no nights rather than throwing; the
  // booking's own date validation owns that refusal.
  if (endExclusive <= start) return [];
  return eachDateOnlyInRange(start, endExclusive).map(formatDateOnly);
}

type LiveMemberFacts = HostingMemberFacts & { ageTier: AgeTier };

/**
 * Evaluate everything `NON_MEMBER_PRICING` adds, for one party.
 *
 * Returns `null` — cheaply, before any query — when the club is not in
 * `NON_MEMBER_PRICING`. Every caller treats a `null` as "nothing new applies",
 * which is what keeps HARD_BLOCK and NO_BLOCK byte-identical to pre-#2543.
 *
 * `mode` may be passed by a caller that has already resolved it (all five write
 * paths have, to decide whether to run their HARD_BLOCK refusal), so the party
 * is judged against exactly the mode the gate branched on. Resolving it twice
 * inside one request would let an admin's mid-request settings change refuse
 * under one regime and price under the other.
 *
 * `bookingOwnerMemberId` is the second half of the requirement's trigger, and
 * every write path passes it: the requirement follows an unfinancial member
 * whether or not they take a bed. See `NonMemberPricingRequirements.violation`.
 */
export async function evaluateNonMemberPricingRequirements(
  db: SubscriptionLockoutDb,
  input: {
    mode?: SubscriptionLockoutMode;
    lodgeId: string;
    seasonYear: number;
    checkIn: Date;
    checkOut: Date;
    participants: ReadonlyArray<SubscriptionLockoutParticipant>;
    /**
     * The booking OWNER's member id, when the booking has one (owner decision,
     * 3 Aug 2026 — see `NonMemberPricingRequirements.violation`).
     *
     * Judged by exactly the same owing test as every party member: it joins the
     * one settlement batch below, so the answer comes from
     * `resolveMemberSubscriptionSettlement` and never from a second copy of the
     * rule at a call site.
     *
     * Callers pass it whether or not the owner is staying. When they ARE staying
     * their own guest row already reprices them and this adds nothing; it is the
     * NOT-staying case the arm exists for, and a caller cannot tell the two apart
     * without doing the comparison that happens here.
     *
     * Omitted, null or blank means "no owner to judge", and the evaluation is
     * exactly the party-only one.
     */
    bookingOwnerMemberId?: string | null;
    /**
     * How the club's age-tier rule is read for the settlement batch below. Omitted
     * by every write path, which takes the cached product reader unchanged;
     * supplied by a read-only EVIDENCE caller, whose strict reader rejects a failed
     * settings read instead of letting `AGE_TIER_DEFAULTS` stand in for the club's
     * own tier policy. See `AgeTierSettingsReader`.
     */
    readAgeTierSettings?: AgeTierSettingsReader;
  },
): Promise<NonMemberPricingRequirements | null> {
  const mode = input.mode ?? (await peekSubscriptionLockoutMode());
  if (mode !== "NON_MEMBER_PRICING") return null;

  const partyMemberIds = [
    ...new Set(
      input.participants
        .filter((participant) => participant.isMember)
        .map((participant) => participant.memberId?.trim())
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const bookingOwnerMemberId = input.bookingOwnerMemberId?.trim() || null;
  /**
   * The party PLUS the owner, for the facts batch only.
   *
   * One batch rather than a second read, so the owner and the party cannot be
   * judged by two settlements that disagree. Kept SEPARATE from
   * `partyMemberIds` because the reprice list below must stay a statement about
   * nights this booking actually prices: an owner who is not staying holds no
   * nights, so counting them as repriced would inflate the violation's count and
   * emit a rate notice about a charge nobody received.
   */
  const settlementMemberIds =
    bookingOwnerMemberId && !partyMemberIds.includes(bookingOwnerMemberId)
      ? [...partyMemberIds, bookingOwnerMemberId]
      : partyMemberIds;

  const policies = await resolveMembershipTypePoliciesForMembers(db, {
    memberIds: settlementMemberIds,
    seasonYear: input.seasonYear,
  });
  // Live standing facts for the PARTY only: the presence test judges who is on
  // the booking, and an owner who is not staying is not one of them (nor could
  // they satisfy the requirement if they were — they are unfinancial).
  const members: LiveMemberFacts[] = partyMemberIds.length
    ? await db.member.findMany({
        where: { id: { in: partyMemberIds } },
        select: {
          id: true,
          ageTier: true,
          active: true,
          cancelledAt: true,
          archivedAt: true,
        },
      })
    : [];
  const memberById = new Map<string, LiveMemberFacts>(
    members.map((member) => [member.id, member]),
  );

  const settlements = await loadMemberSubscriptionSettlements(db, {
    memberIds: settlementMemberIds,
    seasonYear: input.seasonYear,
    subscriptionBehaviorByMember: new Map(
      [...policies].map(([memberId, policy]) => [
        memberId,
        policy.subscriptionBehavior,
      ]),
    ),
    ...(input.readAgeTierSettings
      ? { readAgeTierSettings: input.readAgeTierSettings }
      : {}),
  });

  const settlementFor = (
    memberId: string,
  ): MemberSubscriptionSettlement | undefined => settlements.get(memberId);

  const repricedMemberIds = partyMemberIds
    .filter((memberId) =>
      memberUnpaidSubscriptionForcesNonMemberRate({
        isMember: true,
        subscriptionRequired:
          settlementFor(memberId)?.subscriptionRequired ?? false,
        subscriptionPaid: settlementFor(memberId)?.subscriptionPaid ?? false,
      }),
    )
    .sort();

  const paidUpParticipants: PaidUpAdultParticipant[] = input.participants.map(
    (participant) => {
      const memberId = participant.isMember
        ? participant.memberId?.trim() || null
        : null;
      return {
        member: memberId ? (memberById.get(memberId) ?? null) : null,
        operationallyPresent: participant.operationallyPresent,
        // A non-member (or an unresolvable member link) is already excluded by
        // `member: null` inside the predicate; `false` is the safe filler for a
        // fact nobody asked about, and stays safe if the predicate is ever
        // reordered.
        subscriptionSettled: memberId
          ? subscriptionIsSettled(settlementFor(memberId))
          : false,
      };
    },
  );

  const presence = evaluatePaidUpAdultPresence(paidUpParticipants);

  /**
   * The owner arm (owner decision, 3 Aug 2026 — see
   * `NonMemberPricingRequirements.violation`).
   *
   * `subscriptionIsUnpaid` is the named complement of the ONE predicate the
   * reprice above and the #2364 hosting bridge below both read, so the owner is
   * judged by the same rule as everybody else — including its two edges, and both
   * are deliberate:
   *
   *  - NO SETTLEMENT ENTRY answers false. Unreachable, since the owner is put into
   *    the batch above, and the right direction if it ever were reached: a member
   *    the batch never answered about must not manufacture a refusal.
   *  - AN OWNER ID WITH NO MEMBER ROW answers true, because
   *    `resolveMemberSubscriptionSettlement` treats a null age tier as owing. That
   *    is the same safe-direction-on-money rule the reprice arm applies to an
   *    unresolvable participant, so the two cannot disagree. It is only reachable
   *    through a deleted-member race on a foreign key, and it fails closed onto a
   *    409 with the override door rather than a wall.
   */
  const bookingOwnerUnfinancial =
    bookingOwnerMemberId !== null &&
    subscriptionIsUnpaid(settlementFor(bookingOwnerMemberId));

  // Two triggers, and the second is why an unfinancial member can no longer
  // anchor a booking they simply keep themselves off — see
  // `NonMemberPricingRequirements.violation`.
  const paidUpAdultMemberRequired =
    repricedMemberIds.length > 0 || bookingOwnerUnfinancial;
  const violated = paidUpAdultMemberRequired && !presence.hasPaidUpAdult;

  const partyNights = violated
    ? [
        ...new Set(
          input.participants.flatMap((participant) =>
            participantNights(participant, input.checkIn, input.checkOut),
          ),
        ),
      ].sort()
    : [];
  /**
   * A violation must name the nights it holds, so an empty party set falls back
   * to the booking envelope.
   *
   * Unreachable on the old repriced-only trigger — a reprice implies a member
   * participant, and a participant with no resolvable nights implies a degenerate
   * stay window the booking's own date validation refuses. It becomes reachable
   * with the owner arm, which can fire on a party the caller describes without
   * per-guest ranges, and a HOLD over zero nights would reserve nothing while
   * promising the member their beds.
   */
  const affectedNights =
    violated && partyNights.length === 0 && input.checkOut > input.checkIn
      ? eachDateOnlyInRange(input.checkIn, input.checkOut).map(formatDateOnly)
      : partyNights;

  return {
    repricedMemberIds,
    hasPaidUpAdultMember: presence.hasPaidUpAdult,
    paidUpAdultMemberRequired,
    memberRateNotice:
      repricedMemberIds.length > 0
        ? formatUnpaidSubscriptionRateReason(
            `${input.seasonYear}/${input.seasonYear + 1}`,
          )
        : null,
    violation: violated
      ? buildPaidUpAdultMemberViolation({
          affectedNights,
          effectiveLodgeId: input.lodgeId,
          repricedUnpaidMemberCount: repricedMemberIds.length,
          participantCount: input.participants.length,
        })
      : null,
  };
}

/**
 * The proposed-party form of the same rule, for the #2365 exception-request
 * machinery.
 *
 * Mirrors `evaluateProposedAdultMemberHosting` deliberately, down to the guest
 * shape, so a member who is refused by a booking path and then submits the same
 * party as an override request gets the SAME answer from the SAME rule. Returns
 * null when the club is not in `NON_MEMBER_PRICING`, or when the party already
 * has a paid-up adult member — in which case there is nothing to review and the
 * request machinery correctly refuses to create one.
 */
export async function evaluateProposedPaidUpAdultPresence(
  db: SubscriptionLockoutDb,
  input: {
    lodgeId: string;
    checkIn: Date;
    checkOut: Date;
    guests: ReadonlyArray<{
      isMember: boolean;
      memberId?: string | null;
      nights?: ReadonlyArray<string | Date | { stayDate: string | Date }> | null;
      /**
       * D-12 operational presence, resolved by the caller (absent means present).
       *
       * Load-bearing for the door this function exists to open. A member refused
       * by a booking path — where a PENDING cross-family invite is correctly
       * excluded — must reproduce the SAME violation here, or the request
       * machinery finds nothing to review, refuses to create a request, and the
       * 409's promised override path leads nowhere. The caller resolves it
       * because only the caller knows whether a proposed guest is a live
       * CONFIRMED row or somebody who would be invited PENDING.
       */
      operationallyPresent?: boolean;
    }>;
    /**
     * Who would OWN the booking this proposal describes (owner decision, 3 Aug
     * 2026). Load-bearing for the same reason `operationallyPresent` is: a
     * booking path that refuses an unfinancial member for a party they are not
     * staying on must reproduce that violation here, or the 409 names a workflow
     * the member cannot enter. The caller resolves it, because only the caller
     * knows whether the proposal is a new booking (the requester owns it) or a
     * modification (the live booking's own owner does).
     */
    bookingOwnerMemberId?: string | null;
    /**
     * The membership season these nights fall in, when the caller has already
     * resolved it AUTHORITATIVELY.
     *
     * Omit it and the season comes from `getSeasonYear`, which reads the
     * process-level financial-year cache in `financial-year.ts`. Every product
     * caller of this function is a booking write behind a gated request that has
     * seeded that cache, so omitting it is correct for them and this parameter
     * changes nothing about their answer.
     *
     * A READ-ONLY EVIDENCE caller cannot rely on that. Nothing on a diagnostics
     * path calls `refreshFinancialYearConfig`, so on a cold process the cache is
     * still the March default and a club with any other year-end month would be
     * judged in the WRONG SEASON — reporting a paid-up member as unfinancial
     * (or the reverse) from a season row that is not theirs. Such a caller
     * resolves the year-end month from stored state itself, refuses when it
     * cannot, and passes the season here so the answer never depends on whatever
     * happened to warm the cache. Same shape and same reason as
     * `resolveMembershipTypePolicy`'s own `seasonYear` input.
     */
    seasonYear?: number;
    /**
     * The club's lockout mode, when the caller has already read it.
     *
     * Omitted, `evaluateNonMemberPricingRequirements` peeks it -- through readers
     * that swallow a database failure into "every optional module off", i.e. into
     * `NO_BLOCK`. For a booking write that is a safe direction to fail. For a
     * read-only EVIDENCE caller it is a fabricated answer about the club's own
     * policy, and the mode is the qualifier on every subscription finding such a
     * caller reports, so it reads the mode strictly itself and passes it here.
     */
    mode?: SubscriptionLockoutMode;
    /**
     * How the age-tier rule is read. Same split as `mode` and `seasonYear`: a
     * writer takes the cached reader, an evidence caller passes a strict one bound
     * to its own transaction. See `AgeTierSettingsReader`.
     */
    readAgeTierSettings?: AgeTierSettingsReader;
  },
): Promise<PaidUpAdultMemberPolicyExceptionViolation | null> {
  const requirements = await evaluateNonMemberPricingRequirements(db, {
    mode: input.mode,
    ...(input.readAgeTierSettings
      ? { readAgeTierSettings: input.readAgeTierSettings }
      : {}),
    lodgeId: input.lodgeId,
    seasonYear: input.seasonYear ?? getSeasonYear(input.checkIn),
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    bookingOwnerMemberId: input.bookingOwnerMemberId ?? null,
    participants: input.guests.map((guest) => ({
      isMember: guest.isMember,
      memberId: guest.memberId ?? null,
      nights: guest.nights ?? null,
      operationallyPresent: guest.operationallyPresent,
    })),
  });
  return requirements?.violation ?? null;
}

/**
 * Which of these members the club is currently repricing as non-members, for
 * the hosting bridge (#2543 ↔ #2364).
 *
 * Returns an EMPTY set outside `NON_MEMBER_PRICING`, so the hosting evaluator's
 * `subscriptionSettled` stays absent — and therefore its answer byte-identical —
 * for every club that has not opted in.
 */
export async function loadUnpaidSubscriptionMemberIds(
  db: SubscriptionLockoutDb,
  params: {
    memberIds: ReadonlyArray<string | null | undefined>;
    seasonYear: number;
    mode?: SubscriptionLockoutMode;
    /** See `AgeTierSettingsReader`; supplied only by a read-only evidence caller. */
    readAgeTierSettings?: AgeTierSettingsReader;
  },
): Promise<ReadonlySet<string>> {
  const empty: ReadonlySet<string> = new Set<string>();
  const memberIds = [
    ...new Set(
      params.memberIds
        .map((id) => id?.trim())
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (memberIds.length === 0) return empty;

  const mode = params.mode ?? (await peekSubscriptionLockoutMode());
  if (mode !== "NON_MEMBER_PRICING") return empty;

  const policies = await resolveMembershipTypePoliciesForMembers(db, {
    memberIds,
    seasonYear: params.seasonYear,
  });
  const settlements = await loadMemberSubscriptionSettlements(db, {
    memberIds,
    seasonYear: params.seasonYear,
    subscriptionBehaviorByMember: new Map(
      [...policies].map(([memberId, policy]) => [
        memberId,
        policy.subscriptionBehavior,
      ]),
    ),
    ...(params.readAgeTierSettings
      ? { readAgeTierSettings: params.readAgeTierSettings }
      : {}),
  });

  const unpaid = new Set<string>();
  for (const memberId of memberIds) {
    if (!subscriptionIsSettled(settlements.get(memberId))) {
      unpaid.add(memberId);
    }
  }
  return unpaid;
}
