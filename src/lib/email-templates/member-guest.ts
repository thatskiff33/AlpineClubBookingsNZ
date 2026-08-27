/**
 * Member-guest consent emails: asking a member to agree to being added to
 * somebody else's booking, and every outcome of that ask.
 *
 * The family boundary is `src/lib/email/member-guest.ts`. The composed party
 * listing and note lines come from `member-guest-email-notes.ts`, which builds
 * the same copy for the admin-editable body.
 */
import { escapeHtml } from "./escape";
import {
  BASE_URL,
  button,
  heading,
  infoTable,
  layout,
  muted,
  paragraph,
  supportContactSentence,
} from "./layout";
import { type MemberGuestPartyList } from "@/lib/member-guest-email-notes";
import { emailCalendarDay, emailClubDate } from "@/lib/email-templates-club-time";

/** Shared stay facts every member-guest email states the same way. */
function memberGuestStayRows(data: {
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  guestNightsLabel: string;
  nightsLabel: string;
}): Array<{ label: string; value: string }> {
  return [
    // The nights label can be audience-derived, so it is escaped like a value.
    { label: "Lodge", value: escapeHtml(data.lodgeName) },
    {
      label: "Stay",
      value: `${escapeHtml(emailCalendarDay(data.checkIn))} - ${escapeHtml(emailCalendarDay(data.checkOut))}`,
    },
    ...(data.guestNightsLabel
      ? [
          {
            label: escapeHtml(data.nightsLabel),
            value: escapeHtml(data.guestNightsLabel),
          },
        ]
      : []),
  ];
}

/**
 * "Can X add you to this booking?" — to the member being added, or to the family
 * delegate answering for them (owner decision D-9).
 *
 * Carries the full party listing (MG2-D-a) and NO MONEY anywhere: not a price,
 * not a total, not a share. Nothing here tells the reader the switch that could
 * withhold this email exists, and nothing here is actionable without signing in.
 */
export function memberGuestConsentRequestTemplate(data: {
  firstName: string;
  bookerName: string;
  askHeading: string;
  askContextNote: string;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  guestNightsLabel: string;
  consentExpiresAt: Date;
  consentUrl: string;
  partyList: MemberGuestPartyList;
}): string {
  const answerBy = escapeHtml(emailClubDate(data.consentExpiresAt));
  const booker = escapeHtml(data.bookerName);

  return layout(`
    ${heading(escapeHtml(data.askHeading))}
    ${paragraph(`Hi ${escapeHtml(data.firstName)}, ${escapeHtml(data.askContextNote)}`)}
    ${infoTable([
      ...memberGuestStayRows({
        lodgeName: data.lodgeName,
        checkIn: data.checkIn,
        checkOut: data.checkOut,
        guestNightsLabel: data.guestNightsLabel,
        // "Nights" rather than "Your nights": a family delegate reading this is
        // not the person the nights are held for (D-9).
        nightsLabel: "Nights",
      }),
      { label: "Booked by", value: booker },
      { label: "Please answer by", value: `<strong>${answerBy}</strong>` },
    ])}
    ${data.partyList.html}
    ${paragraph(
      `If you do not answer by <strong>${answerBy}</strong>, the request lapses on its own and ${booker} is told. You do not have to do anything to decline. In most cases the held bed is released at the same time; occasionally it cannot be - when there would be nobody left on the booking, for example - and the club sorts that out by hand.`,
    )}
    ${button("Answer this request", data.consentUrl, { sameOrigin: true })}
    ${muted("If you were not expecting this, you can safely ignore it - the place is only confirmed if somebody answers yes.")}
  `);
}

/**
 * "You have been added to a lodge booking" — to the member, when nobody asked, or
 * to the family adult who is told on behalf of a member with no login (D-9).
 *
 * ONE template for notify-only, an admin add and a booking-request row;
 * `addedContextNote` is the single composed sentence that tells them apart, and
 * MG4 reuses this template unchanged. The heading is composed for the same reason
 * the consent request's is: it names the guest rather than the reader when the two
 * are not the same person. `removalNote` comes from the shared self-removal
 * predicate, so this email never offers a "take yourself off" link the server
 * would refuse (owner decision D-14).
 */
export function memberGuestAddedTemplate(data: {
  firstName: string;
  addedHeading: string;
  addedContextNote: string;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  guestNightsLabel: string;
  /**
   * "Your nights" only when the reader IS the guest; a neutral "Nights" when a
   * delegate is reading, because they are not the person the bed is held for.
   */
  nightsLabel: string;
  partyList: MemberGuestPartyList;
  removalNote: string;
}): string {
  return layout(`
    ${heading(escapeHtml(data.addedHeading))}
    ${paragraph(`Hi ${escapeHtml(data.firstName)}, ${escapeHtml(data.addedContextNote)}`)}
    ${infoTable(
      memberGuestStayRows({
        lodgeName: data.lodgeName,
        checkIn: data.checkIn,
        checkOut: data.checkOut,
        guestNightsLabel: data.guestNightsLabel,
        nightsLabel: data.nightsLabel,
      }),
    )}
    ${data.partyList.html}
    ${paragraph(escapeHtml(data.removalNote))}
    ${button("View this booking", `${BASE_URL}/bookings`)}
  `);
}

