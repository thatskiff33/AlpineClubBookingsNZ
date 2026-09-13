import type { AgeTier, Prisma, PrismaClient } from "@prisma/client";
import {
  formatMemberProfileMissingField,
  getMemberProfileCompleteness,
  type MemberProfileCompletenessResult,
} from "@/lib/member-profile-completeness";
import {
  type MemberGuestBoundaryScope,
  type MemberGuestBoundaryState,
} from "@/lib/member-guest-consent";
import {
  MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
  MEMBER_GUEST_CROSS_FAMILY_REFUSAL_STATUS,
  MEMBER_GUEST_NOT_ADDABLE_CODE,
} from "@/lib/member-guest-refusal";

export type BookingGuestPricingInput = {
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
  stayStart?: Date | string | null;
  stayEnd?: Date | string | null;
  // Explicit included nights (issue #713). When present, the guest stays
  // exactly these nights; stayStart/stayEnd become the derived envelope.
  nights?: ReadonlyArray<Date | string> | null;
};

export type BookingGuestInput = BookingGuestPricingInput & {
  firstName: string;
  lastName: string;
};

type BookingGuestAgeTierSource = {
  ageTier: AgeTier;
  member?: { ageTier: AgeTier } | null;
};

export type BookingGuestLookupDb =
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
  accessRoles?: Array<{ role: string | null }>;
  profileCompletedAt?: Date | null;
  detailsConfirmedAt?: Date | null;
  detailsConfirmedByMemberId?: string | null;
  onboardingConfirmedAt?: Date | null;
};

export class BookingGuestValidationError extends Error {
  /**
   * The beyond-family members this refusal was about, when it is one of D-8's
   * COLLAPSED cross-family refusals (#2388, MG3 #2308) — otherwise undefined.
   *
   * It rides on the error rather than being recomputed by each route because the
   * refusal is thrown from three different depths (member resolution, the profile
   * gate, and the callers' own subscription and person-night checks) and only the
   * thrower knows which target it was about. A route that had to work it out
   * again would either duplicate the family-boundary computation or guess — and
   * guessing wrong writes an audit row naming the wrong member.
   *
   * Presence of this field is also what tells a route "this was a collapsed
   * cross-family refusal", which is what triggers the audit row, the throttle
   * accounting and the response-timing floor. An ordinary validation error
   * carries none of that machinery.
   */
  public crossFamilyMemberIds?: readonly string[];

  /**
   * A machine code for a refusal whose MESSAGE must not change but whose
   * member-facing wording has to (MG3 #2308, correctness review MEDIUM-4).
   *
   * The widening refusal is the case: MG1/MG2 pin its text byte-for-byte, so a
   * club that has not opted in sees exactly the refusal it always saw and no
   * error text anywhere mentions member guests. That text is developer-facing
   * ("Invalid guest member reference"), and MG3's finder made it reachable by an
   * ordinary member for the first time. The code lets the client say something
   * actionable without the server rewording anything.
   */
  public code?: string;

  constructor(
    message: string,
    public status: number,
    options?: { crossFamilyMemberIds?: readonly string[]; code?: string }
  ) {
    super(message);
    this.crossFamilyMemberIds = options?.crossFamilyMemberIds;
    this.code = options?.code;
  }
}

/**
 * The refusal a member gets for naming a member id they are not allowed to book
 * — today, a club that has the member-guest module off.
 *
 * Says nothing a caller did not already know: they sent the id, and they are
 * being told it is not usable. It deliberately does NOT say whether the member
 * exists, nor that a member-guest feature exists at all.
 */
export const GUEST_MEMBER_NOT_ALLOWED_CODE = "GUEST_MEMBER_NOT_ALLOWED";

/**
 * Build D-8's one collapsed refusal, tagged with the targets it concerned.
 *
 * Every collapse site goes through this so the message, the status and the audit
 * tag can never be assembled three slightly different ways.
 */
export function memberGuestCrossFamilyRefusal(
  crossFamilyMemberIds: readonly string[],
): BookingGuestValidationError {
  return new BookingGuestValidationError(
    MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
    MEMBER_GUEST_CROSS_FAMILY_REFUSAL_STATUS,
    { crossFamilyMemberIds },
  );
}

