/**
 * HTML email templates for club emails.
 * All templates use inline CSS for maximum email client compatibility.
 */

import { getAppBaseUrl, sanitizeEmailHref } from "./app-url";
import {
  CLUB_EMAIL_FROM_NAME,
  CLUB_HUT_LEADER_LABEL,
  CLUB_LODGE_TRAVEL_NOTE,
  CLUB_NAME,
} from "@/config/club-identity";
import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";
import { SUPPORT_EMAIL } from "./email-sender";
import { MEMBER_SETUP_INVITE_TTL_DAYS } from "./member-setup-invite";
import { formatNZDate, formatNZDateTime } from "./nzst-date";
import { emailPalette } from "./email-theme";

const BASE_URL = getAppBaseUrl();

/** Escape HTML special characters to prevent injection in email templates. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Brand colours are pulled per-render from the club (Site Style) theme via
// `emailPalette()` (see email-theme.ts) so emails match the live site. Each
// helper/template reads `const p = emailPalette()` once and uses p.gold,
// p.charcoal, p.deep, p.mist, p.snow, p.ridge. These two are not brand roles
// and stay fixed.
const BRAND_LOGO_URL = `${BASE_URL}/branding/logo.png`;
const WHITE = "#ffffff";

function layout(content: string): string {
  const p = emailPalette();
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(CLUB_EMAIL_FROM_NAME)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${p.snow}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${p.snow};">
    <tr>
      <td align="center" style="padding: 24px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">
          <!-- Header -->
          <tr>
            <td style="background-color: ${p.charcoal}; padding: 28px 32px 24px; border-top: 4px solid ${p.gold}; border-radius: 8px 8px 0 0; text-align: center;">
              <img
                src="${BRAND_LOGO_URL}"
                alt="${escapeHtml(CLUB_NAME)}"
                width="176"
                style="display: block; margin: 0 auto 14px; width: 176px; max-width: 100%; height: auto;"
              />
              <p style="margin: 0; color: ${WHITE}; font-size: 13px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;">
                Online Booking System
              </p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="background-color: ${WHITE}; padding: 32px; border-left: 1px solid ${p.mist}; border-right: 1px solid ${p.mist};">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: ${WHITE}; padding: 20px 32px; border-top: 1px solid ${p.mist}; border-radius: 0 0 8px 8px; border-left: 1px solid ${p.mist}; border-right: 1px solid ${p.mist}; border-bottom: 1px solid ${p.mist};">
              <p style="margin: 0; color: ${p.ridge}; font-size: 12px; text-align: center;">
                ${escapeHtml(CLUB_NAME)} &bull; Online Booking System<br>
                <a href="${BASE_URL}" style="color: ${p.charcoal}; font-weight: 600; text-decoration: none;">${BASE_URL.replace(/^https?:\/\//, "")}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function supportEmailLink(): string {
  const p = emailPalette();
  const address = escapeHtml(SUPPORT_EMAIL);
  return `<a href="mailto:${address}" style="color: ${p.charcoal}; font-weight: 600; text-decoration: none;">${address}</a>`;
}

function supportContactMuted(): string {
  return muted(`${escapeHtml(CLUB_NAME)} — ${supportEmailLink()}`);
}

function supportContactSentence(prefix: string): string {
  return muted(`${prefix}${supportEmailLink()}.`);
}

function button(
  text: string,
  url: string,
  options?: { sameOrigin?: boolean }
): string {
  const p = emailPalette();
  const safeUrl = sanitizeEmailHref(url, {
    baseUrl: BASE_URL,
    sameOrigin: options?.sameOrigin,
  });

  return `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 24px 0;">
  <tr>
    <td style="background-color: ${p.gold}; border-radius: 6px;">
      <a href="${escapeHtml(safeUrl)}" target="_blank" style="display: inline-block; padding: 12px 28px; color: ${p.charcoal}; text-decoration: none; font-weight: 700; font-size: 14px;">
        ${text}
      </a>
    </td>
  </tr>
</table>`;
}

function infoTable(rows: Array<{ label: string; value: string }>): string {
  const p = emailPalette();
  const rowsHtml = rows
    .map(
      (r) => `
    <tr>
      <td style="padding: 8px 12px; font-weight: 600; color: ${p.deep}; font-size: 14px; border-bottom: 1px solid ${p.mist}; white-space: nowrap;">${r.label}</td>
      <td style="padding: 8px 12px; color: ${p.deep}; font-size: 14px; border-bottom: 1px solid ${p.mist};">${r.value}</td>
    </tr>`
    )
    .join("");

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
  ${rowsHtml}
</table>`;
}

function heading(text: string): string {
  const p = emailPalette();
  return `<h2 style="margin: 0 0 16px 0; color: ${p.deep}; font-size: 22px; font-weight: 700;">${text}</h2>`;
}

function paragraph(text: string): string {
  const p = emailPalette();
  return `<p style="margin: 0 0 12px 0; color: ${p.deep}; font-size: 15px; line-height: 1.6;">${text}</p>`;
}

export function plainTextEmailTemplate(bodyText: string): string {
  const blocks = bodyText
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const [firstBlock, ...rest] = blocks;
  const headingHtml = firstBlock ? heading(escapeHtml(firstBlock)) : "";
  const bodyHtml = rest.length > 0
    ? rest
        .map((block) => multilineBlock(escapeHtml(block)))
        .join("")
    : "";

  return layout(`
    ${headingHtml}
    ${bodyHtml}
  `);
}

function multilineBlock(text: string): string {
  const p = emailPalette();
  return `<div style="margin: 0 0 12px 0; color: ${p.deep}; font-size: 15px; line-height: 1.6; white-space: pre-wrap;">${text}</div>`;
}

function muted(text: string): string {
  const p = emailPalette();
  return `<p style="margin: 0 0 8px 0; color: ${p.ridge}; font-size: 13px; line-height: 1.5;">${text}</p>`;
}

function alertBox(
  text: string,
  type: "info" | "warning" | "success" = "info"
): string {
  const p = emailPalette();
  const colors = {
    info: { bg: "#fff7d6", border: p.gold, text: p.deep },
    warning: { bg: "#fef3c7", border: "#fcd34d", text: "#92400e" },
    success: { bg: "#dcfce7", border: "#86efac", text: "#166534" },
  };
  const c = colors[type];
  return `
<div style="background-color: ${c.bg}; border: 1px solid ${c.border}; border-radius: 6px; padding: 12px 16px; margin: 16px 0;">
  <p style="margin: 0; color: ${c.text}; font-size: 14px; font-weight: 600; white-space: pre-wrap;">${text}</p>
</div>`;
}

function arrivalInstructionsSection({
  travelNote,
  doorCode,
}: {
  travelNote: string;
  doorCode?: string | null;
}): string {
  const safeTravelNote = travelNote.trim();
  const safeDoorCode = doorCode?.trim() || null;
  const doorCodeTable = safeDoorCode
    ? infoTable([
        {
          label: "Door code",
          value: `<strong style="font-size: 18px; letter-spacing: 1px;">${escapeHtml(safeDoorCode)}</strong>`,
        },
      ])
    : "";

  return `
    ${paragraph("<strong>How to get to the lodge</strong>")}
    ${safeTravelNote ? multilineBlock(escapeHtml(safeTravelNote)) : ""}
    ${doorCodeTable}
    ${safeDoorCode ? muted("Please keep the door code private and use the current code when you arrive.") : ""}
  `;
}

// ---- Exported template functions ----

function formatCents(cents: number): string {
  return formatMoneyCents(cents);
}

function formatOperationalDateTime(value: Date): string {
  return value.toLocaleString(APP_LOCALE, { timeZone: APP_TIME_ZONE });
}

export function welcomeTemplate(firstName: string): string {
  const name = escapeHtml(firstName);
  return layout(`
    ${heading("Welcome, " + name + "!")}
    ${paragraph(`Your ${escapeHtml(CLUB_NAME)} booking account has been created successfully.`)}
    ${paragraph("You can now log in to book stays at the lodge, manage your bookings, and view your upcoming trips.")}
    ${button("Log In to Your Account", BASE_URL + "/login")}
    ${muted("If you did not create this account, please ignore this email.")}
  `);
}

export function passwordResetTemplate(resetUrl: string): string {
  return layout(`
    ${heading("Password Reset")}
    ${paragraph(`You requested a password reset for your ${escapeHtml(CLUB_NAME)} booking account.`)}
    ${paragraph("Click the button below to set a new password. This link expires in <strong>1 hour</strong>.")}
    ${button("Reset Password", resetUrl)}
    ${muted("If you didn't request this, you can safely ignore this email. Your password will remain unchanged.")}
  `);
}

export function adminPasswordResetTemplate(
  resetUrl: string,
  expiryLabel = "1 hour"
): string {
  return layout(`
    ${heading("Password Reset")}
    ${paragraph(`An administrator has requested a password reset for your ${escapeHtml(CLUB_NAME)} booking account.`)}
    ${paragraph("Click the button below to set a new password. This link expires in <strong>" + escapeHtml(expiryLabel) + "</strong>.")}
    ${button("Reset Password", resetUrl)}
    ${muted("If you believe this was sent in error, please contact the club administrator.")}
  `);
}

export function memberSetupInviteTemplate(
  firstName: string,
  resetUrl: string
): string {
  return layout(`
    ${heading("Set Up Your Account")}
    ${paragraph("Hi " + escapeHtml(firstName) + ",")}
    ${paragraph(`An administrator has created your ${escapeHtml(CLUB_NAME)} booking account.`)}
    ${paragraph(
      "Use the button below to set your password and activate your login. This link expires in <strong>" +
        String(MEMBER_SETUP_INVITE_TTL_DAYS) +
        " days</strong>."
    )}
    ${button("Set Up My Password", resetUrl)}
    ${muted("If you were not expecting this invite, you can safely ignore it or contact the club.")}
  `);
}

export function twoFactorCodeTemplate(params: {
  firstName: string;
  code: string;
  expiresAt: Date;
}): string {
  return layout(`
    ${heading("Two-factor code")}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ",")}
    ${paragraph(`Use this code to finish signing in to your ${escapeHtml(CLUB_NAME)} booking account:`)}
    ${paragraph(
      `<strong style="display: inline-block; font-size: 28px; letter-spacing: 0.16em; padding: 8px 0;">${escapeHtml(params.code)}</strong>`,
    )}
    ${muted("This code expires on " + escapeHtml(formatNZDateTime(params.expiresAt)) + ". If you did not try to sign in, change your password and contact the club.")}
  `);
}

export function bookingConfirmedTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  totalCents: number,
  options?: {
    discountCents?: number;
    promoAdjustmentCents?: number;
    promoCode?: string;
    lodgeTravelNote?: string;
    doorCode?: string | null;
  }
): string {
  const promoAdjustmentCents =
    options?.promoAdjustmentCents ??
    (options?.discountCents && options.discountCents > 0
      ? -options.discountCents
      : 0);
  const rows: Array<{ label: string; value: string }> = [
    { label: "Check-in", value: formatNZDate(checkIn) },
    { label: "Check-out", value: formatNZDate(checkOut) },
    { label: "Guests", value: String(guestCount) },
  ];

  if (promoAdjustmentCents !== 0) {
    const subtotalCents = totalCents - promoAdjustmentCents;
    rows.push({ label: "Subtotal", value: formatCents(subtotalCents) });
    const promoLabel = options?.promoCode
      ? `Promo adjustment (${escapeHtml(options.promoCode)})`
      : "Promo adjustment";
    const adjustmentPrefix = promoAdjustmentCents > 0 ? "+" : "-";
    rows.push({
      label: promoLabel,
      value: `${adjustmentPrefix}${formatCents(Math.abs(promoAdjustmentCents))}`,
    });
  }

  rows.push({ label: "Total Paid", value: formatCents(totalCents) });

  return layout(`
    ${heading("Booking Confirmed")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your lodge booking has been confirmed!")}
    ${infoTable(rows)}
    ${alertBox("Payment has been processed successfully.", "success")}
    ${arrivalInstructionsSection({
      travelNote: options?.lodgeTravelNote ?? CLUB_LODGE_TRAVEL_NOTE,
      doorCode: options?.doorCode ?? null,
    })}
    ${paragraph("You can view your booking details and manage your stay from your account.")}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

export function bookingPendingTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  holdUntil: Date
): string {
  return layout(`
    ${heading("Booking Pending")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your lodge booking has been received and is currently pending.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "Guests", value: String(guestCount) },
      { label: "Hold Until", value: formatNZDateTime(holdUntil) },
    ])}
    ${alertBox("Your booking includes non-member guests and will be held as pending until " + formatNZDateTime(holdUntil) + ".", "warning")}
    ${paragraph("During this time, club members have priority. If the lodge fills up with member bookings, your booking may be bumped. <strong>Your card will only be charged when the booking is confirmed.</strong>")}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

export function bookingBumpedTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number
): string {
  return layout(`
    ${heading("Booking Update")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", unfortunately your pending lodge booking has been bumped due to member demand.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "Guests", value: String(guestCount) },
    ])}
    ${alertBox("Your card has not been charged.", "info")}
    ${paragraph("As a non-member booking, priority is given to club members when the lodge reaches capacity. You're welcome to rebook for different dates where availability exists.")}
    ${button("Book Again", BASE_URL + "/book")}
    ${muted("We apologise for the inconvenience.")}
  `);
}

export function bookingCancelledTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  refundCents: number,
  refundMethod: "card" | "credit" = "card",
  creditRestoredCents: number = 0
): string {
  let refundInfo: string;
  if (refundCents > 0 && refundMethod === "credit") {
    refundInfo = alertBox(
      "A credit of " + formatCents(refundCents) + " has been added to your account for future bookings.",
      "success"
    );
  } else if (refundCents > 0) {
    refundInfo = alertBox(
      "A refund of " + formatCents(refundCents) + " has been processed to your original payment method.",
      "success"
    );
  } else {
    refundInfo = alertBox("No refund was applicable based on the cancellation policy.", "info");
  }

  // #1164 / D7: the account credit originally applied to this booking is now
  // restored subject to the same cancellation policy as the card slice, so a
  // late cancellation may restore less than the full amount applied.
  const creditRestoredInfo =
    creditRestoredCents > 0
      ? alertBox(
          formatCents(creditRestoredCents) +
            " of previously applied account credit has been restored to your account (per the cancellation policy).",
          "success"
        )
      : "";

  return layout(`
    ${heading("Booking Cancelled")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your lodge booking has been cancelled.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
    ])}
    ${refundInfo}
    ${creditRestoredInfo}
    ${paragraph("You can make a new booking at any time from your account.")}
    ${button("Make a New Booking", BASE_URL + "/book")}
  `);
}

export function bookingGuestsRemovedTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  newTotalCents: number
): string {
  return layout(`
    ${heading("Booking Update")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", the lodge filled up with member bookings, so we couldn't keep the non-member guests on your booking. The rest of your booking continues.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "Guests", value: String(guestCount) },
      { label: "New Total", value: formatCents(newTotalCents) },
    ])}
    ${alertBox("Only your non-member guests were removed — your booking has not been cancelled.", "info")}
    ${paragraph("Your updated total reflects the remaining guests. You're welcome to rebook the non-member guests for different dates where availability exists.")}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

export function bookingGuestsCancelledTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date
): string {
  return layout(`
    ${heading("Booking Cancelled")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", you asked us to cancel your whole booking if your non-member guests couldn't come. The lodge filled up with member bookings, so we've cancelled it.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
    ])}
    ${alertBox("Your card has not been charged.", "info")}
    ${paragraph("You're welcome to rebook for different dates where availability exists.")}
    ${button("Book Again", BASE_URL + "/book")}
  `);
}

export function bookingReviewApprovedTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  adminNotes: string,
  bookingId: string,
): string {
  return layout(`
    ${heading("Booking Approved")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", an admin has approved your booking. You can now complete payment to confirm it.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
    ])}
    ${adminNotes ? alertBox("Note from admin: " + escapeHtml(adminNotes), "info") : ""}
    ${button("Complete Payment", BASE_URL + "/bookings/" + bookingId)}
  `);
}

export function bookingReviewRejectedTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  adminNotes: string,
): string {
  return layout(`
    ${heading("Booking Declined")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", an admin has reviewed your booking and was not able to approve it. The booking has been cancelled — no payment was taken.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
    ])}
    ${adminNotes ? alertBox("Reason from admin: " + escapeHtml(adminNotes), "warning") : ""}
    ${paragraph("You are welcome to make a new booking that includes an adult guest, or contact the club to discuss.")}
    ${button("Make a New Booking", BASE_URL + "/book")}
  `);
}

export function emailVerificationTemplate(
  firstName: string,
  verifyUrl: string,
  expiresAt: Date
): string {
  const name = escapeHtml(firstName);
  return layout(`
    ${heading("Verify Your Email")}
    ${paragraph(`Hi ${name}, thanks for creating your ${escapeHtml(CLUB_NAME)} booking account!`)}
    ${paragraph("Please verify your email address by clicking the button below.")}
    ${button("Verify Email", verifyUrl)}
    ${muted("This link expires on " + escapeHtml(formatNZDateTime(expiresAt)) + ". If you did not create this account, please ignore this email.")}
  `);
}

export function nominationRequestTemplate(params: {
  nominatorName: string;
  applicantName: string;
  reviewUrl: string;
  familyMemberCount: number;
  expiresAt: Date;
}): string {
  const dependentLine =
    params.familyMemberCount > 0
      ? `${paragraph("This application also includes " + String(params.familyMemberCount) + " dependent family member" + (params.familyMemberCount === 1 ? "" : "s") + ".")}`
      : "";

  return layout(`
    ${heading("Membership Nomination Request")}
    ${paragraph("Hi " + escapeHtml(params.nominatorName) + ",")}
    ${paragraph(
      "<strong>" +
        escapeHtml(params.applicantName) +
        `</strong> has listed you as one of their ${escapeHtml(CLUB_NAME)} nominators.`
    )}
    ${dependentLine}
    ${paragraph("Please review the application and confirm whether you agree to nominate this person for membership.")}
    ${alertBox("You will need to sign in before you can confirm the nomination.", "info")}
    ${button("Review Application", params.reviewUrl)}
    ${muted("This link expires on " + escapeHtml(formatNZDateTime(params.expiresAt)) + ".")}
  `);
}

export function inductionSignOffRequestTemplate(params: {
  signerName: string;
  inducteeName: string;
  signerRoleLabel: string;
  inductionUrl: string;
}): string {
  return layout(`
    ${heading("Lodge Induction Sign-Off Request")}
    ${paragraph("Hi " + escapeHtml(params.signerName) + ",")}
    ${paragraph(
      "<strong>" +
        escapeHtml(params.inducteeName) +
        `</strong> needs their ${escapeHtml(CLUB_NAME)} lodge induction signed off, and you can do this as their ` +
        escapeHtml(params.signerRoleLabel.toLowerCase()) +
        "."
    )}
    ${paragraph("Once you have taken them through the lodge induction checklist and you are satisfied they are competent, please sign in and confirm the sign-off on your induction page.")}
    ${alertBox("You will need to sign in before you can complete the sign-off.", "info")}
    ${button("Open My Induction Page", params.inductionUrl)}
  `);
}

export function emailChangeVerificationTemplate(
  newEmail: string,
  verifyUrl: string,
  expiresAt: Date
): string {
  return layout(`
    ${heading("Confirm Your New Email")}
    ${paragraph(`You requested to change the email address on your ${escapeHtml(CLUB_NAME)} account to <strong>${escapeHtml(newEmail)}</strong>.`)}
    ${paragraph("Click the button below to confirm this change.")}
    ${button("Confirm Email Change", verifyUrl)}
    ${muted("This link expires on " + escapeHtml(formatNZDateTime(expiresAt)) + ". If you did not request this change, please ignore this email.")}
  `);
}

export function emailChangeNotificationTemplate(newEmail: string): string {
  return layout(`
    ${heading("Email Change Requested")}
    ${paragraph(`Someone requested to change the email address on your ${escapeHtml(CLUB_NAME)} account to <strong>${escapeHtml(newEmail)}</strong>.`)}
    ${alertBox("If this wasn't you, please contact the club immediately.", "warning")}
    ${muted("If you made this request, you can safely ignore this email. The change will only take effect after verification.")}
  `);
}

export function choreRosterTemplate(
  guestName: string,
  date: string,
  chores: Array<{ name: string; description: string | null }>,
  choreLink?: string
): string {
  const formattedDate = new Date(date + "T00:00:00").toLocaleDateString(
    "en-NZ",
    { weekday: "long", year: "numeric", month: "long", day: "numeric" }
  );

  const choreRows = chores.map((c) => ({
    label: escapeHtml(c.name),
    value: c.description ? escapeHtml(c.description) : "",
  }));

  const linkSection = choreLink
    ? `${button("Mark Chores Complete", choreLink)}${muted("Use this link to mark your chores as done from your phone. Link expires in 48 hours.")}`
    : "";

  return layout(`
    ${heading("Chore Roster")}
    ${paragraph("Hi " + escapeHtml(guestName) + ",")}
    ${paragraph("Here are your assigned chores for <strong>" + escapeHtml(formattedDate) + "</strong> at the lodge:")}
    ${infoTable(choreRows)}
    ${linkSection}
    ${alertBox("Last person to bed: Check heaters and fire are safe and doors are secure.", "warning")}
    ${muted("Thanks for helping keep the lodge running smoothly!")}
  `);
}

export function hutLeaderAssignmentTemplate(params: {
  firstName: string;
  startDate: Date;
  endDate: Date;
  pin: string;
}): string {
  const p = emailPalette();
  return layout(`
    ${heading(`${CLUB_HUT_LEADER_LABEL} Assignment`)}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ", thanks for taking on " + CLUB_HUT_LEADER_LABEL.toLowerCase() + " duties for the lodge.")}
    ${infoTable([
      { label: "Start date", value: formatNZDate(params.startDate) },
      { label: "End date", value: formatNZDate(params.endDate) },
      { label: "Kiosk PIN", value: `<strong style="font-size: 18px; letter-spacing: 2px;">${escapeHtml(params.pin)}</strong>` },
    ])}
    ${paragraph(`When you arrive, open the lodge kiosk and use this PIN to unlock ${CLUB_HUT_LEADER_LABEL.toLowerCase()} controls for arrivals, departures, and roster management.`)}
    ${alertBox(`Please keep this PIN private and share it only with the assigned ${CLUB_HUT_LEADER_LABEL.toLowerCase()} team for these dates.`, "warning")}
    ${paragraph("Responsibilities include checking the lodge list, helping guests settle in, marking arrivals and departures, and making sure the daily chore roster is set up and completed.")}
    ${paragraph(`Before your stay, please read the <a href="${escapeHtml(BASE_URL + "/lodge-instructions")}" style="color: ${p.charcoal}; font-weight: 600; text-decoration: underline;">lodge instructions</a> covering opening, closing, and day-to-day running of the lodge.`)}
    ${button("Open Lodge View", BASE_URL + "/lodge")}
    ${muted("If you have any issues accessing the kiosk, please contact a club administrator.")}
  `);
}

// ---- N-01: Check-in Reminder ----

export function checkinReminderTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guests: Array<{ firstName: string; lastName: string }>,
  chores: Array<{ name: string; description: string | null }>
): string {
  const p = emailPalette();
  const guestListHtml = guests
    .map((g) => `<li style="padding: 4px 0; color: ${p.deep}; font-size: 14px;">${escapeHtml(g.firstName)} ${escapeHtml(g.lastName)}</li>`)
    .join("");

  const choreSection = chores.length > 0
    ? `${paragraph("<strong>Your arrival day chores:</strong>")}${infoTable(chores.map((c) => ({ label: escapeHtml(c.name), value: c.description ? escapeHtml(c.description) : "" })))}`
    : "";

  return layout(`
    ${heading("Check-in Reminder")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your lodge stay begins <strong>tomorrow</strong>!")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "Guests", value: String(guests.length) },
    ])}
    ${paragraph("<strong>Guest list:</strong>")}
    <ul style="margin: 0 0 16px 0; padding-left: 20px;">${guestListHtml}</ul>
    ${choreSection}
    ${alertBox("Please ensure you arrive prepared for alpine conditions. Check the weather forecast before departing.", "info")}
    ${paragraph(CLUB_LODGE_TRAVEL_NOTE)}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

export function preArrivalReminderTemplate(params: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  expectedArrivalTime?: string | null;
  lodgeTravelNote: string;
  doorCode?: string | null;
}): string {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Check-in", value: formatNZDate(params.checkIn) },
    { label: "Check-out", value: formatNZDate(params.checkOut) },
    { label: "Guests", value: String(params.guestCount) },
  ];

  if (params.expectedArrivalTime) {
    rows.push({
      label: "Expected arrival",
      value: escapeHtml(params.expectedArrivalTime),
    });
  }

  return layout(`
    ${heading("Upcoming Lodge Stay")}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ", your lodge stay is coming up.")}
    ${infoTable(rows)}
    ${arrivalInstructionsSection({
      travelNote: params.lodgeTravelNote,
      doorCode: params.doorCode,
    })}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

// ---- N-02: Admin Alert — New Booking ----

export function adminNewBookingTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  status: string;
  reviewReason?: string | null;
  memberJustification?: string | null;
}): string {
  const rows = [
    { label: "Member", value: escapeHtml(data.memberName) },
    { label: "Check-in", value: formatNZDate(data.checkIn) },
    { label: "Check-out", value: formatNZDate(data.checkOut) },
    { label: "Guests", value: String(data.guestCount) },
    { label: "Total", value: formatCents(data.totalCents) },
    { label: "Status", value: escapeHtml(data.status) },
  ];
  if (data.memberJustification) {
    rows.push({ label: "Member reason", value: escapeHtml(data.memberJustification) });
  }
  return layout(`
    ${heading("New Booking Created")}
    ${paragraph("A new booking has been created.")}
    ${data.reviewReason ? alertBox(escapeHtml(data.reviewReason), "warning") : ""}
    ${infoTable(rows)}
    ${button("View Bookings", BASE_URL + "/admin/bookings")}
  `);
}

// ---- N-04: Admin Alert — Payment Failure ----

export function adminPaymentFailureTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  errorMessage: string;
  paymentIntentId: string;
}): string {
  return layout(`
    ${heading("Payment Failed")}
    ${alertBox("A payment has failed and may require manual attention.", "warning")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Amount", value: formatCents(data.amountCents) },
      { label: "Error", value: escapeHtml(data.errorMessage) },
      { label: "Stripe PI", value: escapeHtml(data.paymentIntentId) },
    ])}
    ${button("View Payments", BASE_URL + "/admin/payments")}
  `);
}

// ---- N-06: Admin Alert — Pending Approaching Deadline ----

export function adminPendingDeadlineTemplate(bookings: Array<{
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  deadline: Date;
  hoursRemaining: number;
}>): string {
  const p = emailPalette();
  const tableRowsHtml = bookings
    .map(
      (b) => `
    <tr>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(b.memberName)}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${formatNZDate(b.checkIn)} – ${formatNZDate(b.checkOut)}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${b.guestCount}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${formatNZDateTime(b.deadline)}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${b.hoursRemaining <= 24 ? "#dc2626" : p.deep}; font-weight: ${b.hoursRemaining <= 24 ? "700" : "400"};">${Math.round(b.hoursRemaining)}h</td>
    </tr>`
    )
    .join("");

  return layout(`
    ${heading("Pending Bookings Approaching Deadline")}
    ${alertBox(bookings.length + " pending booking" + (bookings.length > 1 ? "s" : "") + " will reach their hold deadline within 48 hours.", "warning")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Member</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Dates</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Guests</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Deadline</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Remaining</th>
      </tr>
      ${tableRowsHtml}
    </table>
    ${button("View Bookings", BASE_URL + "/admin/bookings")}
  `);
}

// ---- N-07: Admin Alert — Booking Bumped ----

export function adminBookingBumpedTemplate(data: {
  bumpedMemberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  triggeringMemberName: string;
}): string {
  return layout(`
    ${heading("Booking Bumped")}
    ${alertBox("A pending booking has been bumped due to a member booking.", "warning")}
    ${infoTable([
      { label: "Bumped Member", value: escapeHtml(data.bumpedMemberName) },
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Triggered By", value: escapeHtml(data.triggeringMemberName) },
    ])}
    ${button("View Bookings", BASE_URL + "/admin/bookings")}
  `);
}

// ---- N-05: Admin Alert — Xero Sync Error ----

export function adminXeroSyncErrorTemplate(data: {
  errorType: string;
  operation: string;
  errorMessage: string;
  timestamp: Date;
}): string {
  return layout(`
    ${heading("Xero Sync Error")}
    ${alertBox("A Xero integration error occurred and may require attention.", "warning")}
    ${infoTable([
      { label: "Error Type", value: escapeHtml(data.errorType) },
      { label: "Operation", value: escapeHtml(data.operation) },
      { label: "Error Message", value: escapeHtml(data.errorMessage) },
      { label: "Timestamp", value: formatOperationalDateTime(data.timestamp) },
    ])}
    ${button("View Xero Status", BASE_URL + "/admin/xero")}
  `);
}

export function adminXeroRepeatedFailureTemplate(data: {
  correlationKey: string;
  failureCount: number;
  windowHours: number;
  entityType: string;
  operationType: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  xeroObjectUrl: string | null;
  latestErrorMessage: string | null;
  timestamp: Date;
}): string {
  const p = emailPalette();
  const infoRows = [
    { label: "Correlation Key", value: escapeHtml(data.correlationKey) },
    {
      label: "Failures in Window",
      value: `${data.failureCount} in the last ${data.windowHours} hour${data.windowHours === 1 ? "" : "s"}`,
    },
    { label: "Entity", value: escapeHtml(data.entityType) },
    { label: "Operation", value: escapeHtml(data.operationType) },
    {
      label: "Local Record",
      value:
        data.localModel && data.localId
          ? escapeHtml(`${data.localModel} ${data.localId}`)
          : "Unavailable",
    },
    {
      label: "Latest Error",
      value: escapeHtml(data.latestErrorMessage ?? "Unavailable"),
    },
    {
      label: "Timestamp",
      value: formatOperationalDateTime(data.timestamp),
    },
  ];

  const links: string[] = [];
  if (data.localUrl) {
    links.push(`<a href="${escapeHtml(BASE_URL + data.localUrl)}" style="color: ${p.gold}; text-decoration: underline;">Open local record</a>`);
  }
  if (data.xeroObjectUrl) {
    links.push(`<a href="${escapeHtml(data.xeroObjectUrl)}" style="color: ${p.gold}; text-decoration: underline;">Open Xero object</a>`);
  }

  return layout(`
    ${heading("Repeated Xero Failures")}
    ${alertBox("The same Xero sync correlation key has failed repeatedly and now needs operator attention.", "warning")}
    ${infoTable(infoRows)}
    ${links.length > 0 ? paragraph(links.join(" &nbsp;|&nbsp; ")) : ""}
    ${button("Open Xero Admin", BASE_URL + "/admin/xero")}
  `);
}

// ---- N-03: Admin Alert — Capacity Warning ----

export function adminCapacityWarningTemplate(days: Array<{
  date: Date;
  occupiedBeds: number;
  availableBeds: number;
}>, lodgeCapacity = FALLBACK_LODGE_CAPACITY): string {
  const p = emailPalette();
  const tableRowsHtml = days
    .map((d) => {
      const pct =
        lodgeCapacity > 0
          ? Math.round((d.occupiedBeds / lodgeCapacity) * 100)
          : 0;
      const color = d.availableBeds <= 2 ? "#dc2626" : d.availableBeds <= 5 ? "#d97706" : p.deep;
      return `
    <tr>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${formatNZDate(d.date)}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${d.occupiedBeds}/${lodgeCapacity}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${color}; font-weight: 700;">${d.availableBeds}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${color}; font-weight: 700;">${pct}%</td>
    </tr>`;
    })
    .join("");

  return layout(`
    ${heading("Capacity Warning")}
    ${alertBox(days.length + " day" + (days.length > 1 ? "s" : "") + " in the next 14 days have high occupancy.", "warning")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Date</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Occupied</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Available</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Occupancy</th>
      </tr>
      ${tableRowsHtml}
    </table>
    ${button("View Bookings", BASE_URL + "/admin/bookings")}
  `);
}

// ---- N-09: Bulk Member Communication ----

export function bulkCommunicationTemplate(
  subject: string,
  body: string
): string {
  const p = emailPalette();
  return layout(`
    ${heading(escapeHtml(subject))}
    <div style="color: ${p.deep}; font-size: 15px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(body)}</div>
    ${muted(`This email was sent to you by the ${escapeHtml(CLUB_NAME)} administration. You can update your email preferences in your account settings.`)}
    ${button("Manage Preferences", BASE_URL + "/profile")}
  `);
}

// ---- N-13: Admin Daily Digest ----

export function adminDailyDigestTemplate(sections: {
  newBookings: number;
  paymentFailures: number;
  capacityWarnings: number;
  bookingsBumped: number;
  pendingDeadlines: number;
  xeroErrors: number;
  totalAlerts: number;
}): string {
  const p = emailPalette();
  const rows: Array<{ label: string; value: string; link: string }> = [];

  if (sections.newBookings > 0) rows.push({ label: "New Bookings", value: String(sections.newBookings), link: "/admin/bookings" });
  if (sections.paymentFailures > 0) rows.push({ label: "Payment Failures", value: String(sections.paymentFailures), link: "/admin/payments" });
  if (sections.capacityWarnings > 0) rows.push({ label: "Capacity Warnings", value: String(sections.capacityWarnings), link: "/admin/bookings" });
  if (sections.bookingsBumped > 0) rows.push({ label: "Bookings Bumped", value: String(sections.bookingsBumped), link: "/admin/bookings" });
  if (sections.pendingDeadlines > 0) rows.push({ label: "Pending Deadlines", value: String(sections.pendingDeadlines), link: "/admin/bookings" });
  if (sections.xeroErrors > 0) rows.push({ label: "Xero Errors", value: String(sections.xeroErrors), link: "/admin/xero" });

  const tableRowsHtml = rows
    .map(
      (r) => `
    <tr>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${r.label}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep}; font-weight: 700;">${r.value}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist};"><a href="${BASE_URL}${r.link}" style="color: ${p.gold}; text-decoration: none;">View</a></td>
    </tr>`
    )
    .join("");

  const noAlerts = rows.length === 0
    ? paragraph("No alerts were triggered in the past 24 hours. All systems running normally.")
    : "";

  return layout(`
    ${heading("Admin Daily Digest")}
    ${paragraph("Summary of admin alerts from the past 24 hours.")}
    ${noAlerts}
    ${rows.length > 0 ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Alert Type</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Count</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Action</th>
      </tr>
      ${tableRowsHtml}
    </table>` : ""}
    ${paragraph("<strong>Total alerts:</strong> " + sections.totalAlerts)}
    ${button("Open Admin Dashboard", BASE_URL + "/admin/dashboard")}
  `);
}

export type XeroReconciliationIssueSeverityEmail = "critical" | "warning" | "info";

export interface XeroReconciliationIssueItemEmail {
  label: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  xeroObjectType: string | null;
  xeroObjectId: string | null;
  xeroObjectNumber: string | null;
  xeroObjectUrl: string | null;
  operationId: string | null;
  operationStatus: string | null;
  operationType: string | null;
  correlationKey: string | null;
  detail: string | null;
  latestErrorMessage: string | null;
  createdAt: Date | null;
}

export interface XeroReconciliationIssueSectionEmail {
  id: string;
  title: string;
  severity: XeroReconciliationIssueSeverityEmail;
  count: number;
  whatWentWrong: string;
  howToFix: string;
  items: XeroReconciliationIssueItemEmail[];
}

export interface XeroReconciliationReportEmail {
  generatedAt: Date;
  lookbackHours: number;
  stalePendingMinutes: number;
  summary: {
    missingMemberContactLinks: number;
    missingPaymentInvoiceLinks: number;
    missingPaymentRefundCreditNoteLinks: number;
    missingSubscriptionInvoiceLinks: number;
    mismatchedCanonicalLinks: number;
    staleCanonicalLinks: number;
    duplicateActiveCanonicalLinks: number;
    stalePendingOperations: number;
    recentFailedOperations: number;
    recentPartialOperations: number;
    unsupportedPartialOperations: number;
    repeatedFailureCorrelations: number;
    failedInboundEvents: number;
    issueCategoryCount: number;
    issueTotalCount: number;
  };
  issueSections?: XeroReconciliationIssueSectionEmail[];
  repeatedFailures: Array<{
    correlationKey: string;
    failureCount: number;
    entityType: string;
    operationType: string;
    localModel: string | null;
    localId: string | null;
    localUrl: string | null;
    latestErrorMessage: string | null;
    latestOperationId?: string;
    latestOperationStatus?: string;
    latestOperationCreatedAt?: Date;
    xeroObjectType?: string | null;
    xeroObjectId?: string | null;
    xeroObjectNumber?: string | null;
    xeroObjectUrl?: string | null;
  }>;
  unsupportedPartials: Array<{
    operationId: string;
    entityType: string;
    operationType: string;
    localModel: string | null;
    localId: string | null;
    localUrl: string | null;
    xeroObjectType?: string | null;
    xeroObjectId?: string | null;
    xeroObjectNumber?: string | null;
    xeroObjectUrl?: string | null;
    reason: string;
    createdAt: Date;
  }>;
}

function formatEmailDateTime(value: Date | null): string {
  if (!value) {
    return "";
  }

  return formatOperationalDateTime(value);
}

function formatXeroObjectLabel(item: {
  xeroObjectType: string | null;
  xeroObjectId: string | null;
  xeroObjectNumber: string | null;
}): string | null {
  if (!item.xeroObjectId) {
    return null;
  }

  return `${item.xeroObjectType ?? "Xero"} ${item.xeroObjectNumber ?? item.xeroObjectId}`;
}

function issueSeverityStyle(severity: XeroReconciliationIssueSeverityEmail) {
  const p = emailPalette();
  switch (severity) {
    case "critical":
      return { bg: "#fef2f2", border: "#fecaca", text: "#991b1b", label: "Action needed" };
    case "warning":
      return { bg: "#fffbeb", border: "#fcd34d", text: "#92400e", label: "Review" };
    case "info":
      return { bg: "#eff6ff", border: "#bfdbfe", text: "#1e40af", label: "Context" };
    default:
      return { bg: "#f8fafc", border: p.mist, text: p.deep, label: "Review" };
  }
}

function issueLink(text: string, url: string, sameOrigin = false): string {
  const p = emailPalette();
  const safeUrl = sanitizeEmailHref(url, {
    baseUrl: BASE_URL,
    sameOrigin,
  });

  return `<a href="${escapeHtml(safeUrl)}" target="_blank" style="color: ${p.charcoal}; font-weight: 700; text-decoration: underline;">${escapeHtml(text)}</a>`;
}

function renderIssueItem(item: XeroReconciliationIssueItemEmail): string {
  const p = emailPalette();
  const recordLink = item.localUrl
    ? issueLink("Open booking record", item.localUrl, true)
    : null;
  const xeroLabel = formatXeroObjectLabel(item);
  const xeroLink = item.xeroObjectUrl
    ? issueLink(xeroLabel ?? "Open Xero", item.xeroObjectUrl)
    : null;
  const links = [recordLink, xeroLink].filter((value): value is string => Boolean(value));
  const metadata = [
    item.operationId ? `Operation ${item.operationId}` : null,
    item.operationStatus ? `Status ${item.operationStatus}` : null,
    item.operationType,
    item.correlationKey ? `Correlation ${item.correlationKey}` : null,
    formatEmailDateTime(item.createdAt),
  ].filter((value): value is string => Boolean(value));
  const detailRows = [
    item.detail,
    item.latestErrorMessage ? `Latest error: ${item.latestErrorMessage}` : null,
  ].filter((value): value is string => Boolean(value));

  return `
    <div style="border: 1px solid ${p.mist}; border-radius: 6px; padding: 12px; margin: 10px 0; background-color: ${WHITE};">
      <p style="margin: 0 0 6px 0; color: ${p.deep}; font-size: 14px; font-weight: 700;">${escapeHtml(item.label)}</p>
      ${
        metadata.length > 0
          ? `<p style="margin: 0 0 6px 0; color: ${p.ridge}; font-size: 12px; line-height: 1.5;">${metadata.map(escapeHtml).join(" &bull; ")}</p>`
          : ""
      }
      ${
        detailRows.length > 0
          ? `<p style="margin: 0 0 8px 0; color: ${p.deep}; font-size: 13px; line-height: 1.5;">${detailRows.map(escapeHtml).join("<br>")}</p>`
          : ""
      }
      ${
        links.length > 0
          ? `<p style="margin: 0; color: ${p.ridge}; font-size: 13px; line-height: 1.5;">${links.join(" &nbsp; ")}</p>`
          : ""
      }
    </div>`;
}

function renderIssueSection(section: XeroReconciliationIssueSectionEmail): string {
  const p = emailPalette();
  const style = issueSeverityStyle(section.severity);
  const itemHtml = section.items.length > 0
    ? section.items.map(renderIssueItem).join("")
    : `<p style="margin: 0; color: ${p.ridge}; font-size: 13px; line-height: 1.5;">Open the Xero admin area to review the affected records.</p>`;

  return `
    <div style="background-color: ${style.bg}; border: 1px solid ${style.border}; border-radius: 8px; padding: 16px; margin: 18px 0;">
      <p style="margin: 0 0 8px 0; color: ${style.text}; font-size: 12px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase;">${escapeHtml(style.label)} &bull; ${section.count}</p>
      <h3 style="margin: 0 0 10px 0; color: ${p.deep}; font-size: 17px; line-height: 1.35;">${escapeHtml(section.title)}</h3>
      <p style="margin: 0 0 8px 0; color: ${p.deep}; font-size: 14px; line-height: 1.5;"><strong>What went wrong:</strong> ${escapeHtml(section.whatWentWrong)}</p>
      <p style="margin: 0 0 12px 0; color: ${p.deep}; font-size: 14px; line-height: 1.5;"><strong>How to fix:</strong> ${escapeHtml(section.howToFix)}</p>
      ${itemHtml}
    </div>`;
}

export function adminXeroReconciliationReportTemplate(report: XeroReconciliationReportEmail): string {
  const p = emailPalette();
  const summaryRows = [
    { label: "Generated", value: formatOperationalDateTime(report.generatedAt) },
    { label: "Lookback Window", value: `${report.lookbackHours} hour${report.lookbackHours === 1 ? "" : "s"}` },
    { label: "Stale Pending Threshold", value: `${report.stalePendingMinutes} minute${report.stalePendingMinutes === 1 ? "" : "s"}` },
    { label: "Issue Categories", value: String(report.summary.issueCategoryCount) },
    { label: "Total Issue Count", value: String(report.summary.issueTotalCount) },
  ];

  const categoryRows = [
    { label: "Missing member contact links", value: String(report.summary.missingMemberContactLinks) },
    { label: "Missing payment invoice links", value: String(report.summary.missingPaymentInvoiceLinks) },
    { label: "Missing refund credit note links", value: String(report.summary.missingPaymentRefundCreditNoteLinks) },
    { label: "Missing subscription invoice links", value: String(report.summary.missingSubscriptionInvoiceLinks) },
    { label: "Mismatched canonical links", value: String(report.summary.mismatchedCanonicalLinks) },
    { label: "Stale canonical links", value: String(report.summary.staleCanonicalLinks) },
    { label: "Duplicate active canonical links", value: String(report.summary.duplicateActiveCanonicalLinks) },
    { label: "Stale pending/running operations", value: String(report.summary.stalePendingOperations) },
    { label: "Recent failed operations", value: String(report.summary.recentFailedOperations) },
    { label: "Recent partial operations", value: String(report.summary.recentPartialOperations) },
    { label: "Unsupported partial operations", value: String(report.summary.unsupportedPartialOperations) },
    { label: "Repeated-failure correlations", value: String(report.summary.repeatedFailureCorrelations) },
    { label: "Persistently failing inbound events", value: String(report.summary.failedInboundEvents) },
  ];

  const issueSections = report.issueSections ?? [];
  const issueSectionHtml = issueSections.map(renderIssueSection).join("");
  const repeatedFailureRows = report.repeatedFailures
    .map((failure) => `
      <tr>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(failure.correlationKey)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${failure.failureCount}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(failure.entityType)} ${escapeHtml(failure.operationType)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${
          failure.localModel && failure.localId
            ? escapeHtml(`${failure.localModel} ${failure.localId}`)
            : "Unavailable"
        }</td>
      </tr>`)
    .join("");

  const unsupportedPartialRows = report.unsupportedPartials
    .map((partial) => `
      <tr>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(partial.operationId)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(partial.entityType)} ${escapeHtml(partial.operationType)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${
          partial.localModel && partial.localId
            ? escapeHtml(`${partial.localModel} ${partial.localId}`)
            : "Unavailable"
        }</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(partial.reason)}</td>
      </tr>`)
    .join("");

  return layout(`
    ${heading("Xero Reconciliation Report")}
    ${
      report.summary.issueCategoryCount === 0
        ? alertBox("No open reconciliation gaps were detected in this report window.", "success")
        : alertBox("Reconciliation gaps were detected. Start with the action sections below, then use the diagnostic totals for context.", "warning")
    }
    ${infoTable(summaryRows)}
    ${
      issueSections.length > 0
        ? issueSectionHtml
        : ""
    }
    ${
      issueSections.length === 0 && report.repeatedFailures.length > 0
        ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Correlation Key</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Failures</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Operation</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Local Record</th>
      </tr>
      ${repeatedFailureRows}
    </table>`
        : ""
    }
    ${
      issueSections.length === 0 && report.unsupportedPartials.length > 0
        ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Operation ID</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Operation</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Local Record</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Repair Gap</th>
      </tr>
      ${unsupportedPartialRows}
    </table>`
        : ""
    }
    ${
      report.summary.issueCategoryCount > 0
        ? `${paragraph("Diagnostic totals")}${infoTable(categoryRows)}`
        : ""
    }
    ${button("Open Xero Admin", BASE_URL + "/admin/xero")}
  `);
}

export function bookingModifiedTemplate(params: {
  firstName: string;
  modificationType: string;
  oldCheckIn: Date;
  oldCheckOut: Date;
  newCheckIn: Date;
  newCheckOut: Date;
  oldGuestCount: number;
  newGuestCount: number;
  oldFinalPriceCents: number;
  newFinalPriceCents: number;
  changeFeeCents: number;
  refundAmountCents: number;
  accountCreditAmountCents?: number;
  additionalAmountCents: number;
  additionalPaymentMethod?: "STRIPE" | "INTERNET_BANKING";
  paymentReference?: string | null;
  xeroInvoiceNumber?: string | null;
}): string {
  const {
    firstName,
    modificationType,
    oldCheckIn,
    oldCheckOut,
    newCheckIn,
    newCheckOut,
    oldGuestCount,
    newGuestCount,
    oldFinalPriceCents,
    newFinalPriceCents,
    changeFeeCents,
    refundAmountCents,
    accountCreditAmountCents = 0,
    additionalAmountCents,
    additionalPaymentMethod,
    paymentReference,
    xeroInvoiceNumber,
  } = params;

  const typeLabel: Record<string, string> = {
    DATE_CHANGE: "Dates Changed",
    GUEST_ADD: "Guests Added",
    GUEST_REMOVE: "Guest Removed",
  };

  const rows: Array<{ label: string; value: string }> = [];

  const datesChanged =
    oldCheckIn.getTime() !== newCheckIn.getTime() ||
    oldCheckOut.getTime() !== newCheckOut.getTime();

  if (datesChanged) {
    rows.push({
      label: "Previous Dates",
      value: `${formatNZDate(oldCheckIn)} &ndash; ${formatNZDate(oldCheckOut)}`,
    });
    rows.push({
      label: "New Dates",
      value: `${formatNZDate(newCheckIn)} &ndash; ${formatNZDate(newCheckOut)}`,
    });
  } else {
    rows.push({
      label: "Dates",
      value: `${formatNZDate(newCheckIn)} &ndash; ${formatNZDate(newCheckOut)}`,
    });
  }

  if (oldGuestCount !== newGuestCount) {
    rows.push({ label: "Previous Guests", value: String(oldGuestCount) });
    rows.push({ label: "New Guests", value: String(newGuestCount) });
  } else {
    rows.push({ label: "Guests", value: String(newGuestCount) });
  }

  if (oldFinalPriceCents !== newFinalPriceCents) {
    rows.push({ label: "Previous Total", value: formatCents(oldFinalPriceCents) });
    rows.push({ label: "New Total", value: formatCents(newFinalPriceCents) });
  } else {
    rows.push({ label: "Total", value: formatCents(newFinalPriceCents) });
  }

  if (changeFeeCents > 0) {
    rows.push({ label: "Change Fee", value: formatCents(changeFeeCents) });
  }

  let paymentNote = "";
  if (refundAmountCents > 0) {
    paymentNote = alertBox(
      `A refund of ${formatCents(refundAmountCents)} has been processed to your original payment method.`,
      "success"
    );
  } else if (accountCreditAmountCents > 0) {
    paymentNote = alertBox(
      `Account credit of ${formatCents(accountCreditAmountCents)} has been added for future bookings.`,
      "success"
    );
  } else if (additionalAmountCents > 0) {
    if (additionalPaymentMethod === "INTERNET_BANKING") {
      const invoiceContext = xeroInvoiceNumber
        ? ` Xero invoice ${escapeHtml(xeroInvoiceNumber)} will be used for payment.`
        : " A Xero invoice and payment reference will be used for payment.";
      const referenceContext = paymentReference
        ? ` Payment reference: ${escapeHtml(paymentReference)}.`
        : "";
      paymentNote = alertBox(
        `An additional Internet Banking payment of ${formatCents(additionalAmountCents)} is required.${invoiceContext}${referenceContext} Xero reconciliation confirms the payment before it is treated as paid.`,
        "warning"
      );
    } else {
      paymentNote = alertBox(
        `An additional payment of ${formatCents(additionalAmountCents)} is required.`,
        "warning"
      );
    }
  }

  return layout(`
    ${heading("Booking Modified")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your booking has been updated.")}
    ${alertBox(typeLabel[modificationType] || modificationType, "info")}
    ${infoTable(rows)}
    ${paymentNote}
    ${paragraph("You can view your updated booking details from your account.")}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

/** F-COMP-04: Account deletion approved — sent before anonymisation */
export function accountDeletionApprovedTemplate(firstName: string): string {
  return layout(`
    ${heading("Account Deletion Confirmed")}
    ${paragraph("Hi " + escapeHtml(firstName) + ",")}
    ${paragraph("We have processed your account deletion request. Your personal data has been anonymised in accordance with our Privacy Policy.")}
    ${alertBox("Your account is now deactivated and you will no longer be able to log in. Booking history has been retained for financial and audit purposes with your personal details removed.", "info")}
    ${paragraph("If you have any questions, please contact the club.")}
    ${supportContactMuted()}
  `);
}

