import {
  SELF_REMOVABLE_GUEST_BOOKING_STATUSES,
} from "@/lib/booking-guest-self-removal";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import type { ClubTimeZone } from "@/lib/club-time";
import {
  classifyMemberGuestConsent,
  type MemberGuestConsentColumns,
} from "@/lib/member-guest-consent";
import { formatConsentShortDate } from "@/lib/member-guest-consent-labels";

/*
  THE LABEL SHAPES LIVE NEXT DOOR, AND THIS FILE STILL PUBLISHES THEM.

  `member-guest-consent-labels.ts` holds the date, name and count labels that
  used to sit below this module's `// Date labels ---` divider. They moved in the
  CT-4 group E fix round (#2870) because the club-time correction to two of them,
  plus the explanation it has to carry, took this module over its 700-line budget
  for the first time — which the file-size ratchet refuses to allowance, and
  rightly (`size-allowances.d/README.md`).

  THE RE-EXPORT IS DELIBERATE, NOT A SHIM LEFT BEHIND. Six files import these by
  name from here, and one of them — `src/app/(admin)/admin/bookings/page.tsx` —
  is being edited right now by the sibling admin lane (#3067). Re-pointing its
  import to buy back a line count in a file it does not touch would hand two open
  pull requests a conflict over a file neither of them needed to share. The
  consent surfaces keep ONE public import surface; the labels keep their own home
  with room for their reasoning.
*/
export {
  describeConsentNightsCount,
  formatConsentFullDate,
  formatConsentGuestName,
  formatConsentNightsLabel,
  formatConsentShortDate,
  formatConsentStayLabel,
  formatConsentWeekdayDate,
} from "@/lib/member-guest-consent-labels";

/**
 * The member-visible consent surfaces' shared brain ("+ Add Member Guest",
 * epic #2305, MG2 #2307): what card the booking page shows the viewer, which
 * decline refusals are PREDICTABLE and what they say, and the per-guest badge
 * every viewer of the guest list reads.
 *
 * All of it is pure and database-free so the booking page, the delegate page
 * and the tests consume one rule. The copy is the copy the owner signed off on
 * the #2307 mockup pack (30 Jul) and must not drift from it casually — the
 * badge wording in particular is a ticked owner decision (MG2-M-2).
 *
 * THE REFUSAL MODEL FOLLOWS #2250 EXACTLY, per the mockups. Owner decision
 * D-14 subjects a member who never consented to the ordinary self-removal
 * blockers, so "No thanks" is sometimes refused. Four of those refusals are
 * predictable from facts the page already holds (booking status, check-in,
 * guest count, quote-priced), so the card warns BEFORE the click and drops the
 * "No thanks" button. The settled-payment election is NOT predictable — only
 * the full repricing pass inside the removal transaction can know it — so the
 * card keeps both buttons and repeats the server's refusal word for word if it
 * comes back. Predicting it by guessing from "has a captured payment" would
 * hide the action from members the server would in fact allow.
 */

/** The four decline refusals the page can know about before the click. */
export type PredictableConsentDeclineBlocker =
  | "BOOKING_STATUS"
  | "STAY_NOT_FUTURE"
  | "LAST_GUEST"
  | "QUOTE_PRICED";

/**
 * Predict whether the shared removal path would refuse this guest's decline.
 *
 * Mirrors `evaluateGuestSelfRemoval`'s gate ORDER (status, stay, last guest,
 * quote) so the reason shown is the one the server would actually raise first.
 * The two actor-identity blockers (`OWN_BOOKING` / `NOT_THEIR_OWN_GUEST`) do
 * not exist here: a consent decline runs under the consent authority, which
 * names the target's own row by construction.
 *
 * `today` IS REQUIRED, AND DELIBERATELY SO. The STAY_NOT_FUTURE gate outranks
 * two of the three below it, so a wall-clock default silently changes this
 * function's answer the morning a fixture's check-in date arrives — every
 * caller that forgot to pass a clock flips at midnight NZ time, and the tests
 * that pinned a check-in date go red on that day and no other. Every caller
 * that legitimately means "now" reads the clock once, by name, and passes it
 * down; nothing in this module reads it for them.
 */