const GUEST_PROFILE_REQUIRED_ERROR_CODE = "GUEST_PROFILE_REQUIRED";

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

// test seam
export class BookingGuestProfileRequiredError extends BookingGuestValidationError {
  public override code = GUEST_PROFILE_REQUIRED_ERROR_CODE;

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
  /**
   * The `BEYOND_FAMILY` member ids for this add, from
   * `computeMemberGuestBoundary` (MG2 #2307, owner decision **D-8**).
   *
   * A blocked member in this set gets the one neutral refusal instead of the
   * detailed `BookingGuestProfileRequiredError` body, which would otherwise hand
   * the caller a stranger's name, the exact fields missing from their profile,
   * and whether they hold a login. Absent or empty means "every requested member
   * is inside the booker's family" and the gate behaves exactly as it did before
   * MG2 — which is also what every non-widened call site passes.
   */
  crossFamilyMemberIds?: readonly string[];
};

function skipsMemberProfileGateForAdminOnBehalf(
  context?: LinkedBookingMemberProfileGateContext
) {
  return context?.actorRole === "ADMIN" && Boolean(context.onBehalfOfMemberId);
}

/**
 * D-8's collapsed cross-family refusal code — re-exported from the import-free
 * leaf it now lives in, so the two CLIENT components that recognise it do not
 * have to pull this server module into their bundle to get a string. See
 * `member-guest-refusal.ts` for the note.
 */
export { MEMBER_GUEST_NOT_ADDABLE_CODE };

