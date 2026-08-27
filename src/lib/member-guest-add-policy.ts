import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import {
  computeMemberGuestBoundary,
  type BookingGuestLookupDb,
} from "@/lib/booking-guests";
import type { ClubTimeZone } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import {
  buildMemberGuestConsentWrite,
  computeMemberGuestConsentExpiry,
  MEMBER_GUEST_MODULE_KEY,
  type MemberGuestAddActor,
  type MemberGuestAddNotification,
  type MemberGuestBoundaryState,
  type MemberGuestConsentColumns,
  type MemberGuestConsentSubStateId,
} from "@/lib/member-guest-consent";
import { loadMemberGuestSettings } from "@/lib/member-guest-settings";

/**
 * The per-request half of "+ Add Member Guest" (epic #2305, MG2 #2307): read the
 * policy ONCE, then decide what each new guest row must persist.
 *
 * WHY A SEPARATE MODULE FROM `member-guest-consent.ts`. That file is the pure,
 * database-free model — the eight-shape table, the expiry clamp, the single
 * writer of consent columns — and it stays that way so the state machine can be
 * tested and reasoned about without a Prisma client anywhere near it. This module
 * is the part that touches the world: it reads the module flag and the policy
 * singleton, and it walks a caller's guest array. Six call sites need exactly
 * these two things, and doing them six times by hand is how the six would drift.
 *
 * THE ORDERING RULE THIS MODULE EXISTS TO ENFORCE, and the one thing to check in
 * review: `loadMemberGuestAddPolicy` must be called BEFORE the caller opens its
 * transaction, and `planMemberGuestConsentWrites` is pure so it can be called
 * inside one. A settings read inside a booking transaction holds the per-lodge
 * capacity lock across a second query for no reason, and the guest-add route in
 * particular resolves its members INSIDE `prisma.$transaction` — which is exactly
 * the shape that invites somebody to drop a `loadMemberGuestSettings()` in there.
 * Splitting the impure read from the pure decision makes the correct order the
 * only one that type-checks: the plan takes a policy value, so the caller has to
 * have loaded it already.
 */

interface MemberGuestAddPolicyValues {
  /** D-3: ask the target first. `true` is the shipped default. */
  approvalRequired: boolean;
  /** D-4: how long a PENDING request holds its bed before the sweep releases it. */
  pendingHoldExpiryDays: number;
}

/**
 * The policy for one add, and A DISCRIMINATED UNION ON PURPOSE (#3123).
 *
 * `wideningEnabled` is the `memberGuests` module flag, which MG2 turns into the
 * real switch it always claimed to be. It is passed to
 * `resolveLinkedBookingMembersWithBoundary`'s `memberGuestWideningEnabled`,
 * which defaults to `false` so a caller that forgets keeps MG1's refusal.
 *
 * WHY THE CLUB'S TIMEZONE LIVES ONLY ON THE ENABLED MEMBER. The consent expiry
 * clamp needs the club's PERSISTED zone (`INV-CONFIG-002`) to turn a lodge night
 * into the instant it begins, and it is now a REQUIRED argument so no caller can
 * silently get the container's zone instead. But the zone is another
 * `ClubTimeSettings` read, and the module-off branch below exists precisely to
 * spend no query at all — so putting `timeZone` on a single flat interface would
 * have forced one of two bad answers: a query on the hot path of every booking
 * create, quote and guest add for every club that never turns this on, or an
 * inert placeholder zone, which is the environment fallback wearing a different
 * name. The union gives the third answer: the zone EXISTS only in the state that
 * can consume it, `planMemberGuestConsentWrites` narrows to that state by its
 * own early return, and a caller that has not enabled widening cannot even spell
 * a call that would need one.
 */
export type MemberGuestAddPolicy =
  | (MemberGuestAddPolicyValues & { wideningEnabled: false })
  | (MemberGuestAddPolicyValues & {
      wideningEnabled: true;
      /**
       * The club's persisted timezone, read ONCE for this add and threaded into
       * the expiry clamp. See `loadMemberGuestAddPolicy` for why it is resolved
       * here and not where it is used.
       */
      timeZone: ClubTimeZone;
    });