export function predictConsentDeclineRefusal(params: {
  bookingStatus: string;
  bookingCheckIn: Date;
  bookingGuestCount: number;
  isQuotePriced: boolean;
  /**
   * The club's today, as the UTC-midnight `@db.Date` encoding. A caller meaning
   * "now" reads it from the club's PERSISTED timezone — `clubTodayDateOnlyInstant()`
   * on a request — never from the container's (#3123, INV-CONFIG-002).
   */
  today: Date;
}): PredictableConsentDeclineBlocker | null {
  const {
    bookingStatus,
    bookingCheckIn,
    bookingGuestCount,
    isQuotePriced,
    today,
  } = params;

  if (!SELF_REMOVABLE_GUEST_BOOKING_STATUSES.has(bookingStatus)) {
    return "BOOKING_STATUS";
  }
  // `bookingCheckIn` is a stored `@db.Date` lodge night
  // (`prisma/schema.prisma:1662`) and a calendar day takes no timezone, so it is
  // DECODED rather than projected. This module is on the CLIENT graph — three
  // components import `describeMemberGuestConsentBadge` from it — and that is
  // exactly why the temporal kind had to be settled before the zone: the correct
  // fix needs no zone plumbing into the browser at all (#3123, INV-DATE-026).
  if (storedDateOnly(bookingCheckIn) <= today) {
    return "STAY_NOT_FUTURE";
  }
  if (bookingGuestCount <= 1) {
    return "LAST_GUEST";
  }
  if (isQuotePriced) {
    return "QUOTE_PRICED";
  }
  return null;
}

/** Who is reading the warning: the member themselves, or a family delegate. */
export type ConsentRefusalVoice =
  | { kind: "TARGET" }
  | { kind: "DELEGATE"; guestFirstName: string };

/**
 * The pre-click warning for a predictable decline refusal.
 *
 * The LAST_GUEST and QUOTE_PRICED sentences are the mockup's variant A and
 * variant C copy verbatim (member voice). BOOKING_STATUS and STAY_NOT_FUTURE
 * were not drawn on the mockup pack, so their sentences are composed in the
 * same voice from the shared self-removal wording, still naming who CAN act.
 * The delegate voice restates each in the third person, since the delegate is
 * not the person whose place it is.
 */
export function describeConsentDeclineRefusal(params: {
  blocker: PredictableConsentDeclineBlocker;
  voice: ConsentRefusalVoice;
  bookerFirstName: string;
}): string {
  const { blocker, voice, bookerFirstName } = params;

  if (voice.kind === "TARGET") {
    switch (blocker) {
      case "LAST_GUEST":
        return (
          `You are the only guest on this booking, so taking you off would leave it empty. ` +
          `Only ${bookerFirstName} or the club can cancel it. Ask ${bookerFirstName} to ` +
          `cancel the booking if you do not want to go.`
        );
      case "QUOTE_PRICED":
        return (
          "This booking was priced by hand, so guests cannot be taken off it here. " +
          "Only the club can take you off — it will re-quote the request. " +
          "Reply to the club and they will sort it."
        );
      case "BOOKING_STATUS":
        return (
          "This booking is in a state where guests cannot be taken off it, so saying no " +
          `cannot release your place. Ask ${bookerFirstName} or the club to take you off ` +
          "if you do not want to go."
        );
      case "STAY_NOT_FUTURE":
        return (
          "This stay starts today or has already started, so your place can no longer be " +
          `released here. Ask ${bookerFirstName} or the club if your plans have changed.`
        );
    }
  }

  const name = voice.guestFirstName;
  switch (blocker) {
    case "LAST_GUEST":
      return (
        `${name} is the only guest on this booking, so taking ${name} off would leave it ` +
        `empty. Only ${bookerFirstName} or the club can cancel it. Ask ${bookerFirstName} ` +
        `to cancel the booking if ${name} does not want to go.`
      );
    case "QUOTE_PRICED":
      return (
        `This booking was priced by hand, so guests cannot be taken off it here. ` +
        `Only the club can take ${name} off — it will re-quote the request. ` +
        "Reply to the club and they will sort it."
      );
    case "BOOKING_STATUS":
      return (
        "This booking is in a state where guests cannot be taken off it, so saying no " +
        `cannot release ${name}'s place. Ask ${bookerFirstName} or the club to take ` +
        `${name} off if they do not want to go.`
      );
    case "STAY_NOT_FUTURE":
      return (
        "This stay starts today or has already started, so the place can no longer be " +
        `released here. Ask ${bookerFirstName} or the club if ${name}'s plans have changed.`
      );
  }
}

