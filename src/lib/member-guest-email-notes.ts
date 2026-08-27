import {
  evaluateGuestSelfRemoval,
  type GuestSelfRemovalBlocker,
} from "@/lib/booking-guest-self-removal";
import { addDaysDateOnly } from "@/lib/date-only";
import { emailCalendarDay, emailClubDate } from "@/lib/email-templates-club-time";
import { escapeHtml } from "@/lib/email-templates/escape";
import { formatCents } from "@/lib/utils";

/**
 * The composed sentences and blocks the four member-guest emails are built from
 * (epic #2305, MG2 #2307).
 *
 * WHY THIS MODULE EXISTS AT ALL. `renderTemplateString` is a flat regex
 * substitution with no syntax of its own — no conditional, no loop, no section.
 * So every value that can be absent, vary by case, or repeat has to arrive as
 * ONE pre-composed token that the server built: the default body carries the
 * token alone on its own line and the sender emits either the whole block or the
 * empty string. That is the same shape `{{provisionalGuestsNote}}`
 * (booking-confirmed) and `{{refundMessage}}` (booking-cancelled) already use.
 *
 * AND WHY THE COMPOSERS ARE HERE RATHER THAN IN THE SENDERS. Each of these
 * values is rendered TWICE — once as flat text for the editable default body,
 * once as HTML for the hand-built template — and the two must never drift. Both
 * renderings are produced from one call to one composer in this file, so a
 * change to the wording cannot land in one and miss the other. The party
 * listing goes furthest: `buildMemberGuestPartyList` returns the flat text and
 * the HTML `<ul>` from a single pass over a single ordered array of names, and a
 * test asserts the two list the same names in the same order.
 *
 * DATES COME IN TWO KINDS AND ARE NOT RENDERED THE SAME WAY (#3123). A guest
 * night (`BookingGuestNight.stayDate`) and a stay's `checkIn`/`checkOut`
 * (`Booking.checkIn`/`checkOut`) are `@db.Date` calendar days, which have no
 * timezone — they go through `emailCalendarDay`, which consults none and
 * refuses a value carrying a time of day. A consent deadline
 * (`BookingGuest.consentExpiresAt`, and the `new Date()` a lapse sweep falls
 * back to) is a real moment with no calendar day of its own, so it is projected
 * through the club's persisted zone by `emailClubDate`. Both come from
 * `@/lib/email-templates-club-time` — the SAME two functions
 * `email/member-guest.ts` renders these very values with, which is what keeps
 * the two rendering paths above from disagreeing about a date as well as a word.
 */

/** One person on the booking, as the party listing names them (MG2-D-a). */
export interface MemberGuestPartyMember {
  firstName: string;
  lastName: string;
}

export interface MemberGuestPartyList {
  /**
   * The `{{partyListNote}}` value: the heading and the list as plain text, or
   * the empty string when there is nobody to list.
   */
  text: string;
  /**
   * The same names, in the same order, as an already-HTML-ESCAPED heading plus
   * `<ul>`. Embed it verbatim — passing it through `escapeHtml` again would
   * print the markup to the member.
   */
  html: string;
  /** The names exactly as both renderings list them, in order. */
  names: string[];
}

/**
 * The heading lives INSIDE the token, not in the default body above it.
 *
 * If the body carried its own "Everyone on this booking" line and the token were
 * empty — a booking whose guest list could not be loaded — the member would read
 * a bare heading with nothing under it. Keeping the heading in the composed
 * block means an empty list renders as nothing at all.
 */
const PARTY_LIST_HEADING = "Everyone on this booking";

/**
 * The full party listing, names only.
 *
 * Owner decision MG2-D-a: every guest's first AND last name, and NO MONEY
 * anywhere — not a per-guest price, not a total. (An honest caveat recorded in
 * the mockup pack: under D-11 the member can open the booking page and see
 * every price there. Leaving money out of the email is a courtesy, not a
 * control.) The parameter type carries only the two name fields so a priced
 * guest row cannot be splatted in whole by accident.
 */
