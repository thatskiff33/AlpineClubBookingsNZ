/**
 * HTML email templates for TAC Bookings.
 * All templates use inline CSS for maximum email client compatibility.
 */

import { LODGE_CAPACITY } from "./capacity";
import { MEMBER_SETUP_INVITE_TTL_DAYS } from "./member-setup-invite";

const BASE_URL = process.env.NEXTAUTH_URL || "http://localhost:3000";

/** Escape HTML special characters to prevent injection in email templates. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BRAND_COLOR = "#ffcb05"; // Tokoroa Yellow
const BRAND_CHARCOAL = "#4d4d46";
const BRAND_DEEP = "#2f2f2b";
const BRAND_MIST = "#d9d5c2";
const BRAND_SNOW = "#f7f5ed";
const BRAND_LOGO_URL = `${BASE_URL}/images/tac-logo.png`;
const BRAND_LIGHT = BRAND_MIST;
const TEXT_COLOR = BRAND_DEEP;
const TEXT_MUTED = "#6a6a63";
const BG_COLOR = BRAND_SNOW;
const WHITE = "#ffffff";
const BORDER_COLOR = BRAND_MIST;

function layout(content: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TAC Bookings</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${BG_COLOR}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${BG_COLOR};">
    <tr>
      <td align="center" style="padding: 24px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">
          <!-- Header -->
          <tr>
            <td style="background-color: ${BRAND_CHARCOAL}; padding: 28px 32px 24px; border-top: 4px solid ${BRAND_COLOR}; border-radius: 8px 8px 0 0; text-align: center;">
              <img
                src="${BRAND_LOGO_URL}"
                alt="Tokoroa Alpine Club"
                width="176"
                style="display: block; margin: 0 auto 14px; width: 176px; max-width: 100%; height: auto;"
              />
              <p style="margin: 0; color: ${WHITE}; font-size: 13px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;">
                Lodge Booking System
              </p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="background-color: ${WHITE}; padding: 32px; border-left: 1px solid ${BORDER_COLOR}; border-right: 1px solid ${BORDER_COLOR};">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: ${WHITE}; padding: 20px 32px; border-top: 1px solid ${BORDER_COLOR}; border-radius: 0 0 8px 8px; border-left: 1px solid ${BORDER_COLOR}; border-right: 1px solid ${BORDER_COLOR}; border-bottom: 1px solid ${BORDER_COLOR};">
              <p style="margin: 0; color: ${TEXT_MUTED}; font-size: 12px; text-align: center;">
                Tokoroa Alpine Club &bull; Lodge Bookings<br>
                <a href="${BASE_URL}" style="color: ${BRAND_CHARCOAL}; font-weight: 600; text-decoration: none;">${BASE_URL.replace(/^https?:\/\//, "")}</a>
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

function button(text: string, url: string): string {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 24px 0;">
  <tr>
    <td style="background-color: ${BRAND_COLOR}; border-radius: 6px;">
      <a href="${url}" target="_blank" style="display: inline-block; padding: 12px 28px; color: ${BRAND_CHARCOAL}; text-decoration: none; font-weight: 700; font-size: 14px;">
        ${text}
      </a>
    </td>
  </tr>
</table>`;
}

function infoTable(rows: Array<{ label: string; value: string }>): string {
  const rowsHtml = rows
    .map(
      (r) => `
    <tr>
      <td style="padding: 8px 12px; font-weight: 600; color: ${TEXT_COLOR}; font-size: 14px; border-bottom: 1px solid ${BORDER_COLOR}; white-space: nowrap;">${r.label}</td>
      <td style="padding: 8px 12px; color: ${TEXT_COLOR}; font-size: 14px; border-bottom: 1px solid ${BORDER_COLOR};">${r.value}</td>
    </tr>`
    )
    .join("");

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${BORDER_COLOR}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
  ${rowsHtml}
</table>`;
}

function heading(text: string): string {
  return `<h2 style="margin: 0 0 16px 0; color: ${TEXT_COLOR}; font-size: 22px; font-weight: 700;">${text}</h2>`;
}

function paragraph(text: string): string {
  return `<p style="margin: 0 0 12px 0; color: ${TEXT_COLOR}; font-size: 15px; line-height: 1.6;">${text}</p>`;
}

function muted(text: string): string {
  return `<p style="margin: 0 0 8px 0; color: ${TEXT_MUTED}; font-size: 13px; line-height: 1.5;">${text}</p>`;
}

function alertBox(text: string, type: "info" | "warning" | "success" = "info"): string {
  const colors = {
    info: { bg: "#fff7d6", border: BRAND_COLOR, text: BRAND_DEEP },
    warning: { bg: "#fef3c7", border: "#fcd34d", text: "#92400e" },
    success: { bg: "#dcfce7", border: "#86efac", text: "#166534" },
  };
  const c = colors[type];
  return `
<div style="background-color: ${c.bg}; border: 1px solid ${c.border}; border-radius: 6px; padding: 12px 16px; margin: 16px 0;">
  <p style="margin: 0; color: ${c.text}; font-size: 14px; font-weight: 600;">${text}</p>
</div>`;
}

// ---- Exported template functions ----

function formatNZDate(date: Date): string {
  return date.toLocaleDateString("en-NZ", { dateStyle: "medium" });
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function welcomeTemplate(firstName: string): string {
  const name = escapeHtml(firstName);
  return layout(`
    ${heading("Welcome, " + name + "!")}
    ${paragraph("Your Tokoroa Alpine Club booking account has been created successfully.")}
    ${paragraph("You can now log in to book stays at the lodge, manage your bookings, and view your upcoming trips.")}
    ${button("Log In to Your Account", BASE_URL + "/login")}
    ${muted("If you did not create this account, please ignore this email.")}
  `);
}

export function passwordResetTemplate(resetUrl: string): string {
  return layout(`
    ${heading("Password Reset")}
    ${paragraph("You requested a password reset for your Tokoroa Alpine Club booking account.")}
    ${paragraph("Click the button below to set a new password. This link expires in <strong>1 hour</strong>.")}
    ${button("Reset Password", resetUrl)}
    ${muted("If you didn't request this, you can safely ignore this email. Your password will remain unchanged.")}
  `);
}

export function adminPasswordResetTemplate(resetUrl: string): string {
  return layout(`
    ${heading("Password Reset")}
    ${paragraph("An administrator has requested a password reset for your Tokoroa Alpine Club booking account.")}
    ${paragraph("Click the button below to set a new password. This link expires in <strong>1 hour</strong>.")}
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
    ${paragraph("An administrator has created your Tokoroa Alpine Club booking account.")}
    ${paragraph(
      "Use the button below to set your password and activate your login. This link expires in <strong>" +
        String(MEMBER_SETUP_INVITE_TTL_DAYS) +
        " days</strong>."
    )}
    ${button("Set Up My Password", resetUrl)}
    ${muted("If you were not expecting this invite, you can safely ignore it or contact the club.")}
  `);
}

export function bookingConfirmedTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  totalCents: number,
  options?: { discountCents?: number; promoCode?: string }
): string {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Check-in", value: formatNZDate(checkIn) },
    { label: "Check-out", value: formatNZDate(checkOut) },
    { label: "Guests", value: String(guestCount) },
  ];

  if (options?.discountCents && options.discountCents > 0) {
    const subtotalCents = totalCents + options.discountCents;
    rows.push({ label: "Subtotal", value: formatCents(subtotalCents) });
    const discountLabel = options.promoCode
      ? `Discount (${escapeHtml(options.promoCode)})`
      : "Discount";
    rows.push({ label: discountLabel, value: `-${formatCents(options.discountCents)}` });
  }

  rows.push({ label: "Total Paid", value: formatCents(totalCents) });

  return layout(`
    ${heading("Booking Confirmed")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your lodge booking has been confirmed!")}
    ${infoTable(rows)}
    ${alertBox("Payment has been processed successfully.", "success")}
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
      { label: "Hold Until", value: formatNZDate(holdUntil) },
    ])}
    ${alertBox("Your booking includes non-member guests and will be held as pending until " + formatNZDate(holdUntil) + ".", "warning")}
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
  refundMethod: "card" | "credit" = "card"
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

  return layout(`
    ${heading("Booking Cancelled")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your lodge booking has been cancelled.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
    ])}
    ${refundInfo}
    ${paragraph("You can make a new booking at any time from your account.")}
    ${button("Make a New Booking", BASE_URL + "/book")}
  `);
}

export function creditAppliedToBookingTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  creditUsedCents: number,
  remainingCreditCents: number
): string {
  return layout(`
    ${heading("Account Credit Applied")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", account credit was applied to your booking.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "Credit applied", value: formatCents(creditUsedCents) },
      { label: "Remaining credit", value: formatCents(remainingCreditCents) },
    ])}
  `);
}

export function emailVerificationTemplate(firstName: string, verifyUrl: string): string {
  const name = escapeHtml(firstName);
  return layout(`
    ${heading("Verify Your Email")}
    ${paragraph("Hi " + name + ", thanks for creating your Tokoroa Alpine Club booking account!")}
    ${paragraph("Please verify your email address by clicking the button below.")}
    ${button("Verify Email", verifyUrl)}
    ${muted("This link expires in 24 hours. If you did not create this account, please ignore this email.")}
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
        "</strong> has listed you as one of their Tokoroa Alpine Club nominators."
    )}
    ${dependentLine}
    ${paragraph("Please review the application and confirm whether you agree to nominate this person for membership.")}
    ${alertBox("You will need to sign in before you can confirm the nomination.", "info")}
    ${button("Review Application", params.reviewUrl)}
    ${muted("This link expires on " + escapeHtml(formatNZDate(params.expiresAt)) + ".")}
  `);
}

export function emailChangeVerificationTemplate(newEmail: string, verifyUrl: string): string {
  return layout(`
    ${heading("Confirm Your New Email")}
    ${paragraph("You requested to change your TAC Bookings email to <strong>" + escapeHtml(newEmail) + "</strong>.")}
    ${paragraph("Click the button below to confirm this change.")}
    ${button("Confirm Email Change", verifyUrl)}
    ${muted("This link expires in 1 hour. If you did not request this change, please ignore this email.")}
  `);
}

export function emailChangeNotificationTemplate(newEmail: string): string {
  return layout(`
    ${heading("Email Change Requested")}
    ${paragraph("Someone requested to change the email address on your TAC Bookings account to <strong>" + escapeHtml(newEmail) + "</strong>.")}
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
  return layout(`
    ${heading("Hut Leader Assignment")}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ", thanks for taking on hut leader duties for the lodge.")}
    ${infoTable([
      { label: "Start date", value: formatNZDate(params.startDate) },
      { label: "End date", value: formatNZDate(params.endDate) },
      { label: "Kiosk PIN", value: `<strong style="font-size: 18px; letter-spacing: 2px;">${escapeHtml(params.pin)}</strong>` },
    ])}
    ${paragraph("When you arrive, open the lodge kiosk and use this PIN to unlock hut leader controls for arrivals, departures, and roster management.")}
    ${alertBox("Please keep this PIN private and share it only with the assigned hut leader team for these dates.", "warning")}
    ${paragraph("Responsibilities include checking the lodge list, helping guests settle in, marking arrivals and departures, and making sure the daily chore roster is set up and completed.")}
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
  const guestListHtml = guests
    .map((g) => `<li style="padding: 4px 0; color: ${TEXT_COLOR}; font-size: 14px;">${escapeHtml(g.firstName)} ${escapeHtml(g.lastName)}</li>`)
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
    ${paragraph("The lodge is located at Mt Pureora, Tokoroa. Please allow adequate travel time.")}
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
}): string {
  return layout(`
    ${heading("New Booking Created")}
    ${paragraph("A new booking has been created.")}
    ${data.reviewReason ? alertBox(escapeHtml(data.reviewReason), "warning") : ""}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Total", value: formatCents(data.totalCents) },
      { label: "Status", value: escapeHtml(data.status) },
    ])}
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
  const tableRowsHtml = bookings
    .map(
      (b) => `
    <tr>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${TEXT_COLOR};">${escapeHtml(b.memberName)}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${TEXT_COLOR};">${formatNZDate(b.checkIn)} – ${formatNZDate(b.checkOut)}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${TEXT_COLOR};">${b.guestCount}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${TEXT_COLOR};">${formatNZDate(b.deadline)}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${b.hoursRemaining <= 24 ? "#dc2626" : TEXT_COLOR}; font-weight: ${b.hoursRemaining <= 24 ? "700" : "400"};">${Math.round(b.hoursRemaining)}h</td>
    </tr>`
    )
    .join("");

  return layout(`
    ${heading("Pending Bookings Approaching Deadline")}
    ${alertBox(bookings.length + " pending booking" + (bookings.length > 1 ? "s" : "") + " will reach their hold deadline within 48 hours.", "warning")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${BORDER_COLOR}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Member</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Dates</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Guests</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Deadline</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Remaining</th>
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
      { label: "Timestamp", value: data.timestamp.toLocaleString("en-NZ", { timeZone: "Pacific/Auckland" }) },
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
      value: data.timestamp.toLocaleString("en-NZ", { timeZone: "Pacific/Auckland" }),
    },
  ];

  const links: string[] = [];
  if (data.localUrl) {
    links.push(`<a href="${escapeHtml(BASE_URL + data.localUrl)}" style="color: ${BRAND_COLOR}; text-decoration: underline;">Open local record</a>`);
  }
  if (data.xeroObjectUrl) {
    links.push(`<a href="${escapeHtml(data.xeroObjectUrl)}" style="color: ${BRAND_COLOR}; text-decoration: underline;">Open Xero object</a>`);
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
}>): string {
  const tableRowsHtml = days
    .map((d) => {
      const pct = Math.round((d.occupiedBeds / LODGE_CAPACITY) * 100);
      const color = d.availableBeds <= 2 ? "#dc2626" : d.availableBeds <= 5 ? "#d97706" : TEXT_COLOR;
      return `
    <tr>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${TEXT_COLOR};">${formatNZDate(d.date)}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${TEXT_COLOR};">${d.occupiedBeds}/${LODGE_CAPACITY}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${color}; font-weight: 700;">${d.availableBeds}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${color}; font-weight: 700;">${pct}%</td>
    </tr>`;
    })
    .join("");

  return layout(`
    ${heading("Capacity Warning")}
    ${alertBox(days.length + " day" + (days.length > 1 ? "s" : "") + " in the next 14 days have high occupancy.", "warning")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${BORDER_COLOR}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Date</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Occupied</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Available</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Occupancy</th>
      </tr>
      ${tableRowsHtml}
    </table>
    ${button("View Bookings", BASE_URL + "/admin/bookings")}
  `);
}

// ---- N-13: Admin Daily Digest ----

// ---- N-12: Post-Stay Feedback Request ----

export function postStayFeedbackTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date
): string {
  return layout(`
    ${heading("How Was Your Stay?")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", we hope you enjoyed your time at the TAC Lodge!")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
    ])}
    ${paragraph("We'd love to hear your feedback. Your input helps us improve the lodge experience for all members.")}
    ${button("Share Your Feedback", BASE_URL + "/feedback")}
    ${muted("Thank you for staying with us at the Tokoroa Alpine Club Lodge.")}
  `);
}

// ---- N-09: Bulk Member Communication ----

export function bulkCommunicationTemplate(
  subject: string,
  body: string
): string {
  return layout(`
    ${heading(escapeHtml(subject))}
    <div style="color: ${TEXT_COLOR}; font-size: 15px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(body)}</div>
    ${muted("This email was sent to you by the Tokoroa Alpine Club administration. You can update your email preferences in your account settings.")}
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
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${TEXT_COLOR};">${r.label}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${TEXT_COLOR}; font-weight: 700;">${r.value}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${BORDER_COLOR};"><a href="${BASE_URL}${r.link}" style="color: ${BRAND_COLOR}; text-decoration: none;">View</a></td>
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
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${BORDER_COLOR}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Alert Type</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Count</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Action</th>
      </tr>
      ${tableRowsHtml}
    </table>` : ""}
    ${paragraph("<strong>Total alerts:</strong> " + sections.totalAlerts)}
    ${button("Open Admin Dashboard", BASE_URL + "/admin/dashboard")}
  `);
}

export function adminXeroReconciliationReportTemplate(report: {
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
    issueCategoryCount: number;
    issueTotalCount: number;
  };
  repeatedFailures: Array<{
    correlationKey: string;
    failureCount: number;
    entityType: string;
    operationType: string;
    localModel: string | null;
    localId: string | null;
    localUrl: string | null;
    latestErrorMessage: string | null;
  }>;
  unsupportedPartials: Array<{
    operationId: string;
    entityType: string;
    operationType: string;
    localModel: string | null;
    localId: string | null;
    localUrl: string | null;
    reason: string;
    createdAt: Date;
  }>;
}): string {
  const summaryRows = [
    { label: "Generated", value: report.generatedAt.toLocaleString("en-NZ", { timeZone: "Pacific/Auckland" }) },
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
  ];

  const repeatedFailureRows = report.repeatedFailures
    .map((failure) => `
      <tr>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${TEXT_COLOR};">${escapeHtml(failure.correlationKey)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${TEXT_COLOR};">${failure.failureCount}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${TEXT_COLOR};">${escapeHtml(failure.entityType)} ${escapeHtml(failure.operationType)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${TEXT_COLOR};">${
          failure.localModel && failure.localId
            ? escapeHtml(`${failure.localModel} ${failure.localId}`)
            : "Unavailable"
        }</td>
      </tr>`)
    .join("");

  const unsupportedPartialRows = report.unsupportedPartials
    .map((partial) => `
      <tr>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${TEXT_COLOR};">${escapeHtml(partial.operationId)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${TEXT_COLOR};">${escapeHtml(partial.entityType)} ${escapeHtml(partial.operationType)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${TEXT_COLOR};">${
          partial.localModel && partial.localId
            ? escapeHtml(`${partial.localModel} ${partial.localId}`)
            : "Unavailable"
        }</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${BORDER_COLOR}; color: ${TEXT_COLOR};">${escapeHtml(partial.reason)}</td>
      </tr>`)
    .join("");

  return layout(`
    ${heading("Xero Reconciliation Report")}
    ${
      report.summary.issueCategoryCount === 0
        ? alertBox("No open reconciliation gaps were detected in this report window.", "success")
        : alertBox("Reconciliation gaps were detected and should be reviewed.", "warning")
    }
    ${infoTable(summaryRows)}
    ${infoTable(categoryRows)}
    ${
      report.repeatedFailures.length > 0
        ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${BORDER_COLOR}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Correlation Key</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Failures</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Operation</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Local Record</th>
      </tr>
      ${repeatedFailureRows}
    </table>`
        : paragraph("No repeated-failure correlations met the alert threshold in this window.")
    }
    ${
      report.unsupportedPartials.length > 0
        ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${BORDER_COLOR}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Operation ID</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Operation</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Local Record</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${BRAND_LIGHT}; color: ${BRAND_COLOR}; border-bottom: 2px solid ${BORDER_COLOR};">Repair Gap</th>
      </tr>
      ${unsupportedPartialRows}
    </table>`
        : paragraph("No unsupported partial-operation repair gaps were detected in this window.")
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
  additionalAmountCents: number;
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
    additionalAmountCents,
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
  } else if (additionalAmountCents > 0) {
    paymentNote = alertBox(
      `An additional payment of ${formatCents(additionalAmountCents)} is required.`,
      "warning"
    );
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
    ${muted("Tokoroa Alpine Club — support@tokoroa.org.nz")}
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
    ${muted("Tokoroa Alpine Club — support@tokoroa.org.nz")}
  `);
}

/** Sent to parent when their child/youth request is submitted (confirmation) */
export function childRequestSubmittedTemplate(
  parentName: string,
  childName: string,
  groupName: string
): string {
  return layout(`
    ${heading("Child/Youth Request Submitted")}
    ${paragraph("Hi " + escapeHtml(parentName) + ",")}
    ${paragraph("Your request to add <strong>" + escapeHtml(childName) + "</strong> to the family group <strong>" + escapeHtml(groupName) + "</strong> has been submitted.")}
    ${alertBox("An administrator will review your request and link the member to your family group. You'll be notified once it's been processed.", "info")}
    ${muted("Tokoroa Alpine Club — support@tokoroa.org.nz")}
  `);
}

