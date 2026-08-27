import type { MemberGuestConsentStatus } from "@prisma/client";
import {
  addCalendarDays,
  calendarDateOfDateOnlyInstant,
  requireStoredCalendarDay,
  startOfClubDay,
  type ClubTimeZone,
} from "@/lib/club-time";

/**
 * Member-guest consent model — the pure, database-free half of "+ Add Member
 * Guest" (epic #2305). Provisioned by MG1 (#2306); MG2 (#2307) is the release
 * that turns it on and adds the state machine, the expiry clamp, and the
 * operational-presence predicate every other surface filters on.
 */

/**
 * THE WIDENING PREDICATE — flipped by MG2 (#2307) from a hard-coded `false`
 * into a per-club policy read.
 *
 * MG1 shipped the whole feature dark behind a constant, because an admin who
 * switched the module on in an MG1-only release could have created
 * capacity-holding `PENDING` rows that no released code could resolve or
 * expire. MG2 removes that hazard by shipping the approval surface, the
 * transition service and the expiry sweep in the same release, so the module
 * flag can finally mean what it says.
 *
 * WHY THIS IS A PARAMETER AND NOT A MODULE READ INSIDE `booking-guests.ts`.
 * Every caller already knows whether the module is on — most of them have
 * loaded module state for other reasons — and `resolveLinkedBookingMembers`
 * deliberately takes an injected `db` narrowed to `familyGroupMember` + `member`
 * so it can run inside a booking transaction without dragging the whole client
 * (or a settings read) in with it. Passing the answer keeps that property, keeps
 * the decision visible at each of the seven call sites, and makes the census
 * test in `member-guest-widening.test.ts` meaningful rather than incidental.
 *
 * IT FAILS CLOSED. `resolveLinkedBookingMembersWithBoundary`'s
 * `memberGuestWideningEnabled` option defaults to `false`, so a call site that
 * forgets it keeps MG1's behaviour — a beyond-family add is refused — rather
 * than minting a consent-free cross-family guest row. That is the right
 * direction to fail in, and the census test names every call site so a forgotten
 * one is a visible test failure and not a silent policy hole.
 *
 * The name below exists so the module key is written down once, in the file that
 * explains what it gates, instead of being re-typed as a string literal at each
 * call site.
 */
export const MEMBER_GUEST_MODULE_KEY = "memberGuests" as const;

/**
 * The consent statuses a guest row may carry and still be a real occupant.
 *
 * Owner decision D-12: kiosk arrivals, the chore roster, bed allocation, the
 * arrival emails, the lodge board and the double-bed candidate sweep all
 * describe who is ACTUALLY going to be at the lodge. A `PENDING` row holds a bed
 * (D-4) and nothing else; a `DECLINED` or `EXPIRED` row that survived its
 * removal attempt (see the exception list) is not an occupant either.
 *
 * TRAP, AND A NASTY ONE — read before you write a filter by hand.
 * Do NOT write `{ consentStatus: { not: "PENDING" } }`. `consentStatus` is
 * nullable and NULL is the dominant value forever: every non-member guest,
 * every family-scope guest, every row written before this feature existed. In
 * SQL, `consentStatus <> 'PENDING'` is UNKNOWN for a NULL row, so that filter
 * silently drops every ordinary guest out of the kiosk, the chore roster and the
 * arrival emails. The explicit `OR` below cannot go wrong that way. A dedicated
 * test asserts a NULL-consent guest IS matched, and mutation probe 4 requires
 * flipping this to the `not:` form and watching a test fail.
 *
 * DELIBERATELY NOT `as const`, and this cost a round of typecheck failures to
 * learn: a `readonly` `OR` array is not assignable to Prisma's mutable
 * `BookingGuestWhereInput[]`, so an `as const` version would have needed a cast
 * at every one of the fourteen call sites — and fourteen casts is fourteen
 * chances to cast to the wrong thing, on the exact filter whose whole job is to
 * be right everywhere. The explicit mutable annotation below keeps every site
 * cast-free.
 *
 * It is safe to share one frozen literal across fourteen `where` clauses because
 * every site SPREADS it or passes it as a read-only filter; nothing mutates it,
 * and `Object.freeze` makes an attempt to throw in development rather than
 * silently change the kiosk, the roster and the arrival emails at once.
 *
 * Spread it: `where: { ...otherFilters, ...OPERATIONALLY_PRESENT_GUEST_WHERE }`,
 * or use it directly in `guests: { some: OPERATIONALLY_PRESENT_GUEST_WHERE }`
 * and `include: { guests: { where: OPERATIONALLY_PRESENT_GUEST_WHERE } }`.
 */