/**
 * What the member decided — to the person who made the booking.
 *
 * One template for five outcomes (approved, declined, declined-but-still-on-the-
 * booking, lapsed-and-removed, lapsed-but-still-on-the-booking) because the
 * heading, the sentence and the consequence are all composed server-side. The
 * consequence is the only place
 * money appears in this whole set, and it has to: owner decision D-15 settles an
 * expired or declined place as account credit to this recipient.
 */
export function memberGuestConsentOutcomeTemplate(data: {
  firstName: string;
  outcomeHeading: string;
  outcomeSentence: string;
  consequenceNote: string;
  bookingId: string;
}): string {
  return layout(`
    ${heading(escapeHtml(data.outcomeHeading))}
    ${paragraph(`Hi ${escapeHtml(data.firstName)}, ${escapeHtml(data.outcomeSentence)}`)}
    ${paragraph(escapeHtml(data.consequenceNote))}
    ${button("View this booking", `${BASE_URL}/bookings/${data.bookingId}`)}
  `);
}

/**
 * "That request has lapsed" — to the member who was asked.
 *
 * Sent only where a request email actually went out, so nobody is told a request
 * lapsed that they never received. No action link, because there is no action:
 * the bed is already released.
 */
export function memberGuestConsentExpiredTemplate(data: {
  firstName: string;
  bookerName: string;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  const booker = escapeHtml(data.bookerName);

  return layout(`
    ${heading("That request has lapsed")}
    ${paragraph(
      `Hi ${escapeHtml(data.firstName)}, the request from <strong>${booker}</strong> to add you to a booking at ${escapeHtml(data.lodgeName)} on ${escapeHtml(emailCalendarDay(data.checkIn))} - ${escapeHtml(emailCalendarDay(data.checkOut))} has lapsed, and the bed that was held for you has been released.`,
    )}
    ${paragraph(`You do not need to do anything. If you did want to come, ask ${booker} to add you again.`)}
  `);
}

/**
 * "You are no longer on that booking" — MG4 (#2309).
 *
 * The counterpart to `memberGuestAddedTemplate`, and it exists because MG2 told
 * a member they had a bed. Three things can take that back — the booker calls
 * off a request nobody has answered yet, the club takes a settled member guest
 * off, or the booking-request pipeline swaps them out at approval — and all
 * three leave a member holding an email that has stopped being true.
 *
 * NO BEARER/SELF-SERVICE ACTION AND NO PARTY LISTING, deliberately. The core
 * mail finalizer may add the canonical booking-detail action only when this
 * exact recipient independently retains route authority (for example, a
 * bookings-view admin). An ordinary removed member or family delegate gets no
 * booking link, because it would 403 or disclose a party they are no longer
 * part of. MG2-D-a's listing is the price of being asked to join; it is not owed
 * to somebody who has been removed.
 *
 * NO MONEY either, on the same rule as the request and added notices.
 *
 * THE LAST PARAGRAPH IS THE ONE DOING REAL WORK (mockup panel 8). The reader is
 * holding an earlier email with a button in it — "Answer this request", or
 * "View this booking" — and that button now leads nowhere. Saying so BEFORE they
 * press it is the difference between a closed loop and an error page, so it is
 * stated here and in the editable default body in the same words; the closing
 * contact line carries the support address in both for the same reason.
 */
export function memberGuestRequestWithdrawnTemplate(data: {
  firstName: string;
  withdrawnHeading: string;
  withdrawnContextNote: string;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  return layout(`
    ${heading(escapeHtml(data.withdrawnHeading))}
    ${paragraph(`Hi ${escapeHtml(data.firstName)}, ${escapeHtml(data.withdrawnContextNote)}`)}
    ${infoTable([
      { label: "Lodge", value: escapeHtml(data.lodgeName) },
      {
        label: "Stay",
        value: `${escapeHtml(emailCalendarDay(data.checkIn))} - ${escapeHtml(emailCalendarDay(data.checkOut))}`,
      },
    ])}
    ${supportContactSentence("You do not need to do anything. If you think this is a mistake, contact the club at ")}
    ${paragraph("The link in the earlier email no longer works. If plans change, you can be added to a booking again later.")}
  `);
}

/**
 * "Someone answered for you" — after a DELEGATE answered on a member's behalf.
 *
 * The one transition nobody downstream would otherwise hear about. The booking's
 * owner is told the outcome and the adult who clicked obviously knows, but the
 * member the answer was given FOR — and the other adults in the household who
 * were sent the same request — heard nothing, even though a decline releases
 * that member's bed and takes them off a booking. It goes to whoever we hold an
 * address for, including the member themselves when they have one, and states
 * plainly who answered and what they said.
 *
 * NO ACTION LINK, deliberately. The recipient may be a household adult who is
 * not on this booking at all, and owner decision D-11 gives booking-page access
 * to a guest ROW, never to a delegate — so a "view this booking" button here
 * would either leak the booking or 403 in their face.
 */
export function memberGuestConsentAnsweredTemplate(data: {
  firstName: string;
  answeredHeading: string;
  answeredSentence: string;
  answeredNote: string;
}): string {
  return layout(`
    ${heading(escapeHtml(data.answeredHeading))}
    ${paragraph(`Hi ${escapeHtml(data.firstName)}, ${escapeHtml(data.answeredSentence)}`)}
    ${paragraph(escapeHtml(data.answeredNote))}
  `);
}