/** Sent to parent when their child/youth request is approved by admin */
export function childRequestApprovedTemplate(
  parentName: string,
  childName: string,
  groupName: string
): string {
  return layout(`
    ${heading("Child/Youth Added to Family Group")}
    ${paragraph("Hi " + escapeHtml(parentName) + ",")}
    ${paragraph("<strong>" + escapeHtml(childName) + "</strong> has been added to your family group <strong>" + escapeHtml(groupName) + "</strong>.")}
    ${alertBox("You can now include them when making bookings.", "success")}
    ${muted("Tokoroa Alpine Club — support@tokoroa.org.nz")}
  `);
}

/** Sent to parent when their child/youth request is rejected by admin */
export function childRequestRejectedTemplate(
  parentName: string,
  childName: string,
  reason?: string
): string {
  const reasonHtml = reason
    ? `${alertBox("Admin note: " + escapeHtml(reason), "warning")}`
    : "";
  return layout(`
    ${heading("Child/Youth Request Update")}
    ${paragraph("Hi " + escapeHtml(parentName) + ",")}
    ${paragraph("Your request to add <strong>" + escapeHtml(childName) + "</strong> to your family group was not approved.")}
    ${reasonHtml}
    ${paragraph("If you have questions, please contact the club.")}
    ${muted("Tokoroa Alpine Club — support@tokoroa.org.nz")}
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
    ${paragraph(escapeHtml(data.details))}
    ${button("Review Requests", (process.env.NEXTAUTH_URL || "http://localhost:3000") + "/admin/family-groups")}
    ${muted("Tokoroa Alpine Club — support@tokoroa.org.nz")}
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
    ${muted("Tokoroa Alpine Club — support@tokoroa.org.nz")}
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
    ${muted("Tokoroa Alpine Club — support@tokoroa.org.nz")}
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
    ${paragraph("Hi " + escapeHtml(firstName) + ", your Tokoroa Alpine Club membership application has been approved.")}
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
    ${paragraph("Hi " + escapeHtml(firstName) + ", your Tokoroa Alpine Club membership application has been reviewed.")}
    ${paragraph("The committee has decided not to approve the application at this time.")}
    ${notes}
    ${paragraph("If you would like more information, please contact the club directly.")}
    ${muted("Tokoroa Alpine Club — support@tokoroa.org.nz")}
  `);
}