export const OPERATIONALLY_PRESENT_GUEST_WHERE: {
  OR: { consentStatus: MemberGuestConsentStatus | null }[];
} = Object.freeze({
  OR: Object.freeze([
    { consentStatus: null },
    { consentStatus: "CONFIRMED" as MemberGuestConsentStatus },
  ]) as { consentStatus: MemberGuestConsentStatus | null }[],
});

/**
 * The in-memory twin of `OPERATIONALLY_PRESENT_GUEST_WHERE`, for the surfaces
 * that already hold rows and filter them in JavaScript.
 *
 * Both forms exist because both are needed, and they are declared next to each
 * other on purpose: a reviewer can see in one glance that they agree, and a test
 * asserts they agree over all six possible column values.
 */
export function isOperationallyPresentConsent(
  consentStatus: MemberGuestConsentStatus | null | undefined,
): boolean {
  return consentStatus === null || consentStatus === undefined || consentStatus === "CONFIRMED";
}

/**
 * The shortest hold a request may be given, mirroring `MIN_GRACE_MS` in
 * `cron-group-settlement-reaper.ts`: never mint a request that has already
 * expired by the time the confirmation email lands.
 */
export const MEMBER_GUEST_CONSENT_MIN_HOLD_MS = 2 * 60 * 60 * 1000;

/**
 * When a `PENDING` request lapses: `min(now + N days, the day before check-in)`,
 * never sooner than two hours from now.
 *
 * WHY THE CLAMP IS CHECK-IN MINUS ONE DAY AND NOT CHECK-IN. The sweep releases
 * the bed through the same removal path a member's own self-removal uses, and
 * that path refuses `STAY_NOT_FUTURE` once the check-in day is no longer after
 * the club's own day (`booking-guest-self-removal.ts`). An expiry clamped to
 * check-in itself would therefore fire on a morning when the removal is already
 * refused — every such row would land on the admin exception list instead of
 * releasing, which is precisely the outcome D-4's expiry exists to prevent.
 * Clamping a day earlier means the sweep's last possible run still sees a future
 * check-in.
 *
 * The clamp lands on the START of the day before check-in in club time, so the
 * nightly sweep (04:30 club time) is guaranteed to be past it on that day.
 *
 * THE ONE CASE THE CLAMP CANNOT SAVE, stated rather than hidden: a booking made
 * inside the last two days before check-in. The two-hour floor wins over the
 * clamp, so the request can outlive the useful window and the sweep may find the
 * removal refused. That row goes to the exception list with honest copy. The
 * alternative — an already-expired request — would be worse: the member would
 * never get a chance to answer at all.
 *
 * TWO SEPARATE THINGS USED TO BE WRONG HERE, and #3123 fixed both. They are
 * described apart because fixing one and not the other leaves a defect that is
 * harder to see than either was.
 *
 * 1. `timeZone` WAS OPTIONAL, so the sole production caller
 *    (`member-guest-add-policy.ts`) passed nothing and the clamp was computed in
 *    whatever zone the container happened to run in. It is now REQUIRED and
 *    branded: the club's persisted `ClubTimeSettings.timeZone`
 *    (`INV-CONFIG-002`), resolved once per add and threaded in on
 *    `MemberGuestAddPolicy`. A default would have left the same hole open for
 *    the next caller; a required parameter means no caller can silently get the
 *    environment's answer.
 *
 * 2. THE CHECK-IN WAS PROJECTED THROUGH THAT ZONE, which is wrong however good
 *    the zone is. `bookingCheckIn` is a `@db.Date` column — a CALENDAR DAY,
 *    encoded as UTC midnight (`INV-DATE-010`, `INV-DATE-026`) — and a calendar
 *    day takes no zone at all. `normalizeDateOnlyForTimeZone` read it back
 *    through the club's zone, which for any club BEHIND Greenwich names the
 *    previous day: measured on `America/Denver`, a stored 4 August read back as
 *    3 August, so "the day before check-in" became 2 August and the whole
 *    deadline landed exactly 24 hours early. The member is given a day less to
 *    answer than the club's policy says, and where the booking is made close in,
 *    the now-past clamp hands the decision to the two-hour floor instead.
 *
 * So the two concerns are separated: the stored day is decoded ZONE-FREE, the
 * `-1` is calendar arithmetic on that day, and the club's zone is used only at
 * the last step, to turn the resulting day into the INSTANT it begins at the
 * club. The zone belongs on the instant, never on the day.
 */
