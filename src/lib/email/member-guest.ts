import {
  EMAIL_DEFAULT_LODGE_NAME,
  loadEmailMessageSettingsForLodge,
} from "@/lib/email-message-settings";
import {
  buildMemberGuestPartyList,
  composeGuestNightsLabel,
  composeMemberGuestAdded,
  composeMemberGuestConsentAnswered,
  composeMemberGuestConsentAsk,
  composeMemberGuestConsentOutcome,
  composeMemberGuestRemovalNote,
  composeMemberGuestWithdrawn,
  type MemberGuestAddedContext,
  type MemberGuestConsentAudience,
  type MemberGuestConsentOutcome,
  type MemberGuestDelegateAnswer,
  type MemberGuestPartyMember,
  type MemberGuestRemovalFacts,
  type MemberGuestWithdrawnContext,
} from "@/lib/member-guest-email-notes";
import {
  memberGuestAddedTemplate,
  memberGuestConsentAnsweredTemplate,
  memberGuestConsentExpiredTemplate,
  memberGuestConsentOutcomeTemplate,
  memberGuestConsentRequestTemplate,
  memberGuestRequestWithdrawnTemplate,
} from "@/lib/email-templates/member-guest";
import { sendEmail, type EmailSendOutcome } from "./core";
import type { BookingEmailRecipient } from "@/lib/booking-email-contract";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay, emailClubDate } from "@/lib/email-templates-club-time";

/**
 * The six member-guest emails (epic #2305, MG2 #2307 and MG4 #2309).
 *
 * OWNER DECISION D-16, AND IT IS THE WHOLE REASON THIS FILE READS NO
 * PREFERENCES. Consent-adjacent mail ignores the per-action "notify the member"
 * tick AND ignores the member's own notification-category preferences. Being
 * asked for consent is not a mutable preference: a member who had muted a
 * category would never be asked, and would then silently expire off the booking
 * N days later without ever knowing they had been put on it. So none of these
 * wrappers consults `shouldSendEmail`, and no caller is expected to gate them on
 * a notify choice. That is the same shape every unconditional booking email in
 * `email/booking.ts` already has — `shouldSendEmail` is called by the two
 * callers that genuinely have an opt-out (`cron-checkin-reminders.ts` for
 * `bookingReminder`, `admin-roster-service.ts` for `choreRoster`) and by nobody
 * else — so the opt-out here is "do not call it", stated rather than implied.
 *
 * WHAT DOES STILL WITHHOLD THEM: the per-booking "No emails" switch (#2258,
 * owner decision D10). All six pass a real `{ bookingId }` `bookingContext`, so
 * a silenced booking withholds them and each withheld send lands on the
 * booking's withheld-banner record. That is enforced by the type — the parameter
 * is a required discriminated union, so a missing booking id is a compile error
 * — and by all six templates being registered `audience: "member"`, which is
 * what `isBookingSuppressibleTemplate` keys on. An admin-audience consent email
 * would silently bypass the switch.
 *
 * WHY THESE LIVE IN THEIR OWN FILE rather than in `email/booking.ts`: they are
 * about a GUEST ROW's consent rather than about the booking's own lifecycle, and
 * keeping them separate keeps the member-guest feature removable.
 *
 * Every wrapper is a pure transport that returns the mailer's outcome and does
 * no database writes of its own, so a caller can `try/catch` and `logger.error`
 * around it without leaving anything half-written.
 */

/** Everything the stay rows need, shared by the three stay-describing emails. */
interface MemberGuestStayParams {
  /** Booking this message belongs to (#2258). No `"none"` — see the note above. */
  bookingId: string;
  recipient: BookingEmailRecipient;
  email: string;
  checkIn: Date;
  checkOut: Date;
  /**
   * Booking's lodge (multi-lodge phase 8). Omitted/null resolves the club's
   * default lodge identity, so always thread the booking's own lodgeId.
   */
  lodgeId?: string | null;
}