/** Age-up invitation — sent when a youth/child turns 18 and gets their own login */
export function ageUpInvitationTemplate(firstName: string, resetUrl: string): string {
  const name = escapeHtml(firstName);
  return layout(`
    ${heading("Welcome to Your Own Account, " + name + "!")}
    ${paragraph("Congratulations — you've turned 18! As an adult member of the Tokoroa Alpine Club, you can now log in and book stays at the lodge yourself.")}
    ${paragraph(
      "Click the button below to set up your password and activate your account. This link expires in <strong>" +
        String(MEMBER_SETUP_INVITE_TTL_DAYS) +
        " days</strong>."
    )}
    ${button("Set Up My Password", resetUrl)}
    ${alertBox("Once you set your password, you can log in at any time to book stays, view your bookings, and manage your profile.", "info")}
    ${muted("If you have any questions, contact the club at support@tokoroa.org.nz.")}
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
    ${muted("Tokoroa Alpine Club — support@tokoroa.org.nz")}
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
  bookingId: string
): string {
  return layout(`
    ${heading("A Spot Has Opened Up!")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", great news — a spot has become available for your waitlisted booking.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "Guests", value: String(guestCount) },
    ])}
    ${alertBox("This offer expires on " + expiresAt.toLocaleString("en-NZ", { dateStyle: "medium", timeStyle: "short", timeZone: "Pacific/Auckland" }) + ". If you don't confirm in time, the spot will be offered to the next person in line.", "warning")}
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
    ${muted("If you need help, contact the club at support@tokoroa.org.nz")}
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