/** What the booking page renders for the viewer's own consent state, if anything. */
export type BookingConsentCard =
  | {
      kind: "PENDING_ASK";
      /** The viewer's own `BookingGuest` row on this booking. */
      guestId: string;
      /** When the request lapses; never null on a legal PENDING row. */
      consentExpiresAt: Date | null;
      /** A predictable decline refusal, or null when both buttons render. */
      refusalBlocker: PredictableConsentDeclineBlocker | null;
    }
  | { kind: "NOTIFY_ONLY_NOTICE" };

/**
 * Which consent card — if any — the booking detail page shows THIS viewer.
 *
 * Mirrors `resolveBookingSelfRemovalCard`'s "never offer what the server would
 * refuse" contract: the decision is made from the same facts the removal
 * service enforces, extracted here so it is unit testable rather than living
 * inline in a server component.
 *
 * Two cards exist and both are about the viewer's OWN row:
 *
 *  - `PENDING_ASK` — the viewer is the target of an unanswered request (owner
 *    decision D-11 gives that row full booking-page access, so the card sits
 *    inside the real page). Carries the predictable-refusal answer.
 *  - `NOTIFY_ONLY_NOTICE` — the viewer was told, not asked (D-3 opt-down).
 *    There is no question to answer, so the card only points at the #2250
 *    self-removal card below it — which is why it renders ONLY when that card
 *    is present: a pointer at a card that is not there would dangle.
 *
 * A soft-deleted booking gets neither. An ADMIN_ASSIGNED viewer gets neither —
 * their row was placed by the club and the ordinary page already tells the
 * truth about it. Unlike the self-removal card this does NOT hide from admin
 * viewers: a pending request is the viewer's own business whatever hat they
 * wear, and hiding it would strand their answer.
 */