export interface SendMemberGuestConsentRequestEmailParams
  extends MemberGuestStayParams {
  /**
   * First name of WHOEVER IS BEING ASKED — the member being added, or the family
   * delegate answering for them. Not necessarily the guest's own first name.
   */
  firstName: string;
  /** The member who made the booking and put this member down as a guest. */
  bookerName: string;
  /** Who is reading it, and therefore whose name the copy uses (D-9). */
  audience: MemberGuestConsentAudience;
  /** This guest's own nights, as date-only values. */
  guestNights: readonly Date[];
  /** When the request lapses if nobody answers. */
  consentExpiresAt: Date;
  /** Absolute link to the consent surface (the booking card, or the delegate page). */
  consentUrl: string;
  /** Everyone on the booking, first + last name (owner decision MG2-D-a). */
  party: readonly MemberGuestPartyMember[];
}

export async function sendMemberGuestConsentRequestEmail(
  params: SendMemberGuestConsentRequestEmailParams,
): Promise<EmailSendOutcome> {
  const settings = await loadEmailMessageSettingsForLodge(params.lodgeId);
  const ask = composeMemberGuestConsentAsk({
    bookerName: params.bookerName,
    audience: params.audience,
  });
  const partyList = buildMemberGuestPartyList(params.party);
  const guestNightsLabel = composeGuestNightsLabel(params.guestNights);

  return sendEmail({
    to: params.email,
    // The heading doubles as the subject so the two can never disagree, and
    // because it is the one line that is true for a delegate as well as for the
    // member being added.
    subject: ask.heading,
    html: await renderEmailHtml(() => memberGuestConsentRequestTemplate({
      firstName: params.firstName,
      bookerName: params.bookerName,
      askHeading: ask.heading,
      askContextNote: ask.contextNote,
      lodgeName: settings.lodgeName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guestNightsLabel,
      consentExpiresAt: params.consentExpiresAt,
      consentUrl: params.consentUrl,
      partyList,
    })),
    bookingContext: { bookingId: params.bookingId, recipient: params.recipient },
    templateName: "member-guest-consent-request",
    templateData: {
      firstName: params.firstName,
      bookerName: params.bookerName,
      askHeading: ask.heading,
      askContextNote: ask.contextNote,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      guestNightsLabel,
      consentExpiresAt: emailClubDate(params.consentExpiresAt),
      consentUrl: params.consentUrl,
      // The flat twin of the `<ul>` above, from the same one call to the same
      // one helper — so the editable body and the HTML cannot list different
      // people, or the same people in a different order.
      partyListNote: partyList.text,
    },
    lodgeId: params.lodgeId,
  });
}

export interface SendMemberGuestAddedEmailParams extends MemberGuestStayParams {
  /**
   * First name of WHOEVER IS BEING TOLD — the member who was added, or the family
   * adult told on their behalf. Not necessarily the guest's own first name.
   */
  firstName: string;
  /** The member whose booking it is (named even when an admin did the adding). */
  bookerName: string;
  /** Which of the three no-consent paths put them on the booking. */
  context: MemberGuestAddedContext;
  /**
   * Who is reading it. Defaults to the guest themselves, which is the only
   * assumption that is safe to make silently — a delegate reader changes the
   * heading, the opening sentence, the nights label and the removal advice, so
   * pass it whenever the recipient is not the guest (owner decision D-9 makes
   * that the NORMAL case, not an edge case).
   */
  audience?: MemberGuestConsentAudience;
  guestNights: readonly Date[];
  party: readonly MemberGuestPartyMember[];
  /**
   * Facts the SHARED self-removal predicate needs. Passed rather than a
   * pre-computed answer so the email's "you can take yourself off" sentence and
   * the server's decision are one decision, not two (owner decision D-14).
   */
  selfRemoval: MemberGuestRemovalFacts;
}