export function getBookingGuestValidationErrorResponse(
  error: BookingGuestValidationError
) {
  if (error instanceof BookingGuestProfileRequiredError) {
    return error.toResponseBody();
  }

  if (error.crossFamilyMemberIds && error.crossFamilyMemberIds.length > 0) {
    // The ids themselves are NEVER sent — they are the audit trail's business,
    // not the caller's, and echoing them back would confirm which of several
    // requested members the club refused to discuss.
    return { code: MEMBER_GUEST_NOT_ADDABLE_CODE, error: error.message };
  }

  if (error.code) {
    return { code: error.code, error: error.message };
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

/**
 * Where each requested member sits relative to the booker's family boundary
 * ("+ Add Member Guest", epic #2305, MG1 #2306).
 *
 * The boundary is EXACTLY the set `getAllowedGuestMemberIds` already computes —
 * the booker plus every co-member of their family groups — so this introduces
 * no second, drifting definition of "family" and adds no extra query on the
 * authorized path: the caller computes it once and the authorization check
 * below reuses the same result.
 */
export async function computeMemberGuestBoundary(
  db: BookingGuestLookupDb,
  bookingMemberId: string,
  normalizedMemberIds: readonly string[],
): Promise<MemberGuestBoundaryState> {
  const allowedMemberIds = await getAllowedGuestMemberIds(db, bookingMemberId);
  const scopeByMemberId = new Map<string, MemberGuestBoundaryScope>();
  const beyondFamilyMemberIds: string[] = [];

  for (const memberId of normalizedMemberIds) {
    const scope: MemberGuestBoundaryScope = allowedMemberIds.has(memberId)
      ? "FAMILY"
      : "BEYOND_FAMILY";
    scopeByMemberId.set(memberId, scope);
    if (scope === "BEYOND_FAMILY") {
      beyondFamilyMemberIds.push(memberId);
    }
  }

  return { scopeByMemberId, beyondFamilyMemberIds };
}

export interface ResolvedLinkedBookingMembers {
  members: Map<string, LinkedBookingMember>;
  boundary: MemberGuestBoundaryState;
}

/**
 * `resolveLinkedBookingMembers`, plus the family-boundary state it computed.
 *
 * MG2 (#2307) switches the persisting call sites onto this variant so each one
 * can persist the right `consentStatus` per guest, and adds the
 * `memberGuestWideningEnabled` option that lets a beyond-family member resolve
 * at all. The option defaults to `false`: a caller that does not pass it keeps
 * MG1's refusal, which is the safe direction (see
 * `MEMBER_GUEST_MODULE_KEY`'s note in `member-guest-consent.ts`).
 *
 * THE STRUCTURAL RULE OF MG1, and the thing to check first in review: the
 * boundary is computed OUTSIDE the `skipAuthorization` branch, unconditionally,
 * on every path.
 *
 * SIX of the seven call-site files can pass `skipAuthorization: true`, not four
 * — three of them do it through a runtime flag rather than a literal, which is
 * how the earlier count missed them:
 *   * `admin-booking-copy.ts` hard-codes `true`;
 *   * `booking-modify-plan.ts` passes `role === "ADMIN"`;
 *   * `api/bookings/[id]/guests/route.ts` and
 *     `api/bookings/[id]/modify-quote/route.ts` pass `isAdmin`;
 *   * `api/bookings/route.ts` and `api/bookings/quote/route.ts` pass
 *     `isAuthorizedOnBehalf` (an admin or booking officer acting for a member).
 * Only `group-booking.ts` can never skip: it passes no options at all, which is
 * owner decision MG1-D-a.
 *
 * If the boundary were computed only where authorization is enforced, none of
 * those six would have a boundary value to persist the day MG2 goes live — and
 * the cheapest way to make the code compile would be to give them a null
 * consent status, i.e. to mint consent-free cross-family guest rows through
 * every admin and on-behalf path, permanently and silently. Computing it here
 * costs those paths two small `FamilyGroupMember` reads and removes that whole
 * failure mode.
 *
 * It also cannot be verified from behaviour: in this release the outcome is
 * identical either way, by design. So it is asserted directly — see
 * `member-guest-dark-guarantee.test.ts`, which reads the returned boundary on a
 * `skipAuthorization` call.
 */
export async function resolveLinkedBookingMembersWithBoundary(
  db: BookingGuestLookupDb,
  bookingMemberId: string,
  memberIds: Array<string | null | undefined>,
  options?: {
    skipAuthorization?: boolean;
    memberGuestWideningEnabled?: boolean;
    /**
     * Runs the moment the family boundary is known and BEFORE any member record
     * is read. Throw from it to abort the resolve.
     *
     * WHY THIS HOOK EXISTS (privacy review of MG3 #2308, finding H1). The #2388
     * throttle used to be applied by the routes AFTER this function returned,
     * and that ordering turned the mitigation into the very existence oracle its
     * docblock says it avoids. `resolveLinkedMemberRecords` throws first for an
     * id with no active member behind it, and on that path the route's refusal
     * handler spends the throttle budget but DISCARDS the 429 and answers with
     * D-8's neutral 403. So once the burst budget was gone, a real bookable
     * member answered 429 and a non-existent, inactive or age-exempt one
     * answered 403 — one bit per request, for free.
     *
     * Spending the budget here makes both branches answer identically, because
     * nothing has yet been read about the member: the boundary is computed
     * purely from the BOOKER's family groups.
     */
    onBoundaryResolved?: (boundary: MemberGuestBoundaryState) => Promise<void>;
  }
): Promise<ResolvedLinkedBookingMembers> {
  const normalizedMemberIds = normalizeMemberIds(memberIds);

  if (normalizedMemberIds.length === 0) {
    return {
      members: new Map(),
      boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
    };
  }

  // Computed on EVERY path, admin included. Do not move this inside the
  // authorization branch below — see the note above.
  const boundary = await computeMemberGuestBoundary(
    db,
    bookingMemberId,
    normalizedMemberIds,
  );

  // Before the widening refusal and before any member row is read — see the
  // note on the option.
  if (options?.onBoundaryResolved) {
    await options.onBoundaryResolved(boundary);
  }

  if (!options?.skipAuthorization) {
    // MG2 (#2307) turns the feature on: with the memberGuests module enabled a
    // beyond-family ACTIVE member resolves here, and the boundary above is what
    // decides whether the row that follows needs consent. With the module off —
    // the shipped default (D-2) — the refusal is byte-for-byte the pre-existing
    // one (same message, same 403), so a club that has not opted in sees no
    // change whatsoever and no error text mentions member guests.
    //
    // The refusal deliberately stays neutral even with the module ON, because
    // the reasons a specific cross-family member cannot be added are D-8's
    // subject and are collapsed to one neutral message elsewhere. Nothing here
    // names the member.
    if (
      options?.memberGuestWideningEnabled !== true &&
      boundary.beyondFamilyMemberIds.length > 0
    ) {
      throw new BookingGuestValidationError("Invalid guest member reference", 403, {
        // The MESSAGE is unchanged, byte for byte — MG2 pins it. The code is
        // additive and lets the wizard render member-facing copy instead of
        // this developer-facing sentence (MEDIUM-4).
        code: GUEST_MEMBER_NOT_ALLOWED_CODE,
      });
    }
  }

  const members = await resolveLinkedMemberRecords(db, normalizedMemberIds, {
    // #2388, response equalisation. On a MEMBER path the two refusals below
    // must be indistinguishable from D-8's neutral one for a beyond-family
    // target — see the note on `collapseForMemberIds`. An admin/on-behalf path
    // (skipAuthorization) keeps the detailed errors: an officer is entitled to
    // know the id is wrong, and hiding it from them would only produce support
    // tickets.
    collapseForMemberIds: options?.skipAuthorization
      ? undefined
      : new Set(boundary.beyondFamilyMemberIds),
  });
  return { members, boundary };
}

export async function resolveLinkedBookingMembers(
  db: BookingGuestLookupDb,
  bookingMemberId: string,
  memberIds: Array<string | null | undefined>,
  options?: { skipAuthorization?: boolean; memberGuestWideningEnabled?: boolean }
): Promise<Map<string, LinkedBookingMember>> {
  const { members } = await resolveLinkedBookingMembersWithBoundary(
    db,
    bookingMemberId,
    memberIds,
    options,
  );
  return members;
}

/**
 * Load the member rows behind a set of ids, refusing anything that cannot be a
 * booking guest.
 *
 * `collapseForMemberIds` (#2388, MG3 #2308) is the set of BEYOND-FAMILY ids on a
 * member-initiated path, and it exists because D-8's collapse had a hole that
 * needed no stopwatch to find. Both refusals below used to answer a
 * cross-family probe with their own message and their own status:
 *
 *   * "Linked member is inactive or not found" (400) — a straight existence
 *     oracle. Try an id, and the status alone told you whether an active member
 *     was behind it.
 *   * "This account is age-exempt (N/A)…" (400) — told you the target is an
 *     organisation or school account rather than a person.
 *
 * Neither is a leak inside a family, where the booker already knows who they are
 * adding, so the collapse is applied ONLY to the beyond-family set and only on
 * paths that enforce authorization. For those ids both become the same neutral
 * 403 every other cross-family refusal returns, which is what makes the timing
 * floor in `member-guest-probe-guard.ts` worth having at all: equalising the
 * clock is pointless while the body still says which refusal it was.
 */
async function resolveLinkedMemberRecords(
  db: BookingGuestLookupDb,
  normalizedMemberIds: string[],
  options?: { collapseForMemberIds?: ReadonlySet<string> },
): Promise<Map<string, LinkedBookingMember>> {
  const collapseFor = options?.collapseForMemberIds;
  const refuse = (memberId: string, message: string, status: number): never => {
    if (collapseFor?.has(memberId)) {
      throw memberGuestCrossFamilyRefusal([memberId]);
    }
    throw new BookingGuestValidationError(message, status);
  };

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
      accessRoles: { select: { role: true } },
      profileCompletedAt: true,
      detailsConfirmedAt: true,
      detailsConfirmedByMemberId: true,
      onboardingConfirmedAt: true,
    },
  });

  const linkedMemberMap = new Map(linkedMembers.map((member) => [member.id, member]));
  for (const memberId of normalizedMemberIds) {
    if (!linkedMemberMap.has(memberId)) {
      refuse(memberId, "Linked member is inactive or not found", 400);
    }
  }

  // Guests are people with a real age tier. NOT_APPLICABLE is the age-exempt
  // tier (#1440, #2106): organisations/schools AND any age-exempt human account
  // (e.g. an admin on an age-exempt membership type) carry it. It has no season
  // rate, no age restrictions, and no bed-group semantics, so linking such an
  // account would silently misprice the booking. The attending people are
  // listed as guests instead.
  for (const member of linkedMemberMap.values()) {
    if (member.ageTier === "NOT_APPLICABLE") {
      refuse(
        member.id,
        "This account is age-exempt (N/A) and cannot be added as a booking guest. Add the people attending instead.",
        400
      );
    }
  }

  return linkedMemberMap;
}

