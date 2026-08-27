/**
 * Shared approval-pipeline core for the public non-member booking request flow
 * (src/lib/booking-request.ts, #707) and the SCHOOL group variant
 * (src/lib/school-booking-request.ts, #709).
 *
 * These two pipelines are deliberately separate — they confirm at different
 * booking statuses, invoice differently, and diverge on capacity re-checks — but
 * several regions of their approval transactions are byte-for-byte identical
 * (jscpd, min-tokens 70). Those exact clones live here so a fix to the idempotency
 * guard, the guest-row build + double-book checks, or the owner-substitution admin
 * alert cannot silently land in one pipeline and miss the other (#1529). Regions
 * that only look similar (the substitute/fresh Member creates, whose role and name
 * fields differ; the surrounding logger.warn/logAudit copy) are left in place.
 *
 * Behaviour-preserving: money stays integer cents, booking dates stay NZ
 * date-only, and every extracted region reproduces its original call sequence
 * and arguments exactly.
 */
import {
  AgeTier,
  BookingRequestStatus,
  Prisma,
  type BookingRequest,
} from "@prisma/client";
import { assertNoBookingMemberNightConflicts } from "@/lib/booking-member-night-conflicts";
import { computeMemberGuestBoundary } from "@/lib/booking-guests";
import { sendAdminOwnerSubstitutionAlert } from "@/lib/email";
import {
  planMemberGuestConsentWrites,
  type MemberGuestAddPolicy,
  type MemberGuestConsentGuestFields,
  type MemberGuestConsentWritePlan,
} from "@/lib/member-guest-add-policy";
import type { MemberGuestAddActor } from "@/lib/member-guest-consent";
import logger from "@/lib/logger";
import {
  assertMembershipTypeBookingAllowed,
  resolveGuestRateMembershipTypes,
} from "@/lib/membership-type-policy";
import { getStayNights } from "@/lib/policies/pricing";
import { prisma } from "@/lib/prisma";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import { formatDateOnly } from "@/lib/date-only";

/** A held booking's owner failed re-validation and a fresh contact was
 * substituted at conversion (issue #1255 residual-risk decision 1). */
export type OwnerSubstitution = {
  invalidMemberId: string;
  substituteMemberId: string;
  reason: string;
};

/**
 * One `BookingGuestNight` row about to be written for a pipeline guest (#2739).
 * The same `{ stayDate, priceCents }` pair the canonical direct-create writer
 * (`buildGuestCreateData`, `booking-create-guests.ts`) nests under `nights`.
 */
export type ApprovalGuestNight = {
  stayDate: Date;
  priceCents: number;
};

/**
 * A guest row about to be created (or reassigned in place) on the converted
 * booking. Shared so the guest-build helper and reassignHeldBookingGuests agree
 * on one shape.
 */
export type HeldBookingGuestInput = {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string | null;
  stayStart: Date;
  stayEnd: Date;
  priceCents: number;
  // Rate-membership-type snapshot (#1930, E4, D3): persisted on the guest row
  // so Xero line building reads the resolved type (an admin-linked member of a
  // custom MEMBER_RATE type keeps that type's item code) instead of relying on
  // the NULL-snapshot isMember fallback forever. Snapshot-only — request
  // prices are admin-set totals and stay exactly as stored.
  rateMembershipTypeId?: string | null;
  /**
   * The guest's canonical night set (#2739). REQUIRED, not optional, and that is
   * the whole point of the field: a booking-request booking used to be created
   * with none, so its guests were invisible to every bed-allocation surface —
   * not listed on the board, not placed by the planner, not counted as awaiting
   * a bed — while being real people on a confirmed booking (INV-CAP-032).
   * Optional here would let a fourth pipeline write night-less guests again
   * without saying so.
   */
  nights: ApprovalGuestNight[];
};