export function computeMemberGuestConsentExpiry(params: {
  now: Date;
  pendingHoldExpiryDays: number;
  /** The booking's stored `@db.Date` check-in. A calendar day, not a moment. */
  bookingCheckIn: Date;
  /** The club's PERSISTED zone (`INV-CONFIG-002`). Required — see the note above. */
  timeZone: ClubTimeZone;
}): Date {
  const { now, pendingHoldExpiryDays, bookingCheckIn, timeZone } = params;

  const requested = new Date(
    now.getTime() + pendingHoldExpiryDays * 24 * 60 * 60 * 1000,
  );

  const dayBeforeCheckIn = addCalendarDays(
    calendarDateOfDateOnlyInstant(
      requireStoredCalendarDay(bookingCheckIn, {
        subject: "A member-guest consent deadline's check-in",
        instead:
          "Pass the booking's stored @db.Date check-in column, or resolve a real " +
          "timestamp's club day with clubCalendarDateOf first and pass that.",
      }),
    ),
    -1,
  );
  const latest = startOfClubDay(dayBeforeCheckIn, timeZone);

  const clamped = requested.getTime() < latest.getTime() ? requested : latest;
  const floor = now.getTime() + MEMBER_GUEST_CONSENT_MIN_HOLD_MS;
  return new Date(Math.max(clamped.getTime(), floor));
}

/**
 * Who is doing the adding, which is what decides whether anyone is ASKED.
 *
 * `ADMIN` covers every path that can pass `skipAuthorization` — an admin or
 * booking officer adding on a member's behalf, and the admin booking-copy. Owner
 * decision MG4-D-a makes those adds consent-free and always-notify, and the
 * coherence review moved that rule forward into MG2 so there is never a released
 * state where a copy mints a `PENDING` row that MG4 would then have had to
 * migrate away.
 *
 * `BOOKING_REQUEST` is MG4 (#2309) honouring owner decision MG4-D-b, and it is a
 * THIRD kind rather than a reuse of `ADMIN` for one reason: the two write the
 * SAME consent columns but owe the target a DIFFERENT sentence. An officer
 * placing somebody on a member's booking and the public booking-request pipeline
 * converting a stranger's enquiry are not the same event to the person being
 * told, and `composeMemberGuestAdded` has carried separate `"ADMIN"` and
 * `"BOOKING_REQUEST"` wording since MG2 precisely so MG4 would not have to
 * invent a second template. Modelling the difference in the actor — the value
 * both the column writer and the notifier already take — means neither of them
 * re-derives it from anything, and a future path that forgets to say which it is
 * fails to compile rather than silently mailing the wrong sentence.
 *
 * `adminMemberId` on both admin-ish kinds is the officer who stood behind the
 * add, and it is what lands in `consentRespondedByMemberId` (the `ADMIN_ASSIGNED`
 * sub-state). For the pipeline that is the approving officer, not the requester —
 * the requester is a non-login contact who cannot stand behind anything.
 */