export function buildMemberGuestPartyList(
  party: readonly MemberGuestPartyMember[],
): MemberGuestPartyList {
  const names = party
    .map((member) => `${member.firstName} ${member.lastName}`.trim())
    .filter((name) => name.length > 0);

  if (names.length === 0) {
    return { text: "", html: "", names: [] };
  }

  // No trailing newline. The default body already sits the token between blank
  // lines, and `plainTextEmailTemplate` splits the rendered body on runs of
  // blank lines and drops empty blocks — so a trailing newline here would only
  // widen the gap, and an empty token collapses cleanly on its own.
  const text = [
    `${PARTY_LIST_HEADING}:`,
    ...names.map((name) => `- ${name}`),
  ].join("\n");

  const html = [
    `<p style="margin: 0 0 6px 0; font-size: 15px; font-weight: 700;">${escapeHtml(PARTY_LIST_HEADING)}</p>`,
    `<ul style="margin: 0 0 16px 0; padding: 0 0 0 20px; font-size: 15px; line-height: 1.6;">`,
    ...names.map((name) => `  <li>${escapeHtml(name)}</li>`),
    `</ul>`,
  ].join("\n");

  return { text, html, names };
}

/**
 * The `{{guestNightsLabel}}` value: which nights THIS guest is down for.
 *
 * Listed night by night rather than given as a range, because a member added to
 * part of somebody else's stay needs to check the actual nights, and because a
 * range would read as a check-in/check-out pair the guest row does not
 * necessarily have. A long contiguous run collapses to a range — past three
 * nights the list stops being scannable and a contiguous run loses nothing by
 * being stated as its ends.
 *
 * Dates are formatted with `emailCalendarDay`, the shared email seam for a
 * STORED CALENDAR DAY, so the label reads in the same medium style
 * ("8 Aug 2026") as every other date in every other email — and as the
 * registry's own date sample, so an admin previewing an override sees the real
 * shape. A guest night is `BookingGuestNight.stayDate`, a `@db.Date` column, so
 * it takes no timezone at all; it used to go through `formatNZDate`, which
 * projected the stored encoding through the container's zone and named the
 * previous night for any club behind Greenwich (#3123).
 */
export function composeGuestNightsLabel(nights: readonly Date[]): string {
  const ordered = Array.from(
    new Map(nights.map((night) => [night.getTime(), night])).values(),
  ).sort((a, b) => a.getTime() - b.getTime());

  if (ordered.length === 0) return "";

  const count = ordered.length;
  const suffix = `(${count} night${count === 1 ? "" : "s"})`;
  const contiguous = ordered.every(
    (night, index) =>
      index === 0 ||
      addDaysDateOnly(ordered[index - 1], 1).getTime() === night.getTime(),
  );

  if (count > 3 && contiguous) {
    return `${emailCalendarDay(ordered[0])} to ${emailCalendarDay(ordered[count - 1])} ${suffix}`;
  }

  return `${ordered.map((night) => emailCalendarDay(night)).join(", ")} ${suffix}`;
}

// ---------------------------------------------------------------------------
// member-guest-consent-request
// ---------------------------------------------------------------------------

/**
 * Who is reading the consent request.
 *
 * Owner decision D-9 makes a target with no login of their own the NORMAL case,
 * not an edge case, so the request routinely goes to a family delegate instead
 * of to the member being added. The approved copy in the mockup pack was written
 * for the direct case only ("has put YOU down as a guest"), which would tell a
 * parent they are being added to a lodge booking when it is their nine-year-old
 * who is. There is no conditional in the template language, so the two
 * recipient-relative sentences are composed here instead. The direct case is
 * word-for-word the approved copy.
 */
export type MemberGuestConsentAudience =
  /** The member being added is reading it and answers for themselves. */
  | { kind: "TARGET" }
  /** A family delegate is reading it and answers on the target's behalf (D-5/D-9). */
  | { kind: "DELEGATE"; guest: MemberGuestPartyMember };

export interface MemberGuestConsentAskCopy {
  /** `{{askHeading}}` — the first block, and therefore the email's heading. */
  heading: string;
  /** `{{askContextNote}}` — what is being asked, of whom, and why them. */
  contextNote: string;
}