/**
 * Read the module flag, the policy singleton and the club's timezone for one
 * request.
 *
 * THE SETTINGS READS ARE SKIPPED WHEN THE MODULE IS OFF, which is the state every
 * club ships in (D-2). With no widening there is no cross-family guest, so there
 * is no consent row to write and none of the policy values can be consulted;
 * issuing the queries anyway would put two more round trips on the hot path of
 * every booking create, quote and guest add on every club that never turns this
 * on. The defaults returned in that case are inert, not "assumed": nothing reads
 * them unless `wideningEnabled` is true, and the union above means the zone is
 * not even present to be read.
 *
 * THE ZONE IS RESOLVED HERE BECAUSE THIS IS ALREADY THE PLACE THAT MUST RUN
 * BEFORE THE TRANSACTION (#3123). The ordering rule at the top of this file —
 * enforced by `member-guest-add-call-sites.test.ts` — says this function is
 * called before the caller opens its transaction and that
 * `planMemberGuestConsentWrites` is pure. Hanging the zone off the value that
 * rule already governs means `INV-LOCK-004` holds by construction: there is no
 * arrangement of the eight call sites in which the `clubTimeSettings` query can
 * end up under the global booking lock or a per-lodge capacity key. It also
 * means not one of those call sites changed to get the zone — they already
 * thread `policy`.
 *
 * THE RUNTIME READER, NOT `clubTime()`, and the choice is measured rather than
 * stylistic (`docs/CLUB_TIME_KERNEL.md` -> "Where the zone comes from"). This
 * module is imported by `booking-request.ts` and `booking-request-quotes.ts`,
 * which `src/instrumentation.node.ts` reaches through the cron chain, and
 * `@/lib/club-time/server`'s `import "server-only"` is a bare throw outside the
 * `react-server` condition — at import, before the job runs. The cost is one
 * uncached `clubTimeSettings.findUnique` per add on clubs that have the module
 * on, which is the same trade `member-guest-consent-service.ts` already makes on
 * the sweep side.
 */
export async function loadMemberGuestAddPolicy(): Promise<MemberGuestAddPolicy> {
  const wideningEnabled = await isEffectiveModuleEnabled(MEMBER_GUEST_MODULE_KEY);
  if (!wideningEnabled) {
    return { wideningEnabled: false, approvalRequired: true, pendingHoldExpiryDays: 0 };
  }

  const [settings, timeZone] = await Promise.all([
    loadMemberGuestSettings(),
    readClubTimeZoneOutsideRequest(),
  ]);
  return {
    wideningEnabled: true,
    approvalRequired: settings.approvalRequired,
    pendingHoldExpiryDays: settings.pendingHoldExpiryDays,
    timeZone,
  };
}

/**
 * The fields MG2 attaches to a guest input on its way to being persisted.
 *
 * Both are optional and both are absent on every non-widened path, so a guest
 * built by any other flow is byte-identical to what it was before MG2.
 */
export interface MemberGuestConsentGuestFields {
  /**
   * The five consent columns this guest row must be created with, from
   * `buildMemberGuestConsentWrite`. Present only for a cross-family member guest:
   * a family-scope add (D-6) leaves this undefined rather than carrying five
   * explicit nulls, so the persistence layer writes exactly what it wrote before.
   */
  memberGuestConsent?: MemberGuestConsentColumns;
  /**
   * D-8: this guest is a cross-family member guest, so the three refusals that
   * would otherwise describe them collapse to one neutral message. Carried
   * separately from `memberGuestConsent` because the QUOTE paths need the
   * collapse and write no rows at all.
   */
  crossFamilyMemberGuest?: boolean;
}

/** One row's worth of "who has to be told what", collected for after the commit. */
export interface MemberGuestConsentWritePlanEntry {
  targetMemberId: string;
  notification: MemberGuestAddNotification;
  /** The sub-state `classifyMemberGuestConsent` must agree these columns are. */
  subState: MemberGuestConsentSubStateId;
}

export interface MemberGuestConsentWritePlan<Guest> {
  /** The caller's guests, with the MG2 fields attached where they apply. */
  guests: Array<Guest & MemberGuestConsentGuestFields>;
  /**
   * The cross-family rows this add creates, keyed by target member id — the input
   * to `member-guest-consent-notifications.ts` once the transaction has committed.
   * Empty on every family-scope add, which is what makes the post-commit send a
   * no-op for the overwhelming majority of bookings.
   */
  entriesByMemberId: Map<string, MemberGuestConsentWritePlanEntry>;
}

