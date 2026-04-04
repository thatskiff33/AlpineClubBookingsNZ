/**
 * HTML email templates for TAC Bookings.
 * All templates use inline CSS for maximum email client compatibility.
 */

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

const BRAND_COLOR = "#1e40af"; // Blue-800
const BRAND_LIGHT = "#dbeafe"; // Blue-100
const TEXT_COLOR = "#1f2937"; // Gray-800
const TEXT_MUTED = "#6b7280"; // Gray-500
const BG_COLOR = "#f9fafb"; // Gray-50
const WHITE = "#ffffff";
const BORDER_COLOR = "#e5e7eb"; // Gray-200

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
            <td style="background-color: ${BRAND_COLOR}; padding: 24px 32px; border-radius: 8px 8px 0 0; text-align: center;">
              <h1 style="margin: 0; color: ${WHITE}; font-size: 20px; font-weight: 700; letter-spacing: 0.5px;">
                &#9968; Tokoroa Alpine Club
              </h1>
              <p style="margin: 4px 0 0 0; color: ${BRAND_LIGHT}; font-size: 13px;">
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
                <a href="${BASE_URL}" style="color: ${BRAND_COLOR}; text-decoration: none;">${BASE_URL.replace(/^https?:\/\//, "")}</a>
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
      <a href="${url}" target="_blank" style="display: inline-block; padding: 12px 28px; color: ${WHITE}; text-decoration: none; font-weight: 600; font-size: 14px;">
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
    info: { bg: "#dbeafe", border: "#93c5fd", text: "#1e40af" },
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
    ${alertBox("Your booking includes non-member guests and will be held as pending until " + formatNZDate(holdUntil) + " (7 days before check-in).", "warning")}
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
  refundCents: number
): string {
  const refundInfo =
    refundCents > 0
      ? alertBox("A refund of " + formatCents(refundCents) + " has been processed to your original payment method.", "success")
      : alertBox("No refund was applicable based on the cancellation policy.", "info");

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

export function choreRosterTemplate(
  guestName: string,
  date: string,
  chores: Array<{ name: string; description: string | null }>
): string {
  const formattedDate = new Date(date + "T00:00:00").toLocaleDateString(
    "en-NZ",
    { weekday: "long", year: "numeric", month: "long", day: "numeric" }
  );

  const choreRows = chores.map((c) => ({
    label: escapeHtml(c.name),
    value: c.description ? escapeHtml(c.description) : "",
  }));

  return layout(`
    ${heading("Chore Roster")}
    ${paragraph("Hi " + escapeHtml(guestName) + ",")}
    ${paragraph("Here are your assigned chores for <strong>" + escapeHtml(formattedDate) + "</strong> at the lodge:")}
    ${infoTable(choreRows)}
    ${alertBox("Last person to bed: Check heaters and fire are safe and doors are secure.", "warning")}
    ${muted("Thanks for helping keep the lodge running smoothly!")}
  `);
}