export async function sendMemberGuestAddedEmail(
  params: SendMemberGuestAddedEmailParams,
): Promise<EmailSendOutcome> {
  const settings = await loadEmailMessageSettingsForLodge(params.lodgeId);
  const audience: MemberGuestConsentAudience = params.audience ?? {
    kind: "TARGET",
  };
  const added = composeMemberGuestAdded({
    context: params.context,
    bookerName: params.bookerName,
    audience,
  });
  const removalNote = composeMemberGuestRemovalNote({
    facts: params.selfRemoval,
    audience,
    bookerName: params.bookerName,
  });
  const partyList = buildMemberGuestPartyList(params.party);
  const guestNightsLabel = composeGuestNightsLabel(params.guestNights);

  return sendEmail({
    to: params.email,
    subject: `${added.heading} - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => memberGuestAddedTemplate({
      firstName: params.firstName,
      addedHeading: added.heading,
      addedContextNote: added.contextNote,
      lodgeName: settings.lodgeName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guestNightsLabel,
      // A delegate is not the person the bed is held for, so the possessive
      // label would be wrong for them; "Nights" is true either way.
      nightsLabel: audience.kind === "TARGET" ? "Your nights" : "Nights",
      partyList,
      removalNote,
    })),
    bookingContext: { bookingId: params.bookingId, recipient: params.recipient },
    templateName: "member-guest-added",
    templateData: {
      firstName: params.firstName,
      addedHeading: added.heading,
      addedContextNote: added.contextNote,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      guestNightsLabel,
      partyListNote: partyList.text,
      removalNote,
    },
    lodgeId: params.lodgeId,
  });
}

export interface SendMemberGuestRequestWithdrawnEmailParams
  extends MemberGuestStayParams {
  /**
   * First name of WHOEVER IS BEING TOLD — the member who came off the booking,
   * or the family adult told on their behalf.
   */
  firstName: string;
  /** The member whose booking it is (named even when the club did the removing). */
  bookerName: string;
  /** Which of the three ways they came off it. */
  context: MemberGuestWithdrawnContext;
  /** Who is reading it (owner decision D-9 makes a delegate the normal case). */
  audience?: MemberGuestConsentAudience;
}

/**
 * "You are no longer on that booking" (MG4 #2309).
 *
 * NO `party` AND NO `selfRemoval` PARAMETER, and both omissions are the point.
 * The reader is off the booking, so there is no party they are entitled to see
 * and no self-removal left to describe — a `removalNote` here would offer to take
 * somebody off a booking they are not on. Everything this email states is a fact
 * about a stay that no longer includes them.
 */
export async function sendMemberGuestRequestWithdrawnEmail(
  params: SendMemberGuestRequestWithdrawnEmailParams,
): Promise<EmailSendOutcome> {
  const settings = await loadEmailMessageSettingsForLodge(params.lodgeId);
  const audience: MemberGuestConsentAudience = params.audience ?? {
    kind: "TARGET",
  };
  const copy = composeMemberGuestWithdrawn({
    context: params.context,
    bookerName: params.bookerName,
    audience,
  });

  return sendEmail({
    to: params.email,
    subject: `${copy.heading} - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => memberGuestRequestWithdrawnTemplate({
      firstName: params.firstName,
      withdrawnHeading: copy.heading,
      withdrawnContextNote: copy.contextNote,
      lodgeName: settings.lodgeName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
    })),
    bookingContext: { bookingId: params.bookingId, recipient: params.recipient },
    templateName: "member-guest-request-withdrawn",
    templateData: {
      firstName: params.firstName,
      withdrawnHeading: copy.heading,
      withdrawnContextNote: copy.contextNote,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
    },
    lodgeId: params.lodgeId,
  });
}

export interface SendMemberGuestConsentOutcomeEmailParams
  extends MemberGuestStayParams {
  /** First name of the person who MADE the booking — this one goes to them. */
  firstName: string;
  /** The member who was asked. */
  guest: MemberGuestPartyMember;
  /** Approved, declined, lapsed-and-removed, or lapsed-but-still-on-the-booking. */
  outcome: MemberGuestConsentOutcome;
}