/**
 * Do two members share at least one family group?
 *
 * Lifted out of `assertLinkedBookingMembersCanBeBooked` by MG2 (#2307) as a
 * pure, behaviour-preserving extraction: it was a closure over the same map, and
 * the caller below still passes that map. It is exported because the member-guest
 * delegate resolver (`member-guest-delegate.ts`) has to apply exactly the same
 * rule from its own query, and two hand-written copies of a family-boundary
 * predicate on an authorization path is how those two copies drift.
 *
 * Note the deliberate `false` on a missing entry: a member with no family group
 * shares one with nobody, including themselves.
 */
export function memberIdsShareFamilyGroup(
  groupsByMemberId: ReadonlyMap<string, ReadonlySet<string>>,
  memberId: string,
  otherMemberId: string,
): boolean {
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

/**
 * The "can stand in for another member" half of the delegated-confirmation rule:
 * active, holds a login, and is an adult.
 *
 * Lifted alongside `memberIdsShareFamilyGroup` and for the same reason — this is
 * the predicate owner decision D-10 names as the interim delegate rule, so the
 * delegate resolver must use this exact function and not a lookalike. Each of
 * the three conjuncts is a separate mutation-probe target.
 */
export function isActiveLoginAdultMember(
  member:
    | { active?: boolean | null; canLogin?: boolean | null; ageTier?: string | null }
    | null
    | undefined,
): boolean {
  return (
    member?.active === true && member.canLogin === true && member.ageTier === "ADULT"
  );
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

  const sharesFamilyGroup = (memberId: string, otherMemberId: string) =>
    memberIdsShareFamilyGroup(groupsByMemberId, memberId, otherMemberId);

  const isActiveLoginAdult = (memberId: string) =>
    isActiveLoginAdultMember(resolverMemberMap.get(memberId));

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
    // D-8 (MG2 #2307): a blocked CROSS-FAMILY member collapses the whole
    // response to the one neutral refusal, and it wins over the detailed body
    // even when a family-scope member is blocked in the same request.
    //
    // Winning is the deliberate choice, and the alternative was worse. Returning
    // the detailed list for the family members alongside a neutral entry for the
    // stranger would leak by omission — the caller learns which of the two
    // members the club refused to talk about, and can iterate one id at a time to
    // read the same oracle the detailed body used to hand over. Refusing
    // wholesale costs the booker one extra round trip: they drop the member the
    // club will not discuss, retry, and get the full, helpful detail for their
    // own family exactly as before.
    const crossFamilyIds = new Set(context?.crossFamilyMemberIds ?? []);
    const blockedCrossFamilyIds = blockedMembers
      .map((member) => member.memberId)
      .filter((memberId) => crossFamilyIds.has(memberId));
    if (blockedCrossFamilyIds.length > 0) {
      throw memberGuestCrossFamilyRefusal(blockedCrossFamilyIds);
    }
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

// Generic over the caller's parsed guest shape (bookable-tier zod inputs,
// #1440): linking a member can widen the tier to the member's stored AgeTier,
// so only the ageTier field is re-typed on the way out.
export function normalizeBookingGuestInputs<T extends BookingGuestInput>(
  guests: T[],
  linkedMembers: Map<string, LinkedBookingMember>
): Array<Omit<T, "ageTier"> & { ageTier: AgeTier }> {
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