type GuestWithMemberId = { memberId?: string | null; isMember?: boolean };

function crossFamilyMemberIdOf(
  guest: GuestWithMemberId,
  boundary: MemberGuestBoundaryState,
): string | null {
  const memberId = guest.memberId?.trim();
  if (!memberId) return null;
  return boundary.scopeByMemberId.get(memberId) === "BEYOND_FAMILY" ? memberId : null;
}

/**
 * Decide the consent columns for every guest in one add, and collect the
 * notifications the caller owes after it commits.
 *
 * PURE. No database, no clock of its own — `now` is passed in so a test can pin
 * the expiry and so every row in one add carries the SAME timestamp. Safe to call
 * inside a transaction; see the ordering rule at the top of this file.
 *
 * The rules themselves are NOT re-derived here. Every decision comes from
 * `buildMemberGuestConsentWrite`, which is the single writer of consent columns
 * and the only place the eight-shape table is encoded, so a path that reached the
 * wrong conclusion would have to be wrong in that one function rather than in one
 * of six call sites.
 */
export function planMemberGuestConsentWrites<Guest extends GuestWithMemberId>(params: {
  guests: readonly Guest[];
  boundary: MemberGuestBoundaryState;
  actor: MemberGuestAddActor;
  now: Date;
  /**
   * The booking's check-in, for the D-4 expiry clamp. The stated check-in is the
   * right value even where guest nights could later expand the booking's envelope
   * earlier (#713): the clamp only ever moves the deadline EARLIER than
   * `now + pendingHoldExpiryDays`, and an envelope that expands backwards makes
   * the true first night sooner, so the clamp computed here is never later than
   * the one the final envelope would have produced.
   */
  bookingCheckIn: Date;
  policy: MemberGuestAddPolicy;
}): MemberGuestConsentWritePlan<Guest> {
  const { guests, boundary, actor, now, bookingCheckIn, policy } = params;
  const entriesByMemberId = new Map<string, MemberGuestConsentWritePlanEntry>();

  if (!policy.wideningEnabled) {
    // MODULE OFF — plan NOTHING, on every path including the admin ones, and this
    // is the case that needs stating because it is not the one it looks like.
    //
    // The widening flag gates RESOLUTION only on the paths that enforce
    // authorization. A `skipAuthorization` path (an admin or officer acting on
    // behalf, the admin booking-copy) has ALWAYS been able to resolve any member
    // id — that is what skipping authorization means, and it was true throughout
    // MG1. So without this early return, a club that never turned the module on
    // would still get consent columns written the moment an admin copied a booking
    // or added a guest on somebody's behalf, and MG1's promise — that a club which
    // has not opted in sees NO change whatsoever — would hold for members and
    // quietly fail for admins.
    //
    // The consequence, stated rather than hidden: with the module off, an admin
    // add of a cross-family member writes the same all-null row it wrote before
    // MG2 existed, so it is indistinguishable from a family-scope add. That is
    // MG1's behaviour exactly, and it is the right trade — the alternative is
    // writing feature data on a club that has not adopted the feature.
    return {
      guests: guests as Array<Guest & MemberGuestConsentGuestFields>,
      entriesByMemberId,
    };
  }

  const plannedGuests = guests.map((guest) => {
    const memberId = crossFamilyMemberIdOf(guest, boundary);
    if (!memberId) {
      // Family scope (D-6) or a non-member guest: nothing is attached, so the
      // persistence layer writes exactly the columns it wrote before MG2.
      return guest as Guest & MemberGuestConsentGuestFields;
    }

    const write = buildMemberGuestConsentWrite({
      scope: "BEYOND_FAMILY",
      approvalRequired: policy.approvalRequired,
      actor,
      now,
      // Only the approval-required MEMBER add consumes this; every other branch
      // of the writer ignores it and stores a null expiry. Computing it
      // unconditionally keeps the branch logic in one place — the writer's.
      consentExpiresAt: computeMemberGuestConsentExpiry({
        now,
        pendingHoldExpiryDays: policy.pendingHoldExpiryDays,
        bookingCheckIn,
        // Narrowed to the widening-enabled member by the early return above, so
        // the club's persisted zone is present here by construction and no
        // default can creep back in (#3123).
        timeZone: policy.timeZone,
      }),
    });

    if (write.notification !== "NONE") {
      // Keyed by member id, so two guest rows for the same member in one
      // malformed payload cannot mint two requests. The resolver de-duplicates
      // ids as well, so this is belt and braces rather than the only guard.
      entriesByMemberId.set(memberId, {
        targetMemberId: memberId,
        notification: write.notification,
        subState: write.subState,
      });
    }

    return {
      ...guest,
      memberGuestConsent: write.columns,
      crossFamilyMemberGuest: true,
    };
  });

  return { guests: plannedGuests, entriesByMemberId };
}