export function composeMemberGuestConsentAsk(params: {
  bookerName: string;
  audience: MemberGuestConsentAudience;
}): MemberGuestConsentAskCopy {
  const { bookerName, audience } = params;

  if (audience.kind === "TARGET") {
    return {
      heading: `Can ${bookerName} add you to this booking?`,
      contextNote:
        `${bookerName} has put you down as a guest on a lodge booking. ` +
        "Nothing is settled until you answer - a bed is held for you in the meantime.",
    };
  }

  const guestName = `${audience.guest.firstName} ${audience.guest.lastName}`.trim();
  const guestFirstName = audience.guest.firstName;
  return {
    heading: `Can ${bookerName} add ${guestName} to this booking?`,
    contextNote:
      `${bookerName} has put ${guestName} down as a guest on a lodge booking. ` +
      `${guestFirstName} does not have a login of their own, so you are being asked as an ` +
      `adult in their family group — your answer counts as ${guestFirstName}'s, and your ` +
      `name is recorded against it. Nothing is settled until you answer - a bed is held ` +
      `for ${guestFirstName} in the meantime.`,
  };
}

// ---------------------------------------------------------------------------
// member-guest-added
// ---------------------------------------------------------------------------

/**
 * Why the member is on the booking without having been asked.
 *
 * ONE template covers all three, told apart by this one composed sentence, so an
 * admin editing the wording has one place to edit rather than three near-copies
 * to keep in step. MG4 reuses the template unchanged for the booking-request
 * pipeline, which is the reason it is one template and not three.
 */
export type MemberGuestAddedContext =
  /** The club runs notify-only (D-3 opt-down): told, not asked. */
  | "NOTIFY_ONLY"
  /** An admin or booking officer added them on somebody's behalf (MG4-D-a). */
  | "ADMIN"
  /** The row came from an approved public booking request (MG4-D-a). */
  | "BOOKING_REQUEST";

export interface MemberGuestAddedCopy {
  /** `{{addedHeading}}` — the first block, and therefore the email's heading. */
  heading: string;
  /** `{{addedContextNote}}` — the sentence that tells the three paths apart. */
  contextNote: string;
}

/**
 * The added-notice's heading and opening sentence.
 *
 * TAKES AN AUDIENCE FOR THE SAME REASON THE CONSENT REQUEST DOES, and this was a
 * real defect for one release-candidate's worth of work: owner decision D-9 makes
 * a target with no login of their own the normal case, so this notice routinely
 * lands in a family adult's inbox, and "you have been added to a lodge booking"
 * then names the wrong person entirely — it tells a parent THEY are going to the
 * lodge. The delegate wording names the guest and says why the reader is the one
 * being told.
 */
export function composeMemberGuestAdded(params: {
  context: MemberGuestAddedContext;
  bookerName: string;
  audience: MemberGuestConsentAudience;
}): MemberGuestAddedCopy {
  const { context, bookerName, audience } = params;

  if (audience.kind === "TARGET") {
    return {
      heading: "You have been added to a lodge booking",
      contextNote: composeAddedContextNoteForTarget(context, bookerName),
    };
  }

  const guestName = `${audience.guest.firstName} ${audience.guest.lastName}`.trim();
  const guestFirstName = audience.guest.firstName;
  // Composed once rather than repeated three times: the reason the DELEGATE is
  // the one holding this email is the same whichever path created the row.
  const whyYou =
    ` You are being told because ${guestFirstName} does not have a login of their ` +
    "own and you are an adult in their family group.";

  return {
    heading: `${guestName} has been added to a lodge booking`,
    contextNote:
      composeAddedContextNoteForDelegate(context, bookerName, guestName, guestFirstName) +
      whyYou,
  };
}

function composeAddedContextNoteForTarget(
  context: MemberGuestAddedContext,
  bookerName: string,
): string {
  switch (context) {
    case "NOTIFY_ONLY":
      return (
        `${bookerName} has added you as a guest on a lodge booking. Your place is ` +
        "already held — this club does not ask first for member guests."
      );
    case "ADMIN":
      return `the club has added you as a guest on a lodge booking on behalf of ${bookerName}.`;
    case "BOOKING_REQUEST":
      return (
        "the club has added you as a guest on a lodge booking created from " +
        `${bookerName}'s booking request.`
      );
  }
}

function composeAddedContextNoteForDelegate(
  context: MemberGuestAddedContext,
  bookerName: string,
  guestName: string,
  guestFirstName: string,
): string {
  switch (context) {
    case "NOTIFY_ONLY":
      return (
        `${bookerName} has added ${guestName} as a guest on a lodge booking. ` +
        `${guestFirstName}'s place is already held — this club does not ask first ` +
        "for member guests."
      );
    case "ADMIN":
      return `the club has added ${guestName} as a guest on a lodge booking on behalf of ${bookerName}.`;
    case "BOOKING_REQUEST":
      return (
        `the club has added ${guestName} as a guest on a lodge booking created from ` +
        `${bookerName}'s booking request.`
      );
  }
}