// ---- Family group email templates ----

/** Sent to an adult member when they're invited to join a family group */
export function familyGroupInvitationTemplate(
  inviterName: string,
  groupName: string,
  profileUrl: string
): string {
  return layout(`
    ${heading("Family Group Invitation")}
    ${paragraph("<strong>" + escapeHtml(inviterName) + "</strong> has invited you to join the family group <strong>" + escapeHtml(groupName) + "</strong>.")}
    ${paragraph("You can accept or decline this invitation from your profile page.")}
    ${button("View Invitation", profileUrl)}
    ${muted("If you weren't expecting this invitation, you can safely ignore it.")}
  `);
}

/** Sent to the inviter when their invitation is accepted */
export function familyGroupInviteAcceptedTemplate(
  inviteeName: string,
  groupName: string
): string {
  return layout(`
    ${heading("Invitation Accepted")}
    ${paragraph("<strong>" + escapeHtml(inviteeName) + "</strong> has accepted your invitation and joined <strong>" + escapeHtml(groupName) + "</strong>.")}
    ${alertBox("Your family group has been updated.", "success")}
    ${supportContactMuted()}
  `);
}

/** Sent to parent when their infant/child/youth request is submitted (confirmation) */
export function childRequestSubmittedTemplate(
  parentName: string,
  childName: string,
  groupName: string
): string {
  return layout(`
    ${heading("Infant/Child/Youth Request Submitted")}
    ${paragraph("Hi " + escapeHtml(parentName) + ",")}
    ${paragraph("Your request to add <strong>" + escapeHtml(childName) + "</strong> to the family group <strong>" + escapeHtml(groupName) + "</strong> has been submitted.")}
    ${alertBox("An administrator will review your request and link the member to your family group. You'll be notified once it's been processed.", "info")}
    ${supportContactMuted()}
  `);
}