export function adminIssueReportTemplate(data: {
  memberName: string;
  memberEmail: string;
  pageUrl: string;
  pageTitle?: string | null;
  description: string;
  hasScreenshot: boolean;
}): string {
  return layout(`
    ${heading("Issue Report Submitted")}
    ${paragraph(escapeHtml(data.memberName) + " has reported an issue from the bookings site.")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Email", value: escapeHtml(data.memberEmail) },
      { label: "Page", value: escapeHtml(data.pageTitle || data.pageUrl) },
      { label: "Screenshot", value: data.hasScreenshot ? "Attached" : "Not included" },
    ])}
    ${alertBox(escapeHtml(data.description), "info")}
    ${button("Open Reported Page", data.pageUrl)}
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
          "Your refund appeal for your booking (" + formatNZDate(data.checkIn) + " - " + formatNZDate(data.checkOut) + ") has been approved. A refund of $" + ((data.amountCents ?? 0) / 100).toFixed(2) + " will be processed to your original payment method.",
          "success"
        )
      : alertBox(
          "Your refund appeal for your booking (" + formatNZDate(data.checkIn) + " - " + formatNZDate(data.checkOut) + ") was not approved at this time.",
          "warning"
        )
    }
    ${data.adminNotes ? paragraph("<strong>Notes:</strong> " + escapeHtml(data.adminNotes)) : ""}
    ${muted("If you have questions, contact the club at support@tokoroa.org.nz")}
  `);
}