export type MemberGuestAddActor =
  | { kind: "MEMBER" }
  | { kind: "ADMIN"; adminMemberId: string }
  | { kind: "BOOKING_REQUEST"; adminMemberId: string };

/** What the add path must send after the transaction commits. */
export type MemberGuestAddNotification =
  /** Approval-required member add: ask the target (or their delegate). */
  | "CONSENT_REQUEST"
  /** Notify-only, admin, copy or pipeline add: tell them, do not ask. */
  | "ADDED_NOTICE"
  /** Family scope (D-6) — nobody is told anything, exactly as today. */
  | "NONE";

export interface MemberGuestConsentWrite {
  columns: MemberGuestConsentColumns;
  notification: MemberGuestAddNotification;
  /** The sub-state the columns are claimed to be, asserted by the caller's tests. */
  subState: MemberGuestConsentSubStateId;
}

/**
 * The single writer of consent columns for a newly created guest row.
 *
 * Every persisting call site goes through this, so the eight-shape table below
 * is enforced by construction rather than by four call sites each remembering
 * the rules. Returns the notification the caller owes as well as the columns,
 * because the two are one decision: a row that was asked for gets a request
 * email, a row nobody asked about gets a notice, and a family row gets neither.
 */
export function buildMemberGuestConsentWrite(params: {
  scope: MemberGuestBoundaryScope;
  /** `MemberGuestSettings.approvalRequired` (D-3: true is the shipped default). */
  approvalRequired: boolean;
  actor: MemberGuestAddActor;
  now: Date;
  /** Required for the approval-required member add; ignored otherwise. */
  consentExpiresAt?: Date | null;
}): MemberGuestConsentWrite {
  const { scope, approvalRequired, actor, now, consentExpiresAt } = params;

  // D-6: a family-scope add is consent-FREE, not consent-GIVEN. NULL and
  // CONFIRMED must stay distinguishable forever.
  if (scope === "FAMILY") {
    return {
      columns: { ...CONSENT_FREE_GUEST_COLUMNS },
      notification: "NONE",
      subState: "FAMILY_OR_LEGACY",
    };
  }

  // MG4-D-a (admin, copy) and MG4-D-b (the booking-request pipeline) are ONE
  // column rule and two sentences: both are consent-free and always-notify, and
  // both record the officer who stood behind them. `respondedAt` +
  // `respondedByMemberId` name that officer, which is where MG4's audit rides.
  // The two kinds are kept apart only so the NOTIFICATION can say which happened
  // — see `MemberGuestAddActor`. If a third admin-ish path ever appears, it
  // belongs in this branch too, and TypeScript will say so.
  if (actor.kind === "ADMIN" || actor.kind === "BOOKING_REQUEST") {
    return {
      columns: {
        consentStatus: "CONFIRMED",
        consentRequestedAt: null,
        consentRespondedAt: now,
        consentRespondedByMemberId: actor.adminMemberId,
        consentExpiresAt: null,
      },
      notification: "ADDED_NOTICE",
      subState: "ADMIN_ASSIGNED",
    };
  }

  // Notify-only (D-3 opt-down): auto-confirmed, never solicited. A null
  // requestedAt AND a null respondedBy is the signature; a set expiresAt would
  // look to the sweep like a hold with a deadline, so it stays null.
  if (!approvalRequired) {
    return {
      columns: {
        consentStatus: "CONFIRMED",
        consentRequestedAt: null,
        consentRespondedAt: null,
        consentRespondedByMemberId: null,
        consentExpiresAt: null,
      },
      notification: "ADDED_NOTICE",
      subState: "NOTIFY_ONLY_AUTO_CONFIRMED",
    };
  }

  if (!consentExpiresAt) {
    // Not defensive padding: a PENDING row with no expiry is invisible to the
    // sweep's partial index and would hold a bed forever. Refuse to write it.
    throw new Error(
      "buildMemberGuestConsentWrite: an approval-required member-guest add needs a consentExpiresAt",
    );
  }

  return {
    columns: {
      consentStatus: "PENDING",
      consentRequestedAt: now,
      consentRespondedAt: null,
      consentRespondedByMemberId: null,
      consentExpiresAt,
    },
    notification: "CONSENT_REQUEST",
    subState: "AWAITING_TARGET",
  };
}