/** Sent to parent when their infant/child/youth request is approved by admin */
export function childRequestApprovedTemplate(
  parentName: string,
  childName: string,
  groupName: string
): string {
  return layout(`
    ${heading("Infant/Child/Youth Added to Family Group")}
    ${paragraph("Hi " + escapeHtml(parentName) + ",")}
    ${paragraph("<strong>" + escapeHtml(childName) + "</strong> has been added to your family group <strong>" + escapeHtml(groupName) + "</strong>.")}
    ${alertBox("You can now include them when making bookings.", "success")}
    ${supportContactMuted()}
  `);
}

/** Sent to parent when their infant/child/youth request is rejected by admin */
export function childRequestRejectedTemplate(
  parentName: string,
  childName: string,
  reason?: string
): string {
  const reasonHtml = reason
    ? `${alertBox("Admin note: " + escapeHtml(reason), "warning")}`
    : "";
  return layout(`
    ${heading("Infant/Child/Youth Request Update")}
    ${paragraph("Hi " + escapeHtml(parentName) + ",")}
    ${paragraph("Your request to add <strong>" + escapeHtml(childName) + "</strong> to your family group was not approved.")}
    ${reasonHtml}
    ${paragraph("If you have questions, please contact the club.")}
    ${supportContactMuted()}
  `);
}