/**
 * The night rows for one pipeline guest, from the approved envelope and the
 * price already settled onto that guest (#2739).
 *
 * DATES. `getStayNights` is the pricing engine's own night list and the one the
 * canonical direct-create writer bills from, so a converted booking's rows carry
 * exactly the encoding a directly-created booking's do: NZ date-only values over
 * the HALF-OPEN range `[checkIn, checkOut)` (INV-DATE-003). The check-out
 * morning is not a night, and inventing one there would claim a bed while its
 * real occupant is still in it (INV-DATE-012).
 *
 * MONEY. Two cases, and which one applies is decided by the CALLER, because only
 * the caller knows where the guest's total came from:
 *
 *  - THE ENGINE PRICED THIS GUEST (`perNightCents` supplied). The pricing engine
 *    already resolved a real rate for every night — a season boundary inside the
 *    stay, or a per-night group discount, makes those nights genuinely different
 *    prices — so the true vector is stored verbatim, exactly as the canonical
 *    direct-create writer (`buildGuestCreateData`) stores
 *    `priced.perNightCents[k]`. Re-deriving an even split here would throw away
 *    a number the engine had already computed and misattribute revenue across a
 *    period boundary in the finance reconciliation, which sums night rows inside
 *    a DATE WINDOW.
 *  - AN OFFICER SET A FLAT TOTAL (no `perNightCents`). There is no per-night
 *    truth to store: the number is a negotiated total's share, not a rate — the
 *    distinction #1098 recorded when its backfill skipped these bookings — so
 *    the share is divided across the nights and nothing is re-priced. The
 *    division is to the exact cent with one extra cent on each of the earliest
 *    `remainder` nights, which is deliberately `evenlySplitCents`'s rule in
 *    `xero-booking-invoices.ts`: the vector that file ALREADY synthesises for a
 *    guest carrying no night rows and bills from. So on this path a converted
 *    booking's Xero line items come out byte-identical whether the rows exist or
 *    not, on a fresh invoice and on an invoice-update diff of a backfilled
 *    booking alike. The #1098 backfill's older rule (the whole remainder on the
 *    first night, borrowed from `splitPriceAcrossGuests`, which splits across
 *    GUESTS) totals the same but splits into different Xero lines, which on an
 *    already-raised invoice would read as a change to push.
 *
 * Either way the rows sum to the guest's stored `priceCents` EXACTLY. A supplied
 * vector that does not (wrong length, or a total that disagrees) is refused and
 * the split is used instead — a night set that does not reconcile to the guest's
 * price is worse than a flat one, because invoicing bills from it.
 */
export function buildApprovalGuestNights(params: {
  checkIn: Date;
  checkOut: Date;
  priceCents: number;
  /**
   * The pricing engine's real per-night vector for this guest
   * (`PriceBreakdown.guests[i].perNightCents`), when the engine is what priced
   * them. Omitted when the total is an officer's flat figure.
   */
  perNightCents?: readonly number[];
}): ApprovalGuestNight[] {
  const nightDates = getStayNights(params.checkIn, params.checkOut);
  const count = nightDates.length;
  if (count === 0) return [];
  const engine = params.perNightCents;
  if (
    engine &&
    engine.length === count &&
    engine.every((cents) => Number.isInteger(cents)) &&
    engine.reduce((sum, cents) => sum + cents, 0) === params.priceCents
  ) {
    return nightDates.map((stayDate, index) => ({
      stayDate,
      priceCents: engine[index],
    }));
  }
  const base = Math.floor(params.priceCents / count);
  const remainder = params.priceCents - base * count;
  return nightDates.map((stayDate, index) => ({
    stayDate,
    priceCents: base + (index < remainder ? 1 : 0),
  }));
}

/** Capacity nights that came back oversubscribed, as NZ date-only strings. */
export function getCapacityFullNights(
  nightDetails: Array<{ date: Date; availableBeds: number }>
): string[] {
  return nightDetails
    .filter((night) => night.availableBeds < 0)
    .map((night) => formatDateOnly(night.date));
}

/**
 * Idempotency guard (#1232 double-charge). Under the per-lodge advisory lock —
 * call this AFTER acquireLodgeCapacityLock and BEFORE the status-claim — observe
 * whether a prior approve already converted this request (a concurrent
 * double-accept, or a retry whose caller re-armed the request to PRICED after it
 * had already converted). If so, return the committed booking + owner ids so the
 * caller replays that conversion instead of creating a second booking; when the
 * status had been re-armed away from CONVERTED, re-assert the true terminal
 * status (we hold the lock). Returns null when no prior conversion exists.
 */