/** One committed guest row and the notification it owes. */
export interface MemberGuestAddNotificationRow {
  bookingGuestId: string;
  targetMemberId: string;
  notification: MemberGuestAddNotification;
}

/**
 * Match a plan built before the write to the guest rows the write created.
 *
 * The persisting paths know WHICH MEMBER owes a notification — the plan is keyed
 * by member id, because that is what the family boundary is computed over — but
 * only learn the guest ROW ids once the rows exist. Matching on `memberId` is
 * exact: `resolveLinkedBookingMembers` de-duplicates the requested ids, so one add
 * creates at most one row per member, and the plan carries only cross-family
 * members, so a family-scope guest for the same member cannot collide because it
 * is not in the plan at all. Rows created for members not in the plan are ignored,
 * so a caller may pass its whole created-guest list without filtering.
 *
 * WHY THIS LIVES HERE AND NOT WITH THE DISPATCHER. It is pure, and it is called
 * from INSIDE the transaction (that is the only place the created rows are in
 * hand), whereas the dispatcher pulls in the whole email/template graph. Keeping
 * the two apart lets every persisting call site import this statically and load
 * the sender with a dynamic import only when a notification is actually owed —
 * so a club with the module off, or any ordinary family booking, never loads the
 * mailer at all.
 */
export function matchMemberGuestNotificationRows(params: {
  createdGuests: ReadonlyArray<{ id: string; memberId: string | null }>;
  entriesByMemberId: ReadonlyMap<string, { notification: MemberGuestAddNotification }>;
}): MemberGuestAddNotificationRow[] {
  const rows: MemberGuestAddNotificationRow[] = [];
  for (const guest of params.createdGuests) {
    if (!guest.memberId) continue;
    const entry = params.entriesByMemberId.get(guest.memberId);
    if (!entry || entry.notification === "NONE") continue;
    rows.push({
      bookingGuestId: guest.id,
      targetMemberId: guest.memberId,
      notification: entry.notification,
    });
  }
  return rows;
}

/**
 * The quote-path half: mark the cross-family guests for D-8 and write nothing.
 *
 * `POST /api/bookings/quote` and `POST /api/bookings/[id]/modify-quote` must
 * resolve a cross-family member so the party PRICES correctly — a member guest
 * prices at member rates and counts toward the group discount, so a quote that
 * refused them would show the booker a figure the create path then contradicts —
 * but they persist no rows, so there is no consent to write and nobody to notify.
 * They still need the marker, and they need it MORE than the persisting paths do:
 * a quote is side-effect-free and rate-limited as a read, which makes it the
 * cheapest place to probe a stranger's occupancy or subscription status.
 */
export function markCrossFamilyMemberGuests<Guest extends GuestWithMemberId>(
  guests: readonly Guest[],
  boundary: MemberGuestBoundaryState,
): Array<Guest & MemberGuestConsentGuestFields> {
  return guests.map((guest) =>
    crossFamilyMemberIdOf(guest, boundary)
      ? { ...guest, crossFamilyMemberGuest: true }
      : (guest as Guest & MemberGuestConsentGuestFields),
  );
}