/** Admin alert: family group request created */
export function adminFamilyGroupRequestTemplate(data: {
  requestType: string;
  requesterName: string;
  groupName: string;
  details: string;
}): string {
  return layout(`
    ${heading("Family Group Request")}
    ${paragraph("A new <strong>" + escapeHtml(data.requestType) + "</strong> request has been submitted.")}
    ${paragraph("<strong>Requester:</strong> " + escapeHtml(data.requesterName))}
    ${paragraph("<strong>Group:</strong> " + escapeHtml(data.groupName))}
    ${multilineBlock(escapeHtml(data.details))}
    ${button("Review Requests", (process.env.NEXTAUTH_URL || "http://localhost:3000") + "/admin/family-groups")}
    ${supportContactMuted()}
  `);
}

/** Confirmation email sent to the requester when they submit a join request */
export function joinRequestConfirmationTemplate(
  requesterName: string,
  groupName: string
): string {
  return layout(`
    ${heading("Join Request Submitted")}
    ${paragraph("Hi " + escapeHtml(requesterName) + ",")}
    ${paragraph("Your request to join the family group <strong>" + escapeHtml(groupName) + "</strong> has been submitted.")}
    ${alertBox("An administrator will review your request. You'll be notified once it's been processed.", "info")}
    ${supportContactMuted()}
  `);
}