export function resolveBookingConsentCard(params: {
  actorMemberId: string;
  bookingDeletedAt: Date | null;
  bookingStatus: string;
  bookingCheckIn: Date;
  guests: readonly ({ id: string; memberId: string | null } & MemberGuestConsentColumns)[];
  /** `isQuotePricedBooking`'s answer; the page supplies it (one indexed lookup). */
  isQuotePriced: boolean;
  /** Whether the #2250 self-removal card renders on this page for this viewer. */
  selfRemovalCardPresent: boolean;
  /** Today as an NZ lodge date — required for the same reason as above. */
  today: Date;
}): BookingConsentCard | null {
  const {
    actorMemberId,
    bookingDeletedAt,
    bookingStatus,
    bookingCheckIn,
    guests,
    isQuotePriced,
    selfRemovalCardPresent,
    today,
  } = params;

  if (bookingDeletedAt) return null;
  if (!actorMemberId) return null;

  const viewerGuest = guests.find((guest) => guest.memberId === actorMemberId);
  if (!viewerGuest) return null;

  if (viewerGuest.consentStatus === "PENDING") {
    return {
      kind: "PENDING_ASK",
      guestId: viewerGuest.id,
      consentExpiresAt: viewerGuest.consentExpiresAt,
      refusalBlocker: predictConsentDeclineRefusal({
        bookingStatus,
        bookingCheckIn,
        bookingGuestCount: guests.length,
        isQuotePriced,
        today,
      }),
    };
  }

  const subState = classifyMemberGuestConsent(viewerGuest, viewerGuest.memberId);
  if (subState === "NOTIFY_ONLY_AUTO_CONFIRMED" && selfRemovalCardPresent) {
    return { kind: "NOTIFY_ONLY_NOTICE" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Guest-list consent badges (owner decision MG2-M-2)
// ---------------------------------------------------------------------------

export type MemberGuestConsentBadgeTone = "pending" | "ok" | "blocked";

export interface MemberGuestConsentBadge {
  tone: MemberGuestConsentBadgeTone;
  label: string;
}

/**
 * Who is reading the guest list: an ordinary member on the booking page, an
 * admin-area viewer, or the booker inside the booking WIZARD.
 *
 * THE THIRD AUDIENCE IS AN OWNER DECISION, TAKEN AGAINST THE RECOMMENDATION
 * (sign-off on #2308, 31 Jul 2026, question 1). The wizard says "Waiting for Sam
 * to approve" / "Sam approved" / "Sam will be told"; the booking-detail page
 * keeps the wording MG2 shipped. That is deliberately two vocabularies for one
 * underlying thing, and the owner accepted that cost for warmer wording at the
 * moment of booking.
 *
 * IT IS AN AUDIENCE AND NOT A SECOND FUNCTION, and that is the whole point of
 * doing it this way. A forked copy of the wording logic in the wizard is exactly
 * how the two sets drift apart the first time a consent state is added or a rule
 * changes. One function, one state machine, three audiences — so a new
 * sub-state cannot be introduced without all three being written, and
 * `member-guest-consent-card.test.ts` fails if the table below is not total.
 */
export type MemberGuestConsentBadgeAudience = "MEMBER" | "ADMIN" | "WIZARD";

/**
 * The per-guest consent badge, or null for the rows that must not change.
 *
 * Family and non-member guests — the overwhelming majority of rows, forever —
 * return null: no badge, no layout change. The wording is owner decision
 * MG2-M-2 as ticked (30 Jul), drawn on two mockups, and THE TWO MOCKUPS DO NOT
 * SAY THE SAME THING — which is why this function takes an audience:
 *
 *  - `docs/member-guests/mockups/member-surfaces.html` (the guest list a member
 *    reads) signs off the BARE forms: "Consented", "Added by the club",
 *    "Told, not asked", and "Said no — still on the booking".
 *  - `docs/member-guests/mockups/admin-surfaces.html` (the same list read by the
 *    club) signs off the NAMED AND DATED forms: "Consented 2 Aug", "Consented
 *    by Ana Kaur, 2 Aug", "Added by Jo Admin", and the operational "Said no —
 *    could not be removed" / "Lapsed — could not be removed".
 *
 * The split is a privacy rule, not a styling preference. The responder is very
 * often a family adult who is NOT on the booking at all (D-9 makes a member
 * with no login the normal consent target, so a parent or partner answers for
 * them). Naming that person to every member who can open the booking would
 * disclose someone who is not a participant in it. The club, which already
 * holds the whole family record and has to act on these rows, sees the name and
 * the date. Members see only that the answer was given.
 *
 * `responderName` is the display name of `consentRespondedByMemberId`, looked
 * up by the caller (this module stays database-free) and only worth looking up
 * for an ADMIN audience. When the responder's member record has since vanished
 * the badge falls back to a form that is still true — "Added by the club", or a
 * "Consented" with only the date on it.
 *
 * The member wording for a LAPSED row ("Lapsed — still on the booking") is the
 * one badge the member mockup does not draw; it is composed in the member
 * mockup's own voice from the declined row directly above it, because "could
 * not be removed" is club-operations language and says nothing a member can act
 * on. That is a declared deviation.
 *
 * A row that matches NO legal sub-state still gets an honest badge from its
 * raw status rather than disappearing: a broken row a viewer cannot see is a
 * broken row nobody ever fixes.
 *
 * `targetFirstName` is the GUEST's own first name and is read by the `WIZARD`
 * audience only — see `describeMemberGuestConsentBadgeForWizard` below for the
 * full eight-state mapping and for why naming the target is safe where naming
 * the responder is not.
 *
 * THE PARAMETERS ARE A UNION ON THE AUDIENCE, AND THAT IS WHERE THE CLUB'S ZONE
 * SITS (#3123). The MEMBER and ADMIN badges stamp a real instant —
 * `consentExpiresAt` on a pending row, `consentRespondedAt` on a confirmed one —
 * which has no civil day until a zone is chosen, and that zone is the club's
 * PERSISTED setting (`INV-CONFIG-002`), never the container's and never the
 * browser's. So those two audiences REQUIRE it. The WIZARD badge renders no date
 * at all (its eight strings are names and verbs), so demanding a zone from it
 * would be ceremony — and, more to the point, all three of its callers are
 * `"use client"` components that would have had to reach for `useClubTime()` to
 * satisfy a parameter they never read. Splitting on the audience is what made
 * this a two-page change instead of a five-component one, and it stays honest:
 * the day a wizard badge gains a date, the type demands the zone.
 */
export function describeMemberGuestConsentBadge(
  params:
    | {
        guest: { memberId: string | null } & MemberGuestConsentColumns;
        audience: Extract<MemberGuestConsentBadgeAudience, "WIZARD">;
        targetFirstName?: string | null;
      }
    | {
        // Written as an EXCLUSION rather than as `"MEMBER" | "ADMIN"` so a
        // fourth audience lands on the arm that REQUIRES the club's zone until
        // somebody deliberately moves it, rather than on the one that renders
        // dates without asking for one.
        guest: { memberId: string | null } & MemberGuestConsentColumns;
        audience: Exclude<MemberGuestConsentBadgeAudience, "WIZARD">;
        responderName?: string | null;
        /** The club's persisted timezone — these two audiences stamp instants. */
        timeZone: ClubTimeZone;
      },
): MemberGuestConsentBadge | null {
  const { guest, audience } = params;
  const forClub = audience === "ADMIN";

  if (guest.consentStatus === null) return null;

  const subState = classifyMemberGuestConsent(guest, guest.memberId);

  if (params.audience === "WIZARD") {
    return describeMemberGuestConsentBadgeForWizard(
      guest.consentStatus,
      subState,
      params.targetFirstName ?? null,
    );
  }

  // Past the WIZARD return, `params` is narrowed to the audiences that stamp an
  // instant, so the club's zone and the responder name are both present by
  // construction rather than by convention (#3123).
  const { responderName, timeZone } = params;

  switch (guest.consentStatus) {
    case "PENDING":
      return {
        tone: "pending",
        label: guest.consentExpiresAt
          ? `Waiting for consent · expires ${formatConsentShortDate(guest.consentExpiresAt, timeZone)}`
          : "Waiting for consent",
      };
    case "CONFIRMED":
      if (subState === "NOTIFY_ONLY_AUTO_CONFIRMED") {
        return { tone: "ok", label: "Told, not asked" };
      }
      if (subState === "ADMIN_ASSIGNED") {
        return {
          tone: "ok",
          label:
            forClub && responderName
              ? `Added by ${responderName}`
              : "Added by the club",
        };
      }
      if (forClub && subState === "DELEGATE_APPROVED" && responderName) {
        return {
          tone: "ok",
          label: guest.consentRespondedAt
            ? `Consented by ${responderName}, ${formatConsentShortDate(guest.consentRespondedAt, timeZone)}`
            : `Consented by ${responderName}`,
        };
      }
      if (forClub && guest.consentRespondedAt) {
        return {
          tone: "ok",
          label: `Consented ${formatConsentShortDate(guest.consentRespondedAt, timeZone)}`,
        };
      }
      return { tone: "ok", label: "Consented" };
    case "DECLINED":
      return {
        tone: "blocked",
        label: forClub
          ? "Said no — could not be removed"
          : "Said no — still on the booking",
      };
    case "EXPIRED":
      return {
        tone: "blocked",
        label: forClub
          ? "Lapsed — could not be removed"
          : "Lapsed — still on the booking",
      };
    default:
      return null;
  }
}

/**
 * The booking wizard's warmer, name-bearing vocabulary — all eight sub-states.
 *
 * OWNER DECISION, TAKEN AGAINST THE RECOMMENDATION (#2308 sign-off, 31 Jul
 * 2026, question 1). The owner was shown both options and chose the warmer
 * wording knowing it means the same underlying thing is called two different
 * things in two places. It is implemented as a third audience of THIS function
 * rather than as a copy in the wizard so the two vocabularies are produced from
 * one state machine and cannot drift.
 *
 * THE FULL MAPPING — every sub-state, including the ones a booker can only meet
 * while EDITING a booking rather than creating one, because the badge helper is
 * shared and a partial table is how the edit path ends up with a blank badge:
 *
 * | sub-state                  | MEMBER (booking page)          | WIZARD                                   |
 * |----------------------------|--------------------------------|------------------------------------------|
 * | FAMILY_OR_LEGACY           | (no badge)                     | (no badge)                               |
 * | AWAITING_TARGET            | Waiting for consent · expires… | Waiting for Sam to approve               |
 * | TARGET_APPROVED            | Consented                      | Sam approved                             |
 * | DELEGATE_APPROVED          | Consented                      | Sam approved                             |
 * | NOTIFY_ONLY_AUTO_CONFIRMED | Told, not asked                | Sam will be told                         |
 * | ADMIN_ASSIGNED             | Added by the club              | Added by the club                        |
 * | DECLINED                   | Said no — still on the booking | Sam said no — still on the booking       |
 * | EXPIRED                    | Lapsed — still on the booking  | Sam didn't answer — still on the booking |
 *
 * WHY TARGET_APPROVED AND DELEGATE_APPROVED ARE THE SAME STRING, and this is a
 * privacy rule rather than laziness. The member-facing audience deliberately
 * collapses them (see the note above) because the responder is very often a
 * family adult who is not on the booking at all, and telling the booker that
 * somebody ELSE answered discloses that the target holds no login — which is
 * usually a way of saying they are a child. The wizard is a member-facing
 * surface, so it must preserve exactly that non-distinguishability. It is
 * asserted directly: a test requires the two sub-states to produce an IDENTICAL
 * label for both MEMBER and WIZARD, so a future "improvement" that names the
 * delegate here fails.
 *
 * The cost is a small imprecision — "Sam approved" when Sam's parent answered
 * for Sam — and it is declared rather than hidden. The badge's meaning is "the
 * answer came back yes for Sam", which is true in both shapes.
 *
 * WHY ADMIN_ASSIGNED IS NOT NAME-BEARING. The warm wording names the TARGET;
 * naming the acting admin is the ADMIN audience's job and would disclose a club
 * officer's identity to every booker. "Added by the club" is already plain
 * English and needs no first name to be warm.
 *
 * WHY THE PENDING BADGE CARRIES NO DATE. The expiry date is the booking-detail
 * page's shape ("expires 7 Aug"), and in the wizard nothing has been requested
 * yet — the booking does not exist, so there is no real deadline to quote. A
 * date here would be an invented promise.
 *
 * NO FIRST NAME AVAILABLE falls back to the MEMBER wording for that state rather
 * than inventing a name or printing an empty gap. It is a fallback, not a
 * second vocabulary: every string it can return is one the MEMBER audience
 * already ships.
 */
function describeMemberGuestConsentBadgeForWizard(
  consentStatus: NonNullable<MemberGuestConsentColumns["consentStatus"]>,
  subState: ReturnType<typeof classifyMemberGuestConsent>,
  targetFirstName: string | null,
): MemberGuestConsentBadge | null {
  const name = targetFirstName?.trim() || null;

  switch (consentStatus) {
    case "PENDING":
      return {
        tone: "pending",
        label: name ? `Waiting for ${name} to approve` : "Waiting for consent",
      };
    case "CONFIRMED":
      if (subState === "NOTIFY_ONLY_AUTO_CONFIRMED") {
        return {
          tone: "ok",
          label: name ? `${name} will be told` : "Told, not asked",
        };
      }
      if (subState === "ADMIN_ASSIGNED") {
        return { tone: "ok", label: "Added by the club" };
      }
      // TARGET_APPROVED, DELEGATE_APPROVED, and any CONFIRMED row that matches
      // no legal shape: one string, on purpose (see the note above).
      return { tone: "ok", label: name ? `${name} approved` : "Consented" };
    case "DECLINED":
      return {
        tone: "blocked",
        label: name
          ? `${name} said no — still on the booking`
          : "Said no — still on the booking",
      };
    case "EXPIRED":
      return {
        tone: "blocked",
        label: name
          ? `${name} didn't answer — still on the booking`
          : "Lapsed — still on the booking",
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The review-step explainer (MG3 #2308, owner sign-off answer 4)
// ---------------------------------------------------------------------------

/**
 * The four sentences the booker is shown at the review step while anybody they
 * added is still deciding — ALL FOUR, ALWAYS VISIBLE, never behind a disclosure
 * link.
 *
 * OWNER DECISION (#2308 sign-off, 31 Jul 2026, question 4), and the two
 * sentences that make it matter are the ones the owner was asked to read
 * specifically, because they exist only because of earlier non-recommended
 * ticks on the epic:
 *
 *  - Sentence 3 is D-11 as ticked. A pending guest gets FULL booking-page access
 *    the moment they are added, so they see the other guests' names before they
 *    decide — including if the booker added them by mistake. A member who meets
 *    that after the fact has a legitimate complaint, so they are told before the
 *    money.
 *  - Sentence 4 is D-13 and D-14 as ticked. Consent covers the booking HOWEVER
 *    it later changes, so a booker can move a July weekend to September and
 *    nobody is asked again; and the ordinary self-removal blockers apply to a
 *    guest who never consented, so "they can always take themselves off" is
 *    false and must not be written.
 *
 * WHAT THIS COPY IS FORBIDDEN FROM SAYING, written down because the forbidden
 * versions are the ones that read better and a future editor will be tempted:
 * NOT "we'll ask them again if you change the dates" (D-13 says the opposite),
 * and NOT "they can always take themselves off" (D-14 says the opposite).
 * Pinned by a test that asserts both phrases are absent.
 */
export const MEMBER_GUEST_REVIEW_EXPLAINER = Object.freeze({
  decline: "If they say no, they come off the booking and it's repriced.",
  disclosure:
    "As soon as you add them they can see this booking, including the other guests' names — before they decide.",
  scopeAndRemoval:
    "Their approval covers this booking including any later changes you make to it. " +
    "They can take themselves off the booking, subject to the usual limits once it's been priced or paid.",
} as const);

/**
 * Sentence 1 — the D-4 hold and its expiry, with the club's own configured
 * number of days.
 *
 * The number comes from `MemberGuestSettings.pendingHoldExpiryDays` and is never
 * hard-coded here: a club that shortened the hold to two days must not be told
 * seven.
 */
export function describeMemberGuestHoldSentence(pendingHoldExpiryDays: number): string {
  const days = Math.max(1, Math.round(pendingHoldExpiryDays));
  return (
    `Their bed is held while you wait. If they haven't answered within ${days} ` +
    `day${days === 1 ? "" : "s"}, they'll come off the booking automatically and it will be repriced.`
  );
}

/**
 * The explainer's heading — "Sam hasn't answered yet".
 *
 * Names the people who are waiting, which is safe here for the same reason the
 * wizard badge names them: the booker chose them and already knows who they are.
 * Beyond two names it degrades to a count rather than a list, so a large party
 * does not produce a heading nobody reads.
 */
export function describeMemberGuestPendingHeading(
  firstNames: readonly string[],
): string {
  const names = firstNames.map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) return "Somebody hasn't answered yet";
  if (names.length === 1) return `${names[0]} hasn't answered yet`;
  if (names.length === 2) return `${names[0]} and ${names[1]} haven't answered yet`;
  return `${names.length} guests haven't answered yet`;
}