/**
 * Mark EVERY member-linked guest on a booking who sits outside the booking
 * owner's family — not only the ones this request is ADDING.
 *
 * WHY THIS EXISTS AT ALL, because the difference is a whole class of leak
 * (privacy review of MG3 #2308, finding C1). `markCrossFamilyMemberGuests` and
 * `planMemberGuestConsentWrites` mark guests from the boundary computed over the
 * ids in `addGuests`, so the marker only ever landed on somebody being added in
 * THIS request. A cross-family member guest who is ALREADY on the booking —
 * added successfully last week — was therefore unmarked forever, and the
 * person-night guard, which derives its entire D-8 set from the marker, answered
 * for them in full: name, and the exact nights they are booked elsewhere.
 *
 * That turned every later date change into a free read-out. Add the member once
 * on dates where they are free, then call `POST /api/bookings/[id]/modify-quote`
 * — a side-effect-free preview — repeatedly with different ranges and NO
 * `addGuests`. With no added guests the boundary is empty, so the #2388 throttle
 * never fires, no refusal is audited and no timing floor applies; and the answer
 * is not the neutral refusal at all but a 409 carrying `memberName` and
 * `conflictingNights`. One request per range, unthrottled and unlogged. That is
 * not the documented residual (correlating a PATTERN of refusals) — it is a
 * direct read.
 *
 * WHY THE BOUNDARY AND NOT THE PERSISTED CONSENT COLUMNS. The other candidate
 * fix was to treat `consentStatus != null` as "beyond family", since MG2 writes
 * those columns on exactly the cross-family adds. It was rejected:
 *
 *   * the columns record HOW A ROW WAS CREATED, not the relationship that holds
 *     now. They are null on every row written before MG2, and null on every
 *     cross-family row an ADMIN adds while the module is off (see the module-off
 *     early return in `planMemberGuestConsentWrites`) — so a stranger placed on
 *     the booking by an officer would still have been described in full;
 *   * they never change when a family group does, so a guest who has since
 *     joined the booker's household would stay collapsed, and one who has left
 *     it would stay disclosed.
 *
 * The boundary is the live truth, and it is the SAME `getAllowedGuestMemberIds`
 * set MG1's authorization check and MG2's consent planner already use, so this
 * adds no second, drifting definition of "family". It costs two indexed reads on
 * the modify paths.
 *
 * GATED — ON THE MODULE FLAG **OR** THE BOOKING'S OWN CONSENT HISTORY (owner
 * decision, 1 Aug 2026, privacy re-review of MG3 #2308 finding 4). This docblock
 * used to say "NOT GATED ON THE MODULE FLAG, deliberately", and the owner has
 * since decided the opposite, so the paragraph is rewritten rather than softened.
 *
 * The recomputation now runs only when EITHER:
 *
 *   (a) the club's member-guest module is effectively enabled — the only state in
 *       which a member can put a beyond-family guest on a booking at all; or
 *   (b) this booking already carries at least one member-guest consent row, i.e.
 *       a non-null `BookingGuest.consentStatus`.
 *
 * Arm (b) is the whole reason a gate is safe. Without it, a club that used the
 * module and then switched it off would re-open the C1 read-out on every booking
 * it had already created — which is precisely the objection the old "not gated"
 * paragraph was written against. With it, a legacy or in-flight booking that ever
 * held a cross-family member guest keeps its protection for as long as the row
 * exists, whatever the flag now says.
 *
 * WHAT THE GATE COSTS, AND WHAT IT SAVES. Arm (a) is one `findUnique` on the
 * module-settings singleton by fixed primary key; arm (b) is one `findFirst` on
 * `BookingGuest` covered by `@@index([bookingId])`. So a module-off club with an
 * ordinary booking now pays two trivially indexed reads instead of the two
 * `FamilyGroupMember` reads `computeMemberGuestBoundary` would have run — which
 * is what the owner asked for: the family-boundary recomputation stops running on
 * every booking change at every club that never adopted the feature.
 *
 * WHAT THE GATE GIVES UP, STATED BECAUSE IT IS AN ACCEPTED TRADE. When the gate
 * says skip there is no cross-family marker on the returned party, so everything
 * downstream that keys off the marker degrades with it — the person-night guard
 * answers in full detail, and `applyMemberGuestPartyProbeThrottle` (which filters
 * on the marker) charges nothing. That is coherent rather than half-protected:
 * the only way such a booking exists is an admin having placed a beyond-family
 * member on it at a club that never turned the module on and where no consent row
 * was ever written, and the admin-created case was already the one this function's
 * original note called out as its only visible consequence.
 *
 * IT FAILS CLOSED WHEN IT CANNOT ANSWER. Both arms need a `db` that can serve
 * them and a `bookingId` to ask about. If any of the three is missing — a caller
 * that has not been taught the option, or a narrowed test double — the gate does
 * NOT apply and the marking runs exactly as it did before. "I could not tell" must
 * never be treated as "the module is off": that would turn a missing argument into
 * a silent privacy regression, which is the failure mode C1 was.
 *
 * ADMIN AND ON-BEHALF PATHS ARE EXEMPT, exactly as `collapseForMemberIds` is: an
 * officer is entitled to the detail, and withholding it from them would buy
 * nothing and cost support tickets.
 */