export function membershipCancellationSubmittedTemplate(params: {
  firstName: string;
  participantSummary: string;
  reason?: string | null;
  reviewUrl: string;
}): string {
  const reasonHtml = params.reason
    ? paragraph("Reason: <strong>" + escapeHtml(params.reason) + "</strong>")
    : "";

  return layout(`
    ${heading("Membership Cancellation Request Submitted")}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ",")}
    ${paragraph("Your membership cancellation request has been submitted for admin review.")}
    ${infoTable([
      { label: "Included memberships", value: escapeHtml(params.participantSummary) },
    ])}
    ${reasonHtml}
    ${alertBox(
      "Memberships remain active until an administrator approves the request. Any included login-capable adult must confirm before an administrator can process their cancellation.",
      "info"
    )}
    ${button("View Request", params.reviewUrl, { sameOrigin: true })}
    ${supportContactMuted()}
  `);
}

export function membershipCancellationConfirmationTemplate(params: {
  firstName: string;
  requesterName: string;
  participantName: string;
  confirmationUrl: string;
  expiresAt: Date;
}): string {
  return layout(`
    ${heading("Confirm Membership Cancellation")}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ",")}
    ${paragraph(
      "<strong>" +
        escapeHtml(params.requesterName) +
        "</strong> has included <strong>" +
        escapeHtml(params.participantName) +
        "</strong> in a membership cancellation request."
    )}
    ${alertBox(
      "Your membership will remain active unless you sign in and confirm that you want to be included. This confirmation does not approve or process the cancellation; an administrator still needs to review the request.",
      "warning"
    )}
    ${paragraph(
      "This link expires on <strong>" +
        escapeHtml(formatNZDateTime(params.expiresAt)) +
        "</strong>."
    )}
    ${button("Review Cancellation Request", params.confirmationUrl, { sameOrigin: true })}
    ${muted("If you do not want to be included, use the link and choose Decline. If you were not expecting this request, you can ignore this email or contact the club.")}
  `);
}