/**
 * Where a prospective guest sits relative to the booker's family boundary.
 *
 * This is computed for EVERY resolved member on EVERY path — including the
 * admin `skipAuthorization` paths — see `resolveLinkedBookingMembersWithBoundary`
 * in `booking-guests.ts`. In this release the value drives no outcome; in MG2 it
 * is what decides whether a guest row needs consent at all.
 */
export type MemberGuestBoundaryScope =
  /** Inside the booker's own family group (or the booker themselves): D-6, no consent needed. */
  | "FAMILY"
  /** Outside it: the case this whole epic exists for. Refused in this release. */
  | "BEYOND_FAMILY";

/** The computed boundary for one `resolveLinkedBookingMembers` call. */
export interface MemberGuestBoundaryState {
  /** Every normalised member id that was resolved, mapped to its scope. */
  scopeByMemberId: ReadonlyMap<string, MemberGuestBoundaryScope>;
  /** The `BEYOND_FAMILY` subset, in the order the ids were requested. */
  beyondFamilyMemberIds: readonly string[];
}

/** The consent columns MG1 provisions on `BookingGuest`. */
export interface MemberGuestConsentColumns {
  consentStatus: MemberGuestConsentStatus | null;
  consentRequestedAt: Date | null;
  consentRespondedAt: Date | null;
  consentRespondedByMemberId: string | null;
  consentExpiresAt: Date | null;
}

/**
 * The reachable consent sub-states, and exactly which columns each one sets.
 *
 * Five nullable columns are 2^5 shapes on paper; only these eight are legal.
 * Pinning the table here (rather than leaving it implied by whichever code
 * happens to write the columns) is what lets MG2, MG3, and MG4 each add a
 * writer without any of them having to re-derive the rules — and what lets a
 * reviewer check a new writer against a list instead of against their memory.
 *
 * The table is mirrored in `docs/invariants/member-guest-consent.md`
 * (`INV-GUEST-017`), quoted in the `BookingGuest` schema comment, and pinned by
 * `src/lib/__tests__/member-guest-consent.test.ts`.
 *
 * `requestedAt` is the discriminator that does the most work: it separates a
 * consent that was actually ASKED FOR from one the club granted without asking.
 * `respondedByMemberId` is the second: it distinguishes the target answering
 * for themselves from a delegate or an admin answering for them, which is why
 * MG4's admin-assigner audit needs no extra column.
 *
 * `firstReachableIn` records the release in which each shape first became
 * possible, and it is a fact about history rather than a switch: MG1 (#2306)
 * could only ever write `FAMILY_OR_LEGACY`, because a cross-family add was
 * refused before any row existed. MG2 (#2307) makes the other seven reachable.
 * The field is kept because it is the cheapest way for a reviewer to see which
 * shapes predate the feature — a row carrying an MG1 shape needs no explanation,
 * a row carrying any other one was written by code in this file's care.
 */