// ---------------------------------------------------------------------------
// member-guest-request-withdrawn (MG4 #2309)
// ---------------------------------------------------------------------------

/**
 * Why the member is no longer on (or no longer being asked about) the booking.
 *
 * THE COUNTERPART TO `MemberGuestAddedContext`, AND FOR THE SAME REASON. MG2
 * told a member they were on somebody's booking. Three things can subsequently
 * unsay that, and to the reader they are three different events — but they are
 * the same email, so the difference is one composed sentence rather than three
 * near-identical templates an admin would have to keep in step.
 *
 * WHY IT IS NOT CALLED "cancelled". Every one of these is somebody else's
 * decision about the reader, and the reader did nothing wrong; the wording
 * throughout says what happened and who to ask, and never implies the member
 * withdrew or was rejected.
 */
export type MemberGuestWithdrawnContext =
  /**
   * A consent request that was still waiting for an answer was called off — the
   * booker changed their plans, or an admin withdrew it. Distinct from the
   * request LAPSING, which has its own template
   * (`member-guest-consent-expired`): a lapse is the clock running out, this is
   * a person deciding.
   */
  | "REQUEST_CANCELLED"
  /** A settled member guest was taken off the booking by the booker or the club. */
  | "TAKEN_OFF"
  /**
   * The booking-request pipeline swapped them out at approval (MG4-D-b). Its own
   * case because the reader was never asked in the first place — they were
   * placed on the booking by the club and are now being unplaced by the club, and
   * "the booker changed their mind" would name somebody they never dealt with.
   */
  | "BOOKING_REQUEST_REPLACED";

export interface MemberGuestWithdrawnCopy {
  /** `{{withdrawnHeading}}` — the first block, and therefore the email's heading. */
  heading: string;
  /** `{{withdrawnContextNote}}` — the sentence that tells the three cases apart. */
  contextNote: string;
}

/**
 * The withdrawal notice's heading and opening sentence.
 *
 * Takes an audience for exactly the reason `composeMemberGuestAdded` does: under
 * D-9 the reader is routinely a family adult rather than the guest, and "you are
 * no longer on the booking" would then be addressed to somebody who never was.
 */
export function composeMemberGuestWithdrawn(params: {
  context: MemberGuestWithdrawnContext;
  bookerName: string;
  audience: MemberGuestConsentAudience;
}): MemberGuestWithdrawnCopy {
  const { context, bookerName, audience } = params;

  if (audience.kind === "TARGET") {
    return {
      heading:
        context === "REQUEST_CANCELLED"
          ? // Mockup panel 8, word for word. "Withdrawn" rather than "called
            // off" so the heading and the (now name-free) opening sentence use
            // one verb for one event.
            "That request has been withdrawn"
          : "You are no longer on that lodge booking",
      contextNote: composeWithdrawnContextNoteForTarget(context, bookerName),
    };
  }

  const guestName = `${audience.guest.firstName} ${audience.guest.lastName}`.trim();
  const guestFirstName = audience.guest.firstName;
  const whyYou =
    ` You are being told because ${guestFirstName} does not have a login of their ` +
    "own and you are an adult in their family group.";

  return {
    heading:
      context === "REQUEST_CANCELLED"
        ? `The request about ${guestName} has been withdrawn`
        : `${guestName} is no longer on that lodge booking`,
    contextNote:
      composeWithdrawnContextNoteForDelegate(context, bookerName, guestFirstName) +
      whyYou,
  };
}