export function adminMembershipCancellationRequestTemplate(data: {
  requesterName: string;
  participantSummary: string;
  reason?: string | null;
  reviewUrl: string;
}): string {
  const reasonHtml = data.reason
    ? paragraph("Reason: <strong>" + escapeHtml(data.reason) + "</strong>")
    : "";

  return layout(`
    ${heading("Membership Cancellation Ready for Review")}
    ${paragraph(
      "<strong>" +
        escapeHtml(data.requesterName) +
        "</strong> submitted a membership cancellation request with at least one participant ready for admin review."
    )}
    ${infoTable([
      { label: "Requester", value: escapeHtml(data.requesterName) },
      { label: "Included memberships", value: escapeHtml(data.participantSummary) },
    ])}
    ${reasonHtml}
    ${button("Review Cancellation Requests", data.reviewUrl, { sameOrigin: true })}
    ${supportContactMuted()}
  `);
}

export function adminMemberArchiveRequestedTemplate(data: {
  requesterName: string;
  memberName: string;
  reason: string;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Member Archive Requested")}
    ${paragraph(
      "<strong>" +
        escapeHtml(data.requesterName) +
        "</strong> requested archive review for <strong>" +
        escapeHtml(data.memberName) +
        "</strong>."
    )}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Requested by", value: escapeHtml(data.requesterName) },
    ])}
    ${multilineBlock(escapeHtml(data.reason))}
    ${button("Review Archive Requests", data.reviewUrl, { sameOrigin: true })}
    ${supportContactMuted()}
  `);
}

export function memberArchiveApprovedTemplate(data: {
  firstName: string;
  reason: string;
  reviewNote?: string | null;
}): string {
  const reviewNoteHtml = data.reviewNote
    ? alertBox("Review note: " + escapeHtml(data.reviewNote), "info")
    : "";

  return layout(`
    ${heading("Membership Archive Completed")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ",")}
    ${paragraph("Your cancelled membership record has been archived.")}
    ${multilineBlock(escapeHtml(data.reason))}
    ${reviewNoteHtml}
    ${alertBox(
      "Archive preserves booking, payment, Xero, and audit history while removing the record from default operational lists.",
      "info"
    )}
    ${supportContactMuted()}
  `);
}

export function memberArchiveRejectedTemplate(data: {
  firstName: string;
  reason: string;
  reviewNote?: string | null;
}): string {
  const reviewNoteHtml = data.reviewNote
    ? alertBox("Review note: " + escapeHtml(data.reviewNote), "warning")
    : "";

  return layout(`
    ${heading("Membership Archive Request Update")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ",")}
    ${paragraph("The archive request for your cancelled membership was not approved at this time.")}
    ${multilineBlock(escapeHtml(data.reason))}
    ${reviewNoteHtml}
    ${supportContactMuted()}
  `);
}

export function adminMemberDeleteRequestedTemplate(data: {
  requesterName: string;
  memberName: string;
  reason: string;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Member Delete Requested")}
    ${paragraph(
      "<strong>" +
        escapeHtml(data.requesterName) +
        "</strong> requested hard-delete review for <strong>" +
        escapeHtml(data.memberName) +
        "</strong>."
    )}
    ${alertBox(
      "Hard delete is only for records added in error with no meaningful booking, financial, lodge, Xero, or audit history.",
      "warning"
    )}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Requested by", value: escapeHtml(data.requesterName) },
    ])}
    ${multilineBlock(escapeHtml(data.reason))}
    ${button("Review Member", data.reviewUrl, { sameOrigin: true })}
    ${supportContactMuted()}
  `);
}

export function adminMemberDeleteApprovedTemplate(data: {
  requesterName: string;
  memberName: string;
  reason: string;
  reviewNote?: string | null;
}): string {
  const reviewNoteHtml = data.reviewNote
    ? alertBox("Review note: " + escapeHtml(data.reviewNote), "info")
    : "";

  return layout(`
    ${heading("Member Delete Approved")}
    ${paragraph("Hi " + escapeHtml(data.requesterName) + ",")}
    ${paragraph(
      "The hard-delete request for <strong>" +
        escapeHtml(data.memberName) +
        "</strong> was approved and processed."
    )}
    ${multilineBlock(escapeHtml(data.reason))}
    ${reviewNoteHtml}
    ${alertBox(
      "A request snapshot was retained before the member record was deleted.",
      "info"
    )}
    ${supportContactMuted()}
  `);
}

export function adminMemberDeleteRejectedTemplate(data: {
  requesterName: string;
  memberName: string;
  reason: string;
  reviewNote?: string | null;
  reviewUrl: string;
}): string {
  const reviewNoteHtml = data.reviewNote
    ? alertBox("Review note: " + escapeHtml(data.reviewNote), "warning")
    : "";

  return layout(`
    ${heading("Member Delete Request Rejected")}
    ${paragraph("Hi " + escapeHtml(data.requesterName) + ",")}
    ${paragraph(
      "The hard-delete request for <strong>" +
        escapeHtml(data.memberName) +
        "</strong> was not approved."
    )}
    ${multilineBlock(escapeHtml(data.reason))}
    ${reviewNoteHtml}
    ${button("Open Member", data.reviewUrl, { sameOrigin: true })}
    ${supportContactMuted()}
  `);
}

export function membershipCancellationApprovedTemplate(params: {
  firstName: string;
  participantName: string;
  reason?: string | null;
  adminNote?: string | null;
  rejoinProcessText?: string | null;
}): string {
  const reasonHtml = params.reason
    ? `${paragraph(
        "Request reason: <strong>" + escapeHtml(params.reason) + "</strong>"
      )}`
    : "";
  const adminNoteHtml = params.adminNote
    ? `${alertBox("Admin note: " + escapeHtml(params.adminNote), "info")}`
    : "";
  const rejoinHtml = params.rejoinProcessText
    ? `${alertBox(escapeHtml(params.rejoinProcessText), "warning")}`
    : "";

  return layout(`
    ${heading("Membership Cancellation Approved")}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ",")}
    ${paragraph(
      "The membership cancellation for <strong>" +
        escapeHtml(params.participantName) +
        "</strong> has been approved and processed."
    )}
    ${reasonHtml}
    ${alertBox(
      "This membership is now inactive and the booking login has been disabled. Booking, payment, and audit history has been retained.",
      "info"
    )}
    ${adminNoteHtml}
    ${rejoinHtml}
    ${supportContactMuted()}
  `);
}

export function membershipCancellationRejectedTemplate(params: {
  firstName: string;
  participantName: string;
  reason?: string | null;
  adminNote?: string | null;
}): string {
  const reasonHtml = params.reason
    ? `${paragraph(
        "Request reason: <strong>" + escapeHtml(params.reason) + "</strong>"
      )}`
    : "";
  const adminNoteHtml = params.adminNote
    ? `${alertBox("Admin note: " + escapeHtml(params.adminNote), "warning")}`
    : "";

  return layout(`
    ${heading("Membership Cancellation Request Update")}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ",")}
    ${paragraph(
      "The membership cancellation request for <strong>" +
        escapeHtml(params.participantName) +
        "</strong> was not approved at this time."
    )}
    ${reasonHtml}
    ${adminNoteHtml}
    ${paragraph("This membership remains active.")}
    ${supportContactMuted()}
  `);
}

export function adminMembershipApplicationPendingTemplate(data: {
  applicantName: string;
  applicantEmail: string;
  familyMemberCount: number;
  reviewUrl: string;
}): string {
  const dependentSummary =
    data.familyMemberCount > 0
      ? `${paragraph(
          "This application includes " +
            String(data.familyMemberCount) +
            " dependent family member" +
            (data.familyMemberCount === 1 ? "" : "s") +
            "."
        )}`
      : "";

  return layout(`
    ${heading("Membership Application Ready for Review")}
    ${paragraph("Both nominators have now confirmed a new membership application.")}
    ${infoTable([
      { label: "Applicant", value: escapeHtml(data.applicantName) },
      { label: "Email", value: escapeHtml(data.applicantEmail) },
    ])}
    ${dependentSummary}
    ${button("Review Application", data.reviewUrl)}
    ${supportContactMuted()}
  `);
}