export async function claimAlreadyConvertedBookingRequest(
  tx: Prisma.TransactionClient,
  requestId: string
): Promise<{ convertedBookingId: string; convertedMemberId: string } | null> {
  const existing = await tx.bookingRequest.findUnique({
    where: { id: requestId },
    select: { convertedBookingId: true, convertedMemberId: true, status: true },
  });
  if (existing?.convertedBookingId && existing.convertedMemberId) {
    if (existing.status !== BookingRequestStatus.CONVERTED) {
      await tx.bookingRequest.update({
        where: { id: requestId },
        data: { status: BookingRequestStatus.CONVERTED, version: { increment: 1 } },
      });
    }
    return {
      convertedBookingId: existing.convertedBookingId,
      convertedMemberId: existing.convertedMemberId,
    };
  }
  return null;
}

/**
 * Build the converted booking's guest rows from the request guests + the
 * admin-linked member map + the per-guest price split, then run the two
 * pre-write guards both approval pipelines share:
 *   - membership-type booking policy (assertMembershipTypeBookingAllowed)
 *   - admin-mediated double-book prevention across overlapping nights
 *     (assertNoBookingMemberNightConflicts, #1158 / INV-CAP-017),
 *     excluding the held booking's own soon-to-be-deleted guests on the reuse path.
 * Runs inside the caller's approval transaction (tx holds the advisory lock).
 */
export async function buildApprovalGuestCreates(
  tx: Prisma.TransactionClient,
  params: {
    guests: Array<{ firstName: string; lastName: string; ageTier: AgeTier }>;
    linkedMembers: Map<number, string>;
    guestPriceCents: number[];
    /**
     * The pricing engine's per-night vector per guest, parallel to
     * `guestPriceCents` (#2739). Supply it whenever `guestPriceCents` came from
     * the engine (`price.guests.map((g) => g.priceCents)`) so the night rows
     * store the rates the engine really resolved instead of a re-derived flat
     * split; omit it when the total is an officer's flat figure, which has no
     * per-night truth to store. See `buildApprovalGuestNights`.
     */
    guestPerNightCents?: Array<readonly number[] | undefined>;
    checkIn: Date;
    checkOut: Date;
    adminMemberId: string;
    heldBookingId: string | null;
    /**
     * The CLUB's today, encoded at UTC midnight (`INV-DATE-026`), resolved by
     * the caller BEFORE it opened the transaction this function runs in
     * (`INV-CONFIG-002`).
     *
     * REQUIRED, no default. All three callers — the booking-request approval,
     * the school approval and the member whole-lodge approval — invoke this
     * from inside a `prisma.$transaction` that already holds
     * `pg_advisory_xact_lock(1)` and the per-lodge capacity key, and the
     * person-night guard below then takes one transaction-scoped advisory lock
     * per member-linked guest on top. A `clubTimeSettings` read from in here
     * would run on the MODULE client, not this `tx`, and so would need a second
     * pooled connection while all of that is held: `INV-LOCK-004`.
     */
    today: Date;
  }
): Promise<HeldBookingGuestInput[]> {
  const {
    guests,
    linkedMembers,
    guestPriceCents,
    guestPerNightCents,
    checkIn,
    checkOut,
    adminMemberId,
    heldBookingId,
    today,
  } = params;

  const unratedGuestCreates = guests.map((guest, index) => {
    const memberId = linkedMembers.get(index);
    return {
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: Boolean(memberId),
      memberId,
      stayStart: checkIn,
      stayEnd: checkOut,
      priceCents: guestPriceCents[index],
    };
  });
  await assertMembershipTypeBookingAllowed(tx, {
    guests: unratedGuestCreates,
    seasonYear: seasonYearOfStoredDate(checkIn),
    // Finding 2 (privacy re-review of MG3 #2308). Both approval pipelines are
    // admin-only — the converted booking has no member owner yet, which is also
    // why no family boundary could be computed here — so this keeps the detailed
    // refusal an approving officer needs to act on.
    skipAuthorization: true,
  });

  // Persist the rate-membership-type snapshot (#1930, E4, D3) at the same
  // season-year context the policy guard used: an admin-linked member of a
  // custom MEMBER_RATE type records that type; unlinked guests record the
  // built-in NON_MEMBER type. Prices are NOT touched — the admin-set split
  // above stays exactly as stored. rateSource is resolver-internal and is not
  // persisted on the guest row.
  const guestCreates: HeldBookingGuestInput[] = (
    await resolveGuestRateMembershipTypes(tx, {
      seasonYear: seasonYearOfStoredDate(checkIn),
      guests: unratedGuestCreates,
    })
  ).map((guest, index) => ({
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    memberId: guest.memberId,
    stayStart: guest.stayStart,
    stayEnd: guest.stayEnd,
    priceCents: guest.priceCents,
    rateMembershipTypeId: guest.rateMembershipTypeId,
    // #2739. Built from the approved envelope every guest on this pipeline
    // takes (stayStart/stayEnd above are exactly checkIn/checkOut), so the
    // canonical night set and the derived envelope agree night for night. The
    // engine's own per-night vector wins where the caller has one — the index is
    // the guest's, and `resolveGuestRateMembershipTypes` returns the list in the
    // order it was handed, which `guestPriceCents` is already indexed by above.
    nights: buildApprovalGuestNights({
      checkIn,
      checkOut,
      priceCents: guest.priceCents,
      perNightCents: guestPerNightCents?.[index],
    }),
  }));

  // Block admin-mediated double-books: a request whose guests an admin
  // linked to real members must not put a member on overlapping nights
  // (issue #1158, invariant INV-CAP-017). On the reuse path
  // exclude the held booking's own soon-to-be-deleted guests.
  await assertNoBookingMemberNightConflicts(tx, {
    actorMemberId: adminMemberId,
    actorRole: "ADMIN",
    checkIn,
    checkOut,
    guests: guestCreates,
    excludeBookingId: heldBookingId ?? undefined,
    // Supplied from outside this transaction (`INV-LOCK-004`) — see the
    // `today` parameter above.
    today,
  });

  return guestCreates;
}