function composeWithdrawnContextNoteForTarget(
  context: MemberGuestWithdrawnContext,
  bookerName: string,
): string {
  switch (context) {
    case "REQUEST_CANCELLED":
      // NAMES NOBODY, and that is the signed-off answer to mockup question 3
      // rather than a stylistic choice. This case is chosen from the ROW's
      // consent status (still PENDING), not from who acted: the guest-removal
      // route and the batch modification both reach it whether the booker
      // cancelled or a club officer withdrew the request. Naming the booker was
      // therefore wrong about half the time, and where an officer had acted it
      // also put a staff member's name in front of somebody who is not on the
      // booking. The neutral shape is true whoever it was — see panel 8.
      //
      // TAKEN_OFF keeps its possessive phrasing deliberately: a settled place
      // exists on a specific person's booking, and the reader has been told
      // whose it is already.
      return (
        "the request to add you as a guest on a lodge booking has been " +
        "withdrawn, so there is nothing left for you to answer and the bed " +
        "that was being held for you has been released."
      );
    case "TAKEN_OFF":
      return `you have been taken off ${bookerName}'s lodge booking, so you no longer have a place on it.`;
    case "BOOKING_REQUEST_REPLACED":
      return (
        "the club has taken you off a lodge booking created from a booking " +
        "request, so you no longer have a place on it."
      );
  }
}

function composeWithdrawnContextNoteForDelegate(
  context: MemberGuestWithdrawnContext,
  bookerName: string,
  guestFirstName: string,
): string {
  switch (context) {
    case "REQUEST_CANCELLED":
      // Name-free for the same reason as the target voice above — the case is
      // chosen from the row, not from the actor, so it cannot honestly name one.
      return (
        `the request to add ${guestFirstName} as a guest on a lodge booking has ` +
        "been withdrawn, so there is nothing left to answer and the bed that was " +
        "being held has been released."
      );
    case "TAKEN_OFF":
      return `${guestFirstName} has been taken off ${bookerName}'s lodge booking, so they no longer have a place on it.`;
    case "BOOKING_REQUEST_REPLACED":
      return (
        `the club has taken ${guestFirstName} off a lodge booking created from a ` +
        "booking request, so they no longer have a place on it."
      );
  }
}

/**
 * The `{{removalNote}}` value when the member CAN take themselves off.
 *
 * Exported because it is the phrase the agreement test looks for: the note must
 * offer this exactly when `evaluateGuestSelfRemoval` says the removal would be
 * allowed, and must never offer it when it would be refused.
 */
export const MEMBER_GUEST_SELF_REMOVAL_OFFER =
  "If you would rather not go, you can take yourself off the booking from your account.";

/**
 * What to say instead, per refusal reason.
 *
 * Owner decision D-14 makes the ORDINARY self-removal blockers apply to a member
 * who never consented, so these are reached in normal operation and not only in
 * theory. Three reuse `describeGuestSelfRemovalBlocker`'s wording verbatim
 * because it already names a real remedy (cancel the booking, ask the owner or
 * the club). Two do not:
 *
 *  - QUOTE_PRICED. The shared wording ends "ask the person who made the booking,
 *    or the club, to take you off it" — but the person who made the booking
 *    CANNOT, and asking them is a dead end. The real remedy is that the club
 *    re-quotes the request, so that is what this says.
 *  - OWN_BOOKING / NOT_THEIR_OWN_GUEST. Neither is reachable from this email
 *    (the recipient is the guest named on the row, and is never the booking's
 *    owner), and the shared wording for OWN_BOOKING points at "the booking
 *    details above" — a page the reader of an email is not looking at. Rather
 *    than print a UI-relative instruction, they fall back to the honest general
 *    statement, which is true whichever of the two it was.
 *
 * A `Record` keyed by the blocker union rather than a `switch`, so adding a
 * blocker to `booking-guest-self-removal.ts` is a COMPILE error here instead of
 * a silently missing sentence.
 */
export const MEMBER_GUEST_REMOVAL_NOTE_BY_BLOCKER: Record<
  GuestSelfRemovalBlocker,
  string
> = {
  BOOKING_STATUS:
    "This booking is no longer in a state you can take yourself off. Ask the person who made the booking, or the club, if you need to come off it.",
  STAY_NOT_FUTURE:
    "This stay starts today or has already started, so you can no longer take yourself off it here. Ask the person who made the booking, or the club, if your plans have changed.",
  LAST_GUEST:
    "You are the only person on this booking, so taking yourself off would leave it empty. Ask the person who made the booking, or the club, to cancel it instead.",
  QUOTE_PRICED:
    "This booking was priced by hand, so guests cannot be taken off it from your account. Only the club can take you off — it will re-quote the request.",
  OWN_BOOKING:
    "Only the club can change who is on this booking. Contact the club if you need to come off it.",
  NOT_THEIR_OWN_GUEST:
    "Only the club can change who is on this booking. Contact the club if you need to come off it.",
};