export function adminAccountDeletionRequestedTemplate(data: {
  memberName: string;
  memberEmail: string;
  reason?: string | null;
  reviewUrl: string;
}): string {
  const reasonHtml = data.reason
    ? multilineBlock(escapeHtml(data.reason))
    : muted("No reason was provided.");

  return layout(`
    ${heading("Account Deletion Request Submitted")}
    ${paragraph(
      "<strong>" +
        escapeHtml(data.memberName) +
        "</strong> submitted an account deletion request."
    )}
    ${alertBox(
      "Review privacy requests promptly and record the decision from the deletion requests queue.",
      "warning"
    )}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Email", value: escapeHtml(data.memberEmail) },
    ])}
    ${reasonHtml}
    ${button("Review Deletion Requests", data.reviewUrl, { sameOrigin: true })}
    ${supportContactMuted()}
  `);
}

export function membershipApplicationApprovedTemplate(
  firstName: string,
  resetUrl: string,
  adminNotes?: string | null
): string {
  const notes = adminNotes
    ? `${alertBox("Committee note: " + escapeHtml(adminNotes), "info")}`
    : "";

  return layout(`
    ${heading("Membership Approved")}
    ${paragraph(`Hi ${escapeHtml(firstName)}, your ${escapeHtml(CLUB_NAME)} membership application has been approved.`)}
    ${paragraph("Your account is ready. Use the button below to set your password and access the bookings system.")}
    ${button("Set Up My Account", resetUrl)}
    ${notes}
    ${paragraph("Your entrance fee and any membership charges will be managed separately through the club's normal process.")}
    ${muted("This setup link expires in " + String(MEMBER_SETUP_INVITE_TTL_DAYS) + " days.")}
  `);
}

export function membershipApplicationRejectedTemplate(
  firstName: string,
  adminNotes?: string | null
): string {
  const notes = adminNotes
    ? `${alertBox("Committee note: " + escapeHtml(adminNotes), "warning")}`
    : "";

  return layout(`
    ${heading("Membership Application Update")}
    ${paragraph(`Hi ${escapeHtml(firstName)}, your ${escapeHtml(CLUB_NAME)} membership application has been reviewed.`)}
    ${paragraph("The committee has decided not to approve the application at this time.")}
    ${notes}
    ${paragraph("If you would like more information, please contact the club directly.")}
    ${supportContactMuted()}
  `);
}

export interface AgeUpInvitationTemplateOptions {
  targetAgeTierLabel?: string;
}

/** Age-up invitation — sent when a youth/child reaches the ADULT age tier and gets their own login */
export function ageUpInvitationTemplate(
  firstName: string,
  resetUrl: string,
  options: AgeUpInvitationTemplateOptions = {}
): string {
  const name = escapeHtml(firstName);
  const targetAgeTierLabel = options.targetAgeTierLabel?.trim() || "Adult (18+)";
  return layout(`
    ${heading("Welcome to Your Own Account, " + name + "!")}
    ${paragraph(`Congratulations — you've reached the ${escapeHtml(targetAgeTierLabel)} age tier. You can now log in and book stays at the lodge yourself.`)}
    ${paragraph(
      "Click the button below to set up your password and activate your account. This link expires in <strong>" +
        String(MEMBER_SETUP_INVITE_TTL_DAYS) +
        " days</strong>."
    )}
    ${button("Set Up My Password", resetUrl)}
    ${alertBox("Once you set your password, you can log in at any time to book stays, view your bookings, and manage your profile.", "info")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
  `);
}

export interface AgeUpParentEmailHandoffTemplateOptions {
  recipientName: string;
  memberFirstName: string;
  memberLastName: string;
  targetAgeTierLabel?: string;
}

/** Age-up handoff — sent to the parent/source login holder when a member still shares an email */
export function ageUpParentEmailHandoffTemplate({
  recipientName,
  memberFirstName,
  memberLastName,
  targetAgeTierLabel,
}: AgeUpParentEmailHandoffTemplateOptions): string {
  const safeRecipientName = escapeHtml(recipientName.trim() || "there");
  const memberName = escapeHtml(
    [memberFirstName, memberLastName].filter(Boolean).join(" ").trim() ||
      memberFirstName
  );
  const safeTargetAgeTierLabel = escapeHtml(
    targetAgeTierLabel?.trim() || "Adult (18+)"
  );

  return layout(`
    ${heading("Email Address Needed for " + memberName)}
    ${paragraph(`Hi ${safeRecipientName},`)}
    ${paragraph(`${memberName} has reached the ${safeTargetAgeTierLabel} age tier. Before we can activate their own booking login, they need a unique email address on their member record.`)}
    ${paragraph("They are currently using or inheriting another member's login email, so we have not enabled their login yet.")}
    ${paragraph(`Please contact the club with ${memberName}'s preferred email address. Once it is updated, their booking login can be activated.`)}
    ${supportContactSentence("Contact the club at ")}
  `);
}

/** F-COMP-04: Account deletion rejected — sent to member with admin note */
export function accountDeletionRejectedTemplate(
  firstName: string,
  adminNote: string
): string {
  const noteHtml = adminNote
    ? `${alertBox("Admin note: " + escapeHtml(adminNote), "warning")}`
    : "";
  return layout(`
    ${heading("Account Deletion Request Update")}
    ${paragraph("Hi " + escapeHtml(firstName) + ",")}
    ${paragraph("Your account deletion request has been reviewed and was not approved at this time.")}
    ${noteHtml}
    ${paragraph("If you have questions about this decision, please contact the club directly.")}
    ${supportContactMuted()}
  `);
}

// ---- Waitlist templates ----

export function waitlistConfirmationTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  position: number
): string {
  return layout(`
    ${heading("You're on the Waitlist")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", the lodge is currently fully booked for your requested dates, but you've been added to the waitlist.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "Guests", value: String(guestCount) },
      { label: "Waitlist Position", value: "#" + String(position) },
    ])}
    ${alertBox("We'll email you as soon as a spot opens up. You'll have 48 hours to confirm your booking.", "info")}
    ${button("View Booking", BASE_URL + "/bookings")}
    ${muted("You can cancel your waitlist entry at any time from your booking page.")}
  `);
}

export function waitlistOfferTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  expiresAt: Date,
  bookingId: string,
  priceCents: number
): string {
  return layout(`
    ${heading("A Spot Has Opened Up!")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", great news — a spot has become available for your waitlisted booking.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "Guests", value: String(guestCount) },
      { label: "Price", value: formatCents(priceCents) },
    ])}
    ${alertBox("This offer expires on " + formatNZDateTime(expiresAt) + ". If you don't confirm in time, the spot will be offered to the next person in line.", "warning")}
    ${button("Confirm Booking", BASE_URL + "/bookings/" + bookingId)}
    ${muted("If you no longer need this booking, you can decline from your booking page.")}
  `);
}

export function waitlistOfferExpiredTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  position: number
): string {
  return layout(`
    ${heading("Waitlist Offer Expired")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your waitlist offer for the dates below has expired.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "New Position", value: "#" + String(position) },
    ])}
    ${paragraph("You've been returned to the waitlist. We'll notify you again if another spot opens up.")}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

export function adminWaitlistOfferTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  position: number;
}): string {
  return layout(`
    ${heading("Waitlist Offer Made")}
    ${paragraph("A waitlist offer has been sent to " + escapeHtml(data.memberName) + ".")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Queue Position", value: "#" + String(data.position) },
    ])}
    ${paragraph("The member has 48 hours to confirm their booking.")}
    ${button("View Waitlist", BASE_URL + "/admin/waitlist")}
  `);
}

export function setupIntentFailedTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  const dates = `${data.checkIn.toLocaleDateString("en-NZ")} – ${data.checkOut.toLocaleDateString("en-NZ")}`;
  return layout(`
    ${heading("Card Setup Failed")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ",")}
    ${alertBox("We were unable to save your card details for your upcoming booking (" + dates + "). Your booking is still held, but we won't be able to charge you automatically when it's confirmed.", "warning")}
    ${paragraph("Please log in and update your payment method to avoid your booking being cancelled.")}
    ${button("Update Payment Method", (process.env.NEXTAUTH_URL || "http://localhost:3000") + "/bookings")}
    ${supportContactSentence("If you need help, contact the club at ")}
  `);
}

export function adminRefundRequestTemplate(data: {
  memberName: string;
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
  reason: string;
  requestedAmountCents: number | null;
  paidAmountCents: number;
  refundedAmountCents: number;
}): string {
  const remaining = data.paidAmountCents - data.refundedAmountCents;
  return layout(`
    ${heading("Refund Appeal Submitted")}
    ${paragraph(escapeHtml(data.memberName) + " has submitted a refund appeal.")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Paid", value: "$" + (data.paidAmountCents / 100).toFixed(2) },
      { label: "Already Refunded", value: "$" + (data.refundedAmountCents / 100).toFixed(2) },
      { label: "Remaining", value: "$" + (remaining / 100).toFixed(2) },
      ...(data.requestedAmountCents ? [{ label: "Requested", value: "$" + (data.requestedAmountCents / 100).toFixed(2) }] : []),
    ])}
    ${alertBox(escapeHtml(data.reason), "info")}
    ${button("Review Appeal", BASE_URL + "/admin/refund-requests")}
  `);
}