/**
 * MG4-D-b (#2309): decide the consent columns for a booking-request pipeline
 * guest list, and collect the notifications the caller owes after it commits.
 *
 * WHY THE PIPELINE NEEDS ITS OWN ENTRY POINT AT ALL. The other five guest-write
 * paths reach `planMemberGuestConsentWrites` through
 * `resolveLinkedBookingMembersWithBoundary`, which resolves member records AND
 * computes the family boundary in one call. This pipeline has already resolved
 * its members — an officer picked them by hand at quote time and
 * `assertLinkedMembersExist` validated them — so all it is missing is the
 * boundary. Calling the full resolver here would re-read every member for
 * nothing and would add an eighth entry to a census whose whole purpose is to
 * enumerate the paths that decide whether a beyond-family member may be
 * resolved. This path does not make that decision; the officer already did.
 *
 * THE BOUNDARY IS COMPUTED, NOT ASSUMED, and that is worth a sentence because
 * the shortcut is tempting. A converted booking's owner is normally a non-login
 * contact minted moments earlier, so every linked member is beyond-family by
 * construction and the answer could be hard-coded. But the owner may instead be
 * a mapped Organisation or School contact (#1255) that has existed for years and
 * could share a family group with a linked member — and, more importantly, a
 * hard-coded boundary is not a boundary. It costs two indexed reads.
 *
 * Returns the caller's guests with `memberGuestConsent` attached where it
 * applies. Callers must strip `crossFamilyMemberGuest` (a display marker, not a
 * column) before handing rows to Prisma.
 */
export async function planBookingRequestGuestConsent<
  Guest extends { memberId?: string | null },
>(
  tx: Prisma.TransactionClient,
  params: {
    bookingOwnerMemberId: string;
    guests: readonly Guest[];
    actor: MemberGuestAddActor;
    policy: MemberGuestAddPolicy;
    bookingCheckIn: Date;
    now?: Date;
  }
): Promise<MemberGuestConsentWritePlan<Guest>> {
  if (!params.policy.wideningEnabled) {
    // MODULE OFF — the shipped default (D-2), and the state most clubs stay in
    // forever. `planMemberGuestConsentWrites` already returns the guests
    // untouched in this case, so the two `FamilyGroupMember` reads below would
    // compute a boundary nothing then consults. Skipping them keeps a
    // non-adopting club's approval pipeline byte-for-byte the query sequence it
    // was before MG4 — the same reasoning the owner applied to
    // `markCrossFamilyGuestsOnBooking`'s gate.
    //
    // The call is still made, rather than skipped by the caller, so the module
    // decision lives in one place and the returned shape is identical either
    // way.
    return planMemberGuestConsentWrites({
      guests: params.guests,
      boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
      actor: params.actor,
      now: params.now ?? new Date(),
      bookingCheckIn: params.bookingCheckIn,
      policy: params.policy,
    });
  }

  const boundary = await computeMemberGuestBoundary(
    tx,
    params.bookingOwnerMemberId,
    params.guests
      .map((guest) => guest.memberId)
      .filter((memberId): memberId is string => Boolean(memberId))
  );
  return planMemberGuestConsentWrites({
    guests: params.guests,
    boundary,
    actor: params.actor,
    now: params.now ?? new Date(),
    bookingCheckIn: params.bookingCheckIn,
    policy: params.policy,
  });
}