/** Everything `evaluateGuestSelfRemoval` needs, threaded from the caller. */
export type MemberGuestRemovalFacts = {
  actorMemberId: string;
  guestMemberId: string | null;
  bookingOwnerMemberId: string;
  bookingStatus: string;
  bookingCheckIn: Date;
  bookingGuestCount: number;
  isQuotePriced?: boolean;
  /**
   * The club's today, as the UTC-midnight `@db.Date` encoding. REQUIRED — see
   * `evaluateGuestSelfRemoval`, which used to default it from the container's
   * timezone rather than the club's persisted one (#3123).
   */
  today: Date;
};

/**
 * The `{{removalNote}}` value, decided by the SHARED predicate rather than by a
 * second copy of the rule.
 *
 * This calls `evaluateGuestSelfRemoval` itself instead of taking a pre-computed
 * answer, so the email cannot promise a "take yourself off" link the server
 * would refuse: there is no second decision to get wrong. A test walks the whole
 * blocker matrix and asserts the note and the predicate never disagree.
 *
 * A DELEGATE READER IS NOT A SPECIAL CASE OF THE PREDICATE, IT IS OUTSIDE IT. The
 * predicate answers "may THIS ACTOR take THIS GUEST off", and a delegate is
 * neither: `evaluateGuestSelfRemoval` would refuse them `NOT_THEIR_OWN_GUEST`,
 * and the guest they answer for has no login to do it with either. So there is no
 * self-removal path to describe for them at all, and the honest note names the two
 * people who CAN act. Note this is the one branch that does not consult the
 * predicate — because it promises nothing the server would have to deliver.
 */
export function composeMemberGuestRemovalNote(params: {
  facts: MemberGuestRemovalFacts;
  audience: MemberGuestConsentAudience;
  bookerName: string;
}): string {
  const { facts, audience, bookerName } = params;

  if (audience.kind === "DELEGATE") {
    return (
      `If ${audience.guest.firstName} would rather not go, ask ${bookerName} or the ` +
      "club to take them off this booking."
    );
  }

  const { canSelfRemove, blocker } = evaluateGuestSelfRemoval(facts);
  if (canSelfRemove || !blocker) return MEMBER_GUEST_SELF_REMOVAL_OFFER;
  return MEMBER_GUEST_REMOVAL_NOTE_BY_BLOCKER[blocker];
}

// ---------------------------------------------------------------------------
// member-guest-consent-outcome
// ---------------------------------------------------------------------------

/**
 * What happened to the request, as the person who made the booking needs to
 * hear it.
 *
 * FIVE outcomes and ONE template, because the heading, the outcome sentence and
 * the consequence are all composed here. Two of them are the ones that could
 * have been left out and must not be — a decline and a lapse that the system
 * could not carry out: owner decision D-15 lets the expiry sweep
 * settle the money as account credit so an ORDINARY paid booking always lapses
 * cleanly, but a booking that is quote-priced, has only this guest on it, is in
 * a status that forbids changes, or has already started genuinely cannot be
 * changed automatically. Those land on the admin exception list, and the owner
 * is told the real remedy instead of being left to believe the guest came off.
 */
export type MemberGuestConsentOutcome =
  /** The member (or their delegate) said yes. Nothing about the booking changes. */
  | { kind: "APPROVED" }
  /** They said no and the place was released. `creditCents` is D-15's credit. */
  | { kind: "DECLINED"; creditCents: number }
  /**
   * They said no, but the place could NOT be released; an admin must act.
   *
   * THIS VARIANT IS NOT A TIDY-UP. Without it, a member who actively clicked
   * "No thanks" on a booking the system could not change was reported to the
   * booker as `EXPIRED_STILL_ON_BOOKING` — "did not answer in time", dated with
   * the moment the email happened to be composed. The booker was told the wrong
   * thing about the wrong event on a date that never happened, and the member
   * who had answered promptly was blamed for silence.
   */
  | { kind: "DECLINED_STILL_ON_BOOKING"; blocker: MemberGuestStillOnBookingReason }
  /** The request lapsed with no answer and the place was released. */
  | { kind: "EXPIRED_REMOVED"; expiredAt: Date; creditCents: number }
  /** The request lapsed but the place could NOT be released; an admin must act. */
  | {
      kind: "EXPIRED_STILL_ON_BOOKING";
      expiredAt: Date;
      blocker: MemberGuestStillOnBookingReason;
    };