export async function markCrossFamilyGuestsOnBooking<Guest extends GuestWithMemberId>(
  db: BookingGuestLookupDb,
  bookingMemberId: string,
  guests: readonly Guest[],
  options?: {
    skipAuthorization?: boolean;
    /**
     * The booking the party belongs to. Required for the owner's gate to apply —
     * without it arm (b) is unanswerable, so the gate abstains and the marking
     * runs unconditionally (see the fail-closed note above).
     */
    bookingId?: string | null;
  },
): Promise<Array<Guest & MemberGuestConsentGuestFields>> {
  if (options?.skipAuthorization) {
    return guests as Array<Guest & MemberGuestConsentGuestFields>;
  }

  const memberIds = [
    ...new Set(
      guests
        .map((guest) => guest.memberId?.trim())
        .filter((memberId): memberId is string => Boolean(memberId)),
    ),
  ];
  if (memberIds.length === 0) {
    return guests as Array<Guest & MemberGuestConsentGuestFields>;
  }

  if (await memberGuestBoundaryRecomputeIsSkippable(db, options?.bookingId)) {
    return guests as Array<Guest & MemberGuestConsentGuestFields>;
  }

  const boundary = await computeMemberGuestBoundary(db, bookingMemberId, memberIds);
  return markCrossFamilyMemberGuests(guests, boundary);
}

/**
 * The two structural reads the owner's gate needs, both optional.
 *
 * Declared as a structural widening of `BookingGuestLookupDb` rather than by
 * importing the Prisma types, for the same reason the rest of this module does:
 * the marking function is called with a `PrismaClient` on the quote paths and
 * with a `Prisma.TransactionClient` inside the modify paths' capacity lock, and
 * both satisfy this shape at runtime.
 */
type MemberGuestGateDb = {
  clubModuleSettings?: { findUnique: unknown };
  bookingGuest?: {
    findFirst: (args: {
      where: { bookingId: string; consentStatus: { not: null } };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
};

/**
 * The owner's gate, as one question: may the family-boundary recomputation be
 * skipped for this booking?
 *
 * `true` ONLY when both arms answer no — the module is effectively off AND this
 * booking has never carried a member-guest consent row. Every other outcome,
 * including "this db cannot answer", returns `false` and the recomputation runs.
 *
 * ARM ORDER IS THE CHEAP ONE FIRST. When the module is on the answer is already
 * "do not skip", so the `BookingGuest` read never happens on an adopting club. On
 * a module-off club — the common case, and the one the owner's decision is about —
 * both reads run, and both are single indexed lookups.
 *
 * NOTE ON THE TRANSACTION CLIENTS. `isEffectiveModuleEnabled` is given the
 * caller's own `db`, so the modify paths ask the module question on the
 * transaction that already holds the per-lodge capacity lock rather than opening a
 * second connection under it. That is the ordering rule at the top of this file,
 * applied to a read the file did not previously make.
 */
async function memberGuestBoundaryRecomputeIsSkippable(
  db: BookingGuestLookupDb,
  bookingId: string | null | undefined,
): Promise<boolean> {
  if (!bookingId) return false;

  const gateDb = db as unknown as MemberGuestGateDb;
  if (typeof gateDb.clubModuleSettings?.findUnique !== "function") return false;
  if (typeof gateDb.bookingGuest?.findFirst !== "function") return false;

  // (a) The club's member-guest module. Enabled means a member can put a
  // beyond-family guest on a booking today, so the marker has to be live.
  const moduleClient = db as Parameters<typeof isEffectiveModuleEnabled>[1];
  if (await isEffectiveModuleEnabled(MEMBER_GUEST_MODULE_KEY, moduleClient)) {
    return false;
  }

  // (b) The booking's own history. A non-null consentStatus on any row means this
  // booking has held a cross-family member guest, so it keeps its protection even
  // though the club has since switched the module off.
  const consentRow = await gateDb.bookingGuest.findFirst({
    where: { bookingId, consentStatus: { not: null } },
    select: { id: true },
  });
  return consentRow === null;
}