export async function sendMemberGuestConsentOutcomeEmail(
  params: SendMemberGuestConsentOutcomeEmailParams,
): Promise<EmailSendOutcome> {
  const settings = await loadEmailMessageSettingsForLodge(params.lodgeId);
  const copy = composeMemberGuestConsentOutcome({
    guest: params.guest,
    lodgeName: settings.lodgeName,
    checkIn: params.checkIn,
    checkOut: params.checkOut,
    outcome: params.outcome,
  });

  return sendEmail({
    to: params.email,
    subject: `${copy.heading} - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => memberGuestConsentOutcomeTemplate({
      firstName: params.firstName,
      outcomeHeading: copy.heading,
      outcomeSentence: copy.sentence,
      consequenceNote: copy.consequenceNote,
      bookingId: params.bookingId,
    })),
    bookingContext: { bookingId: params.bookingId, recipient: params.recipient },
    templateName: "member-guest-consent-outcome",
    templateData: {
      firstName: params.firstName,
      outcomeHeading: copy.heading,
      outcomeSentence: copy.sentence,
      consequenceNote: copy.consequenceNote,
      bookingId: params.bookingId,
    },
    lodgeId: params.lodgeId,
  });
}

export interface SendMemberGuestConsentAnsweredEmailParams
  extends MemberGuestStayParams {
  /** First name of WHOEVER IS BEING TOLD — the member, or another family adult. */
  firstName: string;
  /** The member the answer was given for. */
  target: MemberGuestPartyMember;
  /** The family adult who actually answered. */
  responderName: string;
  /** What they said, and whether the booking could be changed to match. */
  answer: MemberGuestDelegateAnswer;
}

/**
 * Tell the member (and the rest of the household) that a delegate answered.
 *
 * The only member-guest email whose recipient may have nothing to do with the
 * booking, which is why it carries no booking link and no money — see
 * `memberGuestConsentAnsweredTemplate`. It still passes the booking id as
 * `bookingContext`, so a booking with "No emails" set withholds it like the rest.
 */
export async function sendMemberGuestConsentAnsweredEmail(
  params: SendMemberGuestConsentAnsweredEmailParams,
): Promise<EmailSendOutcome> {
  const settings = await loadEmailMessageSettingsForLodge(params.lodgeId);
  const copy = composeMemberGuestConsentAnswered({
    target: params.target,
    responderName: params.responderName,
    lodgeName: settings.lodgeName,
    checkIn: params.checkIn,
    checkOut: params.checkOut,
    answer: params.answer,
  });

  return sendEmail({
    to: params.email,
    subject: `${copy.heading} - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: await renderEmailHtml(() => memberGuestConsentAnsweredTemplate({
      firstName: params.firstName,
      answeredHeading: copy.heading,
      answeredSentence: copy.sentence,
      answeredNote: copy.note,
    })),
    bookingContext: { bookingId: params.bookingId, recipient: params.recipient },
    templateName: "member-guest-consent-answered",
    templateData: {
      firstName: params.firstName,
      answeredHeading: copy.heading,
      answeredSentence: copy.sentence,
      answeredNote: copy.note,
    },
    lodgeId: params.lodgeId,
  });
}

export interface SendMemberGuestConsentExpiredEmailParams
  extends MemberGuestStayParams {
  /** First name of the member who WAS ASKED — this one goes back to them. */
  firstName: string;
  bookerName: string;
}

export async function sendMemberGuestConsentExpiredEmail(
  params: SendMemberGuestConsentExpiredEmailParams,
): Promise<EmailSendOutcome> {
  const settings = await loadEmailMessageSettingsForLodge(params.lodgeId);

  return sendEmail({
    to: params.email,
    subject: "The request to add you to a lodge booking has lapsed",
    html: await renderEmailHtml(() => memberGuestConsentExpiredTemplate({
      firstName: params.firstName,
      bookerName: params.bookerName,
      lodgeName: settings.lodgeName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
    })),
    bookingContext: { bookingId: params.bookingId, recipient: params.recipient },
    templateName: "member-guest-consent-expired",
    templateData: {
      firstName: params.firstName,
      bookerName: params.bookerName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
    },
    lodgeId: params.lodgeId,
  });
}