export interface MemberGuestConsentOutcomeCopy {
  /** `{{outcomeHeading}}` — the first block, and therefore the email's heading. */
  heading: string;
  /** `{{outcomeSentence}}` — follows "Hi <first name>, ". */
  sentence: string;
  /** `{{consequenceNote}}` — what it means for the booking and the money. */
  consequenceNote: string;
}

/**
 * Why the guest is still on the booking, per refusal reason — the clause that
 * makes variant D honest.
 *
 * These are the only four reasons that reach the admin exception list, and they
 * are exactly the shared predicate's blockers, so they are keyed by the same
 * union: a new blocker is a compile error here rather than a missing
 * explanation. The two unreachable-from-here blockers get the general statement
 * for the same reason as in `MEMBER_GUEST_REMOVAL_NOTE_BY_BLOCKER`.
 */
export type MemberGuestStillOnBookingReason =
  | GuestSelfRemovalBlocker
  /**
   * The booking has already been paid for, so the reduction needs a
   * refund-or-credit election nobody has made.
   *
   * NOT a self-removal blocker, and that is exactly why it is here. The shared
   * predicate deliberately keeps this refusal server-only — it cannot be
   * predicted from the facts a card renders — so it arrives only as a refusal
   * message, and until now it was folded into `BOOKING_STATUS` and explained to
   * the booking's owner as "this booking is in a state the system cannot change
   * on its own". That is unhelpfully vague about the one blocker whose remedy is
   * concrete and entirely in the club's hands.
   */
  | "SETTLEMENT_CHOICE";

const STILL_ON_BOOKING_REASON_BY_BLOCKER: Record<
  MemberGuestStillOnBookingReason,
  string
> = {
  SETTLEMENT_CHOICE:
    "because this booking has already been paid for, so somebody has to choose whether that money comes back to you as a refund or as account credit",
  QUOTE_PRICED:
    "because this booking was priced by hand and only the club can change it — the club will re-quote the request",
  LAST_GUEST:
    "because they are the only guest on it, so taking them off would leave the booking empty",
  BOOKING_STATUS:
    "because this booking is in a state the system cannot change on its own",
  STAY_NOT_FUTURE: "because the stay has already started",
  OWN_BOOKING: "because the system could not change this booking on its own",
  NOT_THEIR_OWN_GUEST:
    "because the system could not change this booking on its own",
};

/**
 * The credit sentence, and the one case where there is no credit.
 *
 * Owner decision D-15 settles the money for an expired or declined place as
 * ACCOUNT CREDIT to the booking's owner. A booking that had not been paid for
 * yet simply reprices, and saying "credit has been added" there would be a
 * false promise, so zero cents gets its own sentence rather than "$0.00".
 */
function composeRepricedConsequence(creditCents: number): string {
  if (creditCents > 0) {
    return (
      "Your booking has been repriced. " +
      `${formatCents(creditCents)} has been added to your account credit and will come ` +
      "off your next booking."
    );
  }
  return (
    "Your booking has been repriced. Nothing had been paid for that place, so there " +
    "is no credit to return."
  );
}