/**
 * Strip the two MG2 planning fields off a planned guest row, leaving exactly the
 * Prisma-writable shape plus the consent columns — and nest the guest's night
 * set the way Prisma wants it.
 *
 * `crossFamilyMemberGuest` is a D-8 DISPLAY marker that never had a column, and
 * spreading a planned guest straight into `bookingGuest.create` would hand
 * Prisma an unknown field. Doing the strip in one named place means the three
 * pipeline write points cannot each forget it differently.
 *
 * #2739 gives it a second job for the same reason. `HeldBookingGuestInput.nights`
 * is a plain array — `reassignHeldBookingGuests` needs it in a different Prisma
 * shape than a nested create does — so the `nights: { create: [...] }` wrapping
 * the canonical direct-create writer uses (`buildGuestCreateData`) happens here,
 * once, rather than at each write point.
 *
 * `nights` IS REQUIRED HERE, with no `?? []` fallback, and that is the guardrail
 * itself rather than a formality. An optional field would let a fifth pipeline
 * map guests that carry no night set straight through, compile clean, and write
 * an empty create — zero night rows, which is exactly the defect #2739 fixes and
 * is invisible to every mock test, because they assert the args that WERE
 * passed. Required means that pipeline is a TYPE ERROR instead, which is the
 * only thing that makes "a fifth pipeline cannot be added without answering the
 * question" true rather than aspirational. Pinned by the `@ts-expect-error` case
 * in `src/lib/__tests__/booking-request-guest-nights.test.ts`, which fails
 * `npm run typecheck` if the field ever goes back to optional.
 */
export function toPipelineGuestCreateData<Guest extends object>(
  guest: Guest & MemberGuestConsentGuestFields & { nights: readonly ApprovalGuestNight[] }
): Omit<Guest, keyof MemberGuestConsentGuestFields | "nights"> & {
  nights: { create: ApprovalGuestNight[] };
} {
  const { memberGuestConsent, crossFamilyMemberGuest, nights, ...rest } = guest;
  void crossFamilyMemberGuest;
  return {
    ...rest,
    ...(memberGuestConsent ?? {}),
    nights: { create: [...nights] },
  } as unknown as Omit<Guest, keyof MemberGuestConsentGuestFields | "nights"> & {
    nights: { create: ApprovalGuestNight[] };
  };
}

/**
 * The member guests on a booking who HAVE BEEN TOLD they are on it.
 *
 * MG4 (#2309), and it exists because MG4's first cut only ever notified in one
 * direction. A held booking notifies its cross-family member guests the moment
 * the hold is created ("the club has put you on a lodge booking created from
 * X's booking request"), and several perfectly ordinary things then cancel that
 * hold — the requester cancels the quote, an officer declines the request —
 * leaving those members holding an email that has silently stopped being true,
 * and a person-night quietly consumed on a booking that no longer exists.
 *
 * A NON-NULL `consentStatus` IS THE WHOLE TEST, exactly as on the guest-removal
 * path. It means a consent record exists for this row, which means a message
 * about it was composed for this member. A family-scope row (NULL) was never the
 * subject of any message, so releasing it owes nobody an email.
 *
 * Call INSIDE the transaction that cancels the hold, or before it: cancelling
 * does not delete guest rows today, but reading the population first means this
 * cannot start returning an empty set if that ever changes.
 */