export const MEMBER_GUEST_CONSENT_SUB_STATES = [
  {
    id: "FAMILY_OR_LEGACY",
    /** Family-scope add (D-6), or any row written before this feature existed. */
    status: null,
    requestedAt: "null",
    respondedAt: "null",
    respondedBy: "null",
    expiresAt: "null",
    firstReachableIn: "MG1",
    note:
      "No consent was ever needed. NULL is NOT the same value as CONFIRMED and " +
      "the two must stay distinguishable forever: CONFIRMED means somebody said " +
      "yes, NULL means nobody was ever asked because nobody had to be.",
  },
  {
    id: "AWAITING_TARGET",
    /** Approval-required policy: the target has been asked and has not answered. */
    status: "PENDING",
    requestedAt: "set",
    respondedAt: "null",
    respondedBy: "null",
    expiresAt: "set",
    firstReachableIn: "MG2",
    note:
      "Holds the bed (D-4) until expiresAt, which MG2 sets from " +
      "MemberGuestSettings.pendingHoldExpiryDays. MG2's sweep reads exactly this " +
      "shape through the partial index BookingGuest_pendingConsent_expiresAt_idx.",
  },
  {
    id: "TARGET_APPROVED",
    status: "CONFIRMED",
    requestedAt: "set",
    respondedAt: "set",
    /** Equals the guest's own memberId. */
    respondedBy: "target",
    expiresAt: "any",
    firstReachableIn: "MG2",
    note: "The member who was asked said yes themselves.",
  },
  {
    id: "DELEGATE_APPROVED",
    status: "CONFIRMED",
    requestedAt: "set",
    respondedAt: "set",
    /** Differs from the guest's memberId (D-5/D-10: a target with no login). */
    respondedBy: "other",
    expiresAt: "any",
    firstReachableIn: "MG2",
    note:
      "A delegate answered for a target who cannot log in. Audited distinctly " +
      "from TARGET_APPROVED — that distinction is the whole reason " +
      "consentRespondedByMemberId exists as its own column.",
  },
  {
    id: "NOTIFY_ONLY_AUTO_CONFIRMED",
    status: "CONFIRMED",
    /** Nobody was asked, so there is no request and no response. */
    requestedAt: "null",
    respondedAt: "null",
    respondedBy: "null",
    expiresAt: "null",
    firstReachableIn: "MG2",
    note:
      "The club runs notify-only (approvalRequired false): the add is allowed " +
      "immediately and the target is told, not asked. CONFIRMED with a null " +
      "requestedAt AND a null respondedBy is the signature — it is what tells a " +
      "later reader that this consent was never actually solicited. It is " +
      "deliberately NOT written as FAMILY_OR_LEGACY: the guest IS cross-family " +
      "and that must stay visible. expiresAt is null because nothing is being " +
      "waited for: a CONFIRMED row carrying an expiry would look to MG2's sweep " +
      "like a hold with a deadline, so it is not a legal shape.",
  },
  {
    id: "ADMIN_ASSIGNED",
    status: "CONFIRMED",
    /** Nobody was asked: an admin (or a copy/pipeline flow) placed the guest. */
    requestedAt: "null",
    respondedAt: "set",
    /** The acting admin — MG4's audit rides this column, no new column needed. */
    respondedBy: "admin",
    expiresAt: "null",
    firstReachableIn: "MG2",
    note:
      "Admin adds, admin booking-copy, and pipeline rows are consent-free by " +
      "owner decision (MG4-D-a/b) but are NOT recorded as FAMILY_OR_LEGACY: the " +
      "row keeps a CONFIRMED status naming the admin who stood behind it. This " +
      "is also the booking-copy rule — consent is NOT transitive across " +
      "bookings, so a copied cross-family guest is re-stamped here against the " +
      "copying admin and never inherits the source row's TARGET_APPROVED. " +
      "expiresAt is null for the same reason as NOTIFY_ONLY_AUTO_CONFIRMED: " +
      "nobody is being waited for, so there is no deadline to record.",
  },
  {
    id: "DECLINED",
    status: "DECLINED",
    requestedAt: "set",
    respondedAt: "set",
    /** Non-null, but the model does not care WHICH of them refused. */
    respondedBy: "set",
    expiresAt: "any",
    firstReachableIn: "MG2",
    note:
      "The target (or their delegate) said no. Terminal for that request. A " +
      "refusal is an ATTRIBUTED act, so respondedBy must name somebody: MG4's " +
      "audit rides that column, and a decline nobody is recorded as making is " +
      "a broken row, not an anonymous one.",
  },
  {
    id: "EXPIRED",
    status: "EXPIRED",
    requestedAt: "set",
    respondedAt: "null",
    respondedBy: "null",
    expiresAt: "set",
    firstReachableIn: "MG2",
    note:
      "The hold lapsed with no answer and MG2's sweep released the bed. " +
      "Distinct from DECLINED: nobody refused, the clock ran out.",
  },
] as const;