export function composeMemberGuestConsentOutcome(params: {
  guest: MemberGuestPartyMember;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  outcome: MemberGuestConsentOutcome;
}): MemberGuestConsentOutcomeCopy {
  const { guest, lodgeName, checkIn, checkOut, outcome } = params;
  const guestName = `${guest.firstName} ${guest.lastName}`.trim();
  const guestFirstName = guest.firstName;
  const stay = `${lodgeName}, ${emailCalendarDay(checkIn)} - ${emailCalendarDay(checkOut)}`;

  switch (outcome.kind) {
    case "APPROVED":
      return {
        heading: `${guestName} has accepted`,
        sentence: `${guestName} has accepted your invitation and is confirmed on your booking at ${stay}.`,
        consequenceNote: `Nothing has changed on your booking — the bed that was being held for ${guestFirstName} is now theirs.`,
      };
    case "DECLINED":
      return {
        heading: `${guestName} has declined`,
        sentence: `${guestName} has declined and has been taken off your booking at ${stay}.`,
        consequenceNote: composeRepricedConsequence(outcome.creditCents),
      };
    case "DECLINED_STILL_ON_BOOKING":
      return {
        heading: `${guestName} has declined`,
        sentence: `${guestName} has declined your invitation to your booking at ${stay}, but could not be taken off it.`,
        consequenceNote:
          `${guestFirstName} is still on the booking, ` +
          `${STILL_ON_BOOKING_REASON_BY_BLOCKER[outcome.blocker]}. The club has been ` +
          "told and will be in touch.",
      };
    case "EXPIRED_REMOVED":
      return {
        heading: `${guestName} did not answer in time`,
        sentence:
          `your request to add ${guestName} lapsed on ${emailClubDate(outcome.expiredAt)} ` +
          `with no answer, and ${guestFirstName} has been taken off your booking at ${stay}.`,
        consequenceNote: composeRepricedConsequence(outcome.creditCents),
      };
    case "EXPIRED_STILL_ON_BOOKING":
      return {
        heading: `${guestName} did not answer in time`,
        sentence: `your request to add ${guestName} lapsed on ${emailClubDate(outcome.expiredAt)} with no answer.`,
        consequenceNote:
          `${guestFirstName} is still on the booking, ` +
          `${STILL_ON_BOOKING_REASON_BY_BLOCKER[outcome.blocker]}. The club has been ` +
          "told and will be in touch.",
      };
  }
}

// ---------------------------------------------------------------------------
// member-guest-consent-answered
// ---------------------------------------------------------------------------

/** What the delegate said, and whether the answer could actually be carried out. */
export type MemberGuestDelegateAnswer =
  | { kind: "APPROVED" }
  | { kind: "DECLINED_REMOVED" }
  /** They said no, but the booking could not be changed; the club has to act. */
  | { kind: "DECLINED_STILL_ON_BOOKING" };

export interface MemberGuestConsentAnsweredCopy {
  /** `{{answeredHeading}}` — the first block, and therefore the subject. */
  heading: string;
  /** `{{answeredSentence}}` — follows "Hi <first name>, ". */
  sentence: string;
  /** `{{answeredNote}}` — what to do if this is not what the reader expected. */
  note: string;
}

/**
 * "Pat answered for Sam" — the notice that closes owner decision D-10's loop.
 *
 * WHY THE SAME WORDS GO TO EVERYONE ON THE LIST. The recipients are the member
 * the answer was given for and the other adults who were asked, and there is no
 * fact here that is safe for one and not the other: they were all sent the same
 * request, and the answer is the same answer. Writing a second, "your" variant
 * for the member would only create a second sentence to keep true.
 *
 * NO MONEY, and no repricing. The money moved on the BOOKING OWNER's account,
 * and it is their outcome email that reports it. A household adult reading this
 * has no business being told what somebody else's stay cost.
 */
export function composeMemberGuestConsentAnswered(params: {
  target: MemberGuestPartyMember;
  responderName: string;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  answer: MemberGuestDelegateAnswer;
}): MemberGuestConsentAnsweredCopy {
  const { target, responderName, lodgeName, checkIn, checkOut, answer } = params;
  const targetName = `${target.firstName} ${target.lastName}`.trim();
  const targetFirstName = target.firstName || targetName;
  const stay = `${lodgeName}, ${emailCalendarDay(checkIn)} - ${emailCalendarDay(checkOut)}`;
  const heading = `${responderName} answered for ${targetName}`;

  switch (answer.kind) {
    case "APPROVED":
      return {
        heading,
        sentence: `${responderName} said yes for ${targetName}, so ${targetFirstName} is now on the booking at ${stay}.`,
        note: `If that is not what you expected, ask the person who made the booking, or the club, to change it.`,
      };
    case "DECLINED_REMOVED":
      return {
        heading,
        sentence: `${responderName} said no for ${targetName}, so ${targetFirstName} has been taken off the booking at ${stay}.`,
        note: `If that is not what you expected, ask the person who made the booking to add ${targetFirstName} again.`,
      };
    case "DECLINED_STILL_ON_BOOKING":
      return {
        heading,
        sentence: `${responderName} said no for ${targetName} on the booking at ${stay}, but the booking could not be changed automatically.`,
        note: `${targetFirstName} is still on that booking for now. The club has been told and will sort it out.`,
      };
  }
}