export async function collectNotifiedMemberGuestIds(
  db: Prisma.TransactionClient,
  bookingId: string
): Promise<string[]> {
  const rows = await db.bookingGuest.findMany({
    where: { bookingId, memberId: { not: null }, consentStatus: { not: null } },
    select: { memberId: true },
  });
  return [
    ...new Set(rows.map((row) => row.memberId).filter((id): id is string => Boolean(id))),
  ];
}

/**
 * Tell those members the hold has gone — AFTER the commit, and never fatally.
 *
 * `BOOKING_REQUEST_REPLACED` is the right one of the three withdrawal contexts
 * and not merely the closest: its composed sentence is "the club has taken you
 * off a lodge booking created from a booking request", which is true whether the
 * request was cancelled, declined, or re-arranged at approval, and it names
 * nobody — the booking's owner is a non-login contact the reader has never dealt
 * with, so naming them would introduce a stranger.
 *
 * Lazily imported so a club with the module off never pulls the mailer through
 * these paths, and try/caught because the hold is already released by the time
 * this runs: a mail failure must not turn into a failed cancellation.
 */
export async function notifyMemberGuestsHoldReleased(params: {
  bookingId: string;
  targetMemberIds: readonly string[];
  /** Extra fields for the failure log — the request id, typically. */
  logContext?: Record<string, unknown>;
}): Promise<void> {
  if (params.targetMemberIds.length === 0) return;
  const { sendMemberGuestWithdrawnNotifications } = await import(
    "@/lib/member-guest-consent-notifications"
  );
  try {
    await sendMemberGuestWithdrawnNotifications({
      bookingId: params.bookingId,
      targetMemberIds: params.targetMemberIds,
      context: "BOOKING_REQUEST_REPLACED",
    });
  } catch (err) {
    logger.error(
      { err, bookingId: params.bookingId, ...(params.logContext ?? {}) },
      "Failed to dispatch member-guest withdrawal notifications for a released hold"
    );
  }
}

/**
 * Fire-and-forget admin email alert that a held booking's owner was invalid at
 * conversion and a fresh non-login contact was substituted (F20 residual #2 /
 * #1377). Best-effort name lookups run outside the caller's transaction; ids are
 * the source of truth if a name is missing. A failed alert must NOT fail the
 * conversion (the booking is already committed), so it is caught and logged with
 * the caller-supplied message (each pipeline keeps its own log text).
 */
export async function sendOwnerSubstitutionAdminAlert(params: {
  request: Pick<
    BookingRequest,
    | "id"
    | "contactFirstName"
    | "contactLastName"
    | "contactEmail"
    | "checkIn"
    | "checkOut"
  >;
  bookingId: string;
  ownerSubstitution: OwnerSubstitution;
  failureLogMessage: string;
}): Promise<void> {
  const { request, bookingId, ownerSubstitution, failureLogMessage } = params;
  try {
    const [intendedMember, substituteMember] = await Promise.all([
      prisma.member
        .findUnique({
          where: { id: ownerSubstitution.invalidMemberId },
          select: { firstName: true, lastName: true },
        })
        .catch(() => null),
      prisma.member
        .findUnique({
          where: { id: ownerSubstitution.substituteMemberId },
          select: { firstName: true, lastName: true },
        })
        .catch(() => null),
    ]);
    const fullName = (
      member: { firstName?: string | null; lastName?: string | null } | null
    ): string | null => {
      const name = [member?.firstName, member?.lastName]
        .filter((part): part is string => Boolean(part && part.trim()))
        .join(" ")
        .trim();
      return name.length > 0 ? name : null;
    };
    await sendAdminOwnerSubstitutionAlert({
      requestId: request.id,
      bookingId,
      intendedMemberId: ownerSubstitution.invalidMemberId,
      intendedMemberName: fullName(intendedMember),
      substituteMemberId: ownerSubstitution.substituteMemberId,
      substituteMemberName: fullName(substituteMember),
      reason: ownerSubstitution.reason,
      requesterName:
        `${request.contactFirstName} ${request.contactLastName}`.trim(),
      requesterEmail: request.contactEmail,
      checkIn: request.checkIn,
      checkOut: request.checkOut,
    });
  } catch (err) {
    logger.error(
      {
        err,
        bookingRequestId: request.id,
        bookingId,
      },
      failureLogMessage
    );
  }
}