export function adminBookingChangeRequestTemplate(data: {
  memberName: string;
  memberEmail: string;
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
  requestedSummary: string;
  reason: string | null;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Booking Change Request Submitted")}
    ${paragraph(escapeHtml(data.memberName) + " has requested an admin-reviewed booking change for a locked same-day or past-night period.")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Email", value: escapeHtml(data.memberEmail) },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      { label: "Current check-in", value: formatNZDate(data.checkIn) },
      { label: "Current check-out", value: formatNZDate(data.checkOut) },
      { label: "Requested change", value: escapeHtml(data.requestedSummary) },
    ])}
    ${data.reason ? alertBox(escapeHtml(data.reason), "info") : ""}
    ${button("Review Request", data.reviewUrl)}
  `);
}

export function adminIssueReportTemplate(data: {
  memberName: string;
  memberEmail: string;
  pageUrl: string;
  pageTitle?: string | null;
  description: string;
  issueReportUrl: string;
  hasScreenshot: boolean;
}): string {
  return layout(`
    ${heading("Issue Report Submitted")}
    ${paragraph(escapeHtml(data.memberName) + " has reported an issue from the bookings site.")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Email", value: escapeHtml(data.memberEmail) },
      { label: "Page", value: escapeHtml(data.pageTitle || data.pageUrl) },
      { label: "Screenshot", value: data.hasScreenshot ? "Available in admin" : "Not included" },
    ])}
    ${alertBox(escapeHtml(data.description), "info")}
    ${button("Review Issue Report", data.issueReportUrl, { sameOrigin: true })}
    ${button("Open Reported Page", data.pageUrl, { sameOrigin: true })}
  `);
}

export function refundRequestResolvedTemplate(data: {
  firstName: string;
  status: "APPROVED" | "REJECTED";
  amountCents: number | null;
  adminNotes: string | null;
  checkIn: Date;
  checkOut: Date;
}): string {
  const isApproved = data.status === "APPROVED";
  return layout(`
    ${heading("Refund Appeal " + (isApproved ? "Approved" : "Update"))}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ",")}
    ${isApproved
      ? alertBox(
          "Your refund appeal for your booking (" + formatNZDate(data.checkIn) + " - " + formatNZDate(data.checkOut) + ") has been approved. A refund of " + formatCents(data.amountCents ?? 0) + " will be processed to your original payment method.",
          "success"
        )
      : alertBox(
          "Your refund appeal for your booking (" + formatNZDate(data.checkIn) + " - " + formatNZDate(data.checkOut) + ") was not approved at this time.",
          "warning"
        )
    }
    ${data.adminNotes ? multilineBlock("<strong>Notes:</strong>\n" + escapeHtml(data.adminNotes)) : ""}
    ${supportContactSentence("If you have questions, contact the club at ")}
  `);
}

// ---- Public booking request flow (issue #707) ----

export function bookingRequestVerificationTemplate(data: {
  firstName: string;
  verifyUrl: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  expiresAt: Date;
}): string {
  return layout(`
    ${heading("Confirm Your Booking Request")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", thanks for your booking request for " + escapeHtml(CLUB_NAME) + "'s lodge.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
    ])}
    ${paragraph("Please confirm your email address so the club can review your request. Your request will not be reviewed until you confirm.")}
    ${button("Confirm My Email", data.verifyUrl)}
    ${muted("This link expires on " + escapeHtml(formatNZDateTime(data.expiresAt)) + ". If you did not make this request, you can safely ignore this email and the request will be deleted.")}
  `);
}

export function groupSettlementReceiptTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  joinerCount: number;
  totalCents: number;
}): string {
  return layout(`
    ${heading("Your Group Booking Is Settled")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", thanks for settling your group's stay at " + escapeHtml(CLUB_NAME) + "'s lodge. Everyone you are paying for is now confirmed.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Joiners settled", value: String(data.joinerCount) },
      { label: "Total paid", value: formatCents(data.totalCents) },
    ])}
    ${paragraph("Each joiner has been emailed to confirm their spot. There is nothing more for them to pay.")}
    ${supportContactSentence("If anything looks wrong, contact the club at ")}
  `);
}

export function groupJoinSettledTemplate(data: {
  firstName: string;
  organiserName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
}): string {
  return layout(`
    ${heading("Your Spot Is Confirmed")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", " + escapeHtml(data.organiserName) + " has settled the cost of your stay at " + escapeHtml(CLUB_NAME) + "'s lodge as part of their group booking. Your spot is confirmed and there is nothing for you to pay.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
    ])}
    ${supportContactSentence("If you have any questions about your stay, contact the club at ")}
  `);
}

export function groupSettlementExpiredTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  joinerCount: number;
  totalCents: number;
}): string {
  return layout(`
    ${heading("Your Group Settlement Has Expired")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", the combined payment you started for your group's stay at " + escapeHtml(CLUB_NAME) + "'s lodge was not completed in time, so the beds held for your joiners have been released.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Joiners affected", value: String(data.joinerCount) },
      { label: "Amount not charged", value: formatCents(data.totalCents) },
    ])}
    ${paragraph("No money has been taken. If your group still plans to come, restart the payment from your group booking page — the beds are subject to availability.")}
    ${supportContactSentence("If anything looks wrong, contact the club at ")}
  `);
}

export function groupJoinReleasedTemplate(data: {
  firstName: string;
  organiserName: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  return layout(`
    ${heading("Your Held Spot Has Been Released")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", " + escapeHtml(data.organiserName) + " started a combined payment for your stay at " + escapeHtml(CLUB_NAME) + "'s lodge but it was not completed in time, so your held bed has been released.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
    ])}
    ${paragraph("Your booking is back to awaiting payment. If the group still plans to come, the organiser can restart the payment — or check with them about what happens next.")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
  `);
}

/**
 * Final notice after a reaped organiser-pays place is cancelled (#1094): the
 * organiser never restarted the combined payment, so the joiner's pending
 * booking reached its terminal state.
 */
export function groupJoinCancelledTemplate(data: {
  firstName: string;
  organiserName: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  return layout(`
    ${heading("Your Group Booking Has Been Cancelled")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", the combined group payment " + escapeHtml(data.organiserName) + " started for your stay at " + escapeHtml(CLUB_NAME) + "'s lodge was never completed, so your pending booking has now been cancelled. Nothing has been charged to you.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
    ])}
    ${paragraph("If you still want to come, you can make your own booking for these dates — or talk to the organiser about starting a fresh group trip.")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
  `);
}

export function bookingRequestApprovedTemplate(data: {
  firstName: string;
  payUrl: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  priceCents: number;
  expiresAt: Date;
}): string {
  return layout(`
    ${heading("Your Booking Request Has Been Approved")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", good news — the club has approved your booking request.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Price", value: formatCents(data.priceCents) },
    ])}
    ${paragraph("Use the secure link below to pay and confirm your stay. You can pay by card, or by internet banking using the reference shown on the payment page.")}
    ${button("Pay for My Stay", data.payUrl)}
    ${alertBox("Until payment is received, club members keep priority for these dates and your booking may be bumped if the lodge fills.", "info")}
    ${muted("This payment link expires on " + escapeHtml(formatNZDateTime(data.expiresAt)) + ". If you have any questions, just reply to this email or contact the club.")}
  `);
}

export function bookingRequestQuoteTemplate(data: {
  firstName: string;
  respondUrl: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  options: Array<{ label: string; totalCents: number }>;
  message?: string | null;
  expiresAt: Date;
  schoolName?: string | null;
  isReminder?: boolean;
}): string {
  const optionRows = data.options.map((option) => ({
    label: option.label,
    value: formatCents(option.totalCents),
  }));

  return layout(`
    ${heading(data.isReminder ? "Reminder: Your Booking Quote Is Expiring Soon" : "Your Booking Quote Is Ready")}
    ${paragraph(
      data.isReminder
        ? "Hi " +
            escapeHtml(data.firstName) +
            ", this is a reminder that your lodge quote is still waiting and will expire soon. We have included a fresh secure link below so you do not need to find the original email."
        : "Hi " + escapeHtml(data.firstName) + ", the club has prepared a quote for your lodge request.",
    )}
    ${infoTable([
      ...(data.schoolName ? [{ label: "School", value: data.schoolName }] : []),
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      ...optionRows,
    ])}
    ${data.message ? multilineBlock("<strong>Note from the club:</strong>\n" + escapeHtml(data.message)) : ""}
    ${paragraph("Use the secure link below to accept, cancel, request changes, or send a question about this quote.")}
    ${button("Respond to Quote", data.respondUrl)}
    ${muted("This quote link expires on " + escapeHtml(formatNZDateTime(data.expiresAt)) + ". If you have questions, just reply to this email or contact the club.")}
  `);
}

export function bookingRequestDeclinedTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  reason?: string | null;
}): string {
  return layout(`
    ${heading("Update on Your Booking Request")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", thank you for your interest in staying at " + escapeHtml(CLUB_NAME) + "'s lodge.")}
    ${paragraph("Unfortunately the club is unable to accommodate your request for " + escapeHtml(formatNZDate(data.checkIn)) + " to " + escapeHtml(formatNZDate(data.checkOut)) + " at this time.")}
    ${data.reason ? multilineBlock("<strong>Note from the club:</strong>\n" + escapeHtml(data.reason)) : ""}
    ${paragraph("You are welcome to submit another request for different dates.")}
    ${supportContactSentence("If you have questions, contact the club at ")}
  `);
}

export function adminBookingRequestPendingTemplate(data: {
  requesterName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Booking Request Ready for Review")}
    ${paragraph("A public booking request has verified their email address and is ready for pricing and review.")}
    ${infoTable([
      { label: "Requester", value: escapeHtml(data.requesterName) },
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
    ])}
    ${button("Review Booking Requests", data.reviewUrl, { sameOrigin: true })}
  `);
}

export function adminSchoolManualInvoiceTemplate(data: {
  schoolName: string;
  contactEmail: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("School Booking Needs a Manual Invoice")}
    ${paragraph("A school group booking has been approved and confirmed. The Xero module is currently off, so no invoice was raised automatically. Please invoice the school manually and record payment through the usual paths.")}
    ${infoTable([
      { label: "School", value: escapeHtml(data.schoolName) },
      { label: "Contact email", value: escapeHtml(data.contactEmail) },
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Amount", value: formatCents(data.totalCents) },
    ])}
    ${button("View Booking Requests", data.reviewUrl, { sameOrigin: true })}
  `);
}

export function adminBookingRequestHoldExpiredTemplate(data: {
  requesterName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  holdUntil: Date;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Request Booking Unpaid at Hold Expiry")}
    ${paragraph("A booking created from a public booking request reached its hold deadline without payment. There is no saved card to charge, so the hold has been extended and the booking still holds member-priority status.")}
    ${infoTable([
      { label: "Requester", value: escapeHtml(data.requesterName) },
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Total", value: formatCents(data.totalCents) },
      { label: "Hold extended to", value: formatNZDateTime(data.holdUntil) },
    ])}
    ${paragraph("Consider following up with the requester or cancelling the booking if payment is not expected.")}
    ${button("View Bookings", data.reviewUrl, { sameOrigin: true })}
  `);
}


/**
 * School attendee confirmation prompt (#1101): tokenized link where the
 * school contact renames placeholder attendees and confirms the list.
 */
export function schoolAttendeeConfirmationTemplate(data: {
  firstName: string;
  schoolName: string | null;
  confirmUrl: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  isReminder: boolean;
}): string {
  const stayLabel = data.schoolName
    ? escapeHtml(data.schoolName) + "'s stay"
    : "your school group's stay";
  return layout(`
    ${heading(data.isReminder ? "Reminder: Confirm Your Attendee List" : "Confirm Your Attendee List")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", " + stayLabel + " at " + escapeHtml(CLUB_NAME) + "'s lodge is coming up, and the booking currently lists placeholder attendee names. Please tell us who is coming so the lodge roster shows real names on arrival.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Attendees", value: String(data.guestCount) },
    ])}
    ${paragraph("Use the secure link below to update the names and confirm the list. You can come back and edit until you confirm; the link stays valid until check-in.")}
    ${button("Confirm Attendees", data.confirmUrl)}
    ${muted("Need to change how many people are coming, or their age groups? Contact the club instead — headcount changes go through a revised quote.")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
  `);
}