export type MemberGuestConsentSubStateId =
  (typeof MEMBER_GUEST_CONSENT_SUB_STATES)[number]["id"];

/**
 * Classify a persisted guest row against the table above.
 *
 * Returns `null` when the row matches no legal sub-state, which is the useful
 * answer: it means a writer has invented a combination the model does not
 * define. MG2+ writers are expected to assert a non-null classification.
 *
 * `targetMemberId` is the guest's own `memberId` — it is what separates
 * TARGET_APPROVED from DELEGATE_APPROVED — and may be null for a non-member
 * guest row, in which case a set responder classifies as ADMIN_ASSIGNED.
 */
export function classifyMemberGuestConsent(
  row: MemberGuestConsentColumns,
  targetMemberId: string | null,
): MemberGuestConsentSubStateId | null {
  const {
    consentStatus,
    consentRequestedAt,
    consentRespondedAt,
    consentRespondedByMemberId,
    consentExpiresAt,
  } = row;

  const requested = consentRequestedAt !== null;
  const responded = consentRespondedAt !== null;
  const responder = consentRespondedByMemberId;

  if (consentStatus === null) {
    // A NULL status with any other consent column set is not "family scope with
    // extra data" — it is a broken row, and saying so is the point of the model.
    return !requested && !responded && responder === null && consentExpiresAt === null
      ? "FAMILY_OR_LEGACY"
      : null;
  }

  if (consentStatus === "PENDING") {
    return requested && !responded && responder === null && consentExpiresAt !== null
      ? "AWAITING_TARGET"
      : null;
  }

  if (consentStatus === "CONFIRMED") {
    if (!requested) {
      // Never solicited: either the club runs notify-only, or an admin placed
      // the guest. The presence of a responder is what tells them apart —
      // and NEITHER shape is waiting for anything, so a set expiresAt is a
      // stale hold deadline on an already-settled row, i.e. a broken row. Both
      // table rows say `expiresAt: "null"`, and this is where that is enforced.
      if (consentExpiresAt !== null) return null;
      if (!responded && responder === null) return "NOTIFY_ONLY_AUTO_CONFIRMED";
      if (responded && responder !== null) return "ADMIN_ASSIGNED";
      return null;
    }
    if (!responded || responder === null) return null;
    return responder === targetMemberId ? "TARGET_APPROVED" : "DELEGATE_APPROVED";
  }

  if (consentStatus === "DECLINED") {
    // A refusal is an attributed act (MG4's audit rides respondedBy), so a
    // decline with nobody recorded as refusing is not an anonymous decline —
    // it is a row no writer should have produced.
    return requested && responded && responder !== null ? "DECLINED" : null;
  }

  // EXPIRED
  return requested && !responded && responder === null && consentExpiresAt !== null
    ? "EXPIRED"
    : null;
}

/**
 * The consent columns a guest row created in THIS release carries: all null.
 *
 * Every add MG1 can reach is family-scope (D-6), because a beyond-family add is
 * refused before any row is written. Exported as the single place a future
 * writer has to change, and asserted by the dark-guarantee tests.
 */
export const CONSENT_FREE_GUEST_COLUMNS: MemberGuestConsentColumns = {
  consentStatus: null,
  consentRequestedAt: null,
  consentRespondedAt: null,
  consentRespondedByMemberId: null,
  consentExpiresAt: null,
};
