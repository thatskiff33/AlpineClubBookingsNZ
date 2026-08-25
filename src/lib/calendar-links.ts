/**
 * Add-to-calendar links for a booking's stay (fork issue #35).
 *
 * A lodge stay is an NZ date-only night range (INV-DATE-001), so every link
 * here describes an ALL-DAY calendar event — `VALUE=DATE` in the .ics,
 * `YYYYMMDD/YYYYMMDD` in the Google URL, `allday=true` in the Outlook URL —
 * never a datetime, which would re-import the host-timezone ambiguity the
 * Club Time work removes. The event spans check-in through the checkout day
 * inclusive (the guest is at the lodge until the midday-NZ stay boundary), and
 * every all-day end below is EXCLUSIVE per its format, so each end date is
 * checkout + 1 day.
 *
 * The .ics download URL must work from an email with no signed-in session, so
 * it carries an HMAC under the app auth secret — the same sessionless-
 * credential pattern as lodge-display pairing, including that pattern's
 * signed expiry: the `exp` epoch-seconds value is part of the signed message,
 * so it cannot be extended by tampering, and a forwarded confirmation stops
 * resolving the booking once the link ages out. The token grants exactly one
 * thing while it lives: reading one booking's stay dates and lodge name as a
 * calendar file.
 *
 * The booking id is the LAST field of the signed message on purpose: no
 * crafted id or expiry can re-partition the string, so a token minted for one
 * booking can never verify for another.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { getAppBaseUrl, sanitizeEmailHref } from "@/lib/app-url";
import { escapeHtml } from "@/lib/email-templates/escape";
import { emailPalette } from "@/lib/email-theme";
import {
  addDaysDateOnly,
  formatDateOnly,
  formatDateOnlyForTimeZone,
} from "@/lib/date-only";
import { getAuthSecret } from "@/lib/runtime-config";

export interface BookingCalendarStay {
  bookingId: string;
  /** Date-only values (UTC-midnight instants from a `@db.Date` column). */
  checkIn: Date;
  checkOut: Date;
}

export interface BookingCalendarLinks {
  icsUrl: string;
  googleUrl: string;
  outlookUrl: string;
}

/**
 * How long past CHECKOUT the .ics download link stays valid. Long enough to
 * re-download after a post-stay date correction; short enough that a forwarded
 * or logged confirmation email does not read the booking forever.
 */
const DOWNLOAD_LINK_LIFETIME_AFTER_CHECKOUT_DAYS = 60;

function calendarSecret(): string {
  const secret = getAuthSecret();
  if (!secret) {
    throw new Error(
      "AUTH_SECRET or NEXTAUTH_SECRET is required for booking calendar links",
    );
  }
  return secret;
}

/** Epoch-seconds expiry minted for a stay's download link. */
export function bookingCalendarLinkExpiry(stay: BookingCalendarStay): number {
  const expiresAt = addDaysDateOnly(
    stay.checkOut,
    DOWNLOAD_LINK_LIFETIME_AFTER_CHECKOUT_DAYS,
  );
  return Math.floor(expiresAt.getTime() / 1000);
}

export function bookingCalendarToken(
  bookingId: string,
  expiresAtSeconds: number,
): string {
  return createHmac("sha256", calendarSecret())
    .update(`booking-calendar:${expiresAtSeconds}:${bookingId}`)
    .digest("base64url");
}

export function verifyBookingCalendarToken(params: {
  bookingId: string;
  expiresAtSeconds: number;
  token: string;
  /** The verification instant; callers pass `new Date()`. */
  now: Date;
}): boolean {
  if (
    !Number.isInteger(params.expiresAtSeconds) ||
    params.now.getTime() >= params.expiresAtSeconds * 1000
  ) {
    return false;
  }
  const expected = Buffer.from(
    bookingCalendarToken(params.bookingId, params.expiresAtSeconds),
  );
  const provided = Buffer.from(params.token);
  return (
    expected.length === provided.length && timingSafeEqual(expected, provided)
  );
}

/** `yyyy-MM-dd` → `yyyyMMdd` (the iCal / Google compact date form). */
function compactDate(dateOnly: string): string {
  return dateOnly.replaceAll("-", "");
}

interface StayDates {
  /** Check-in day, `yyyy-MM-dd`. */
  startIso: string;
  /** Day AFTER checkout (all-day ends are exclusive), `yyyy-MM-dd`. */
  endExclusiveIso: string;
}

function stayDates(checkIn: Date, checkOut: Date): StayDates {
  return {
    startIso: formatDateOnly(checkIn),
    endExclusiveIso: formatDateOnly(addDaysDateOnly(checkOut, 1)),
  };
}

/**
 * RFC 5545 TEXT escaping: backslash, semicolon, comma, and line breaks in any
 * form — CRLF, bare LF, or bare CR — become the literal `\n` sequence.
 */
function escapeIcsText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll(/\r\n|[\r\n]/g, "\\n");
}

/**
 * RFC 5545 content lines fold at 75 OCTETS, so the budget is counted in UTF-8
 * bytes, not string length — a macron-bearing Māori lodge name costs two bytes
 * per macron and must fold EARLIER than its character count suggests, not
 * later. Iterating code points (not code units) means a fold can never split
 * a surrogate pair into two lone halves.
 */
function foldIcsLine(line: string): string {
  const parts: string[] = [];
  let current = "";
  let currentOctets = 0;
  for (const char of line) {
    const charOctets = Buffer.byteLength(char, "utf8");
    if (currentOctets + charOctets > 74 && current) {
      parts.push(current);
      current = char;
      currentOctets = charOctets;
    } else {
      current += char;
      currentOctets += charOctets;
    }
  }
  if (current) parts.push(current);
  return parts.join("\r\n ");
}

// DTSTAMP is a real UTC instant (RFC 5545 basic form). The calendar-day half
// goes through the canonical instant encoder pinned to UTC (INV-DATE-019 bans
// hand-assembled date keys in any spelling); the clock-face half is plain UTC
// time getters, which no date census restricts.
function icsTimestamp(instant: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const utcDay = compactDate(formatDateOnlyForTimeZone(instant, "UTC"));
  return `${utcDay}T${pad(instant.getUTCHours())}${pad(instant.getUTCMinutes())}${pad(instant.getUTCSeconds())}Z`;
}

/**
 * The .ics document for one stay. The UID is stable per booking and SEQUENCE
 * rises with every booking update (it is the epoch-seconds of `updatedAt`),
 * which together are what make a re-download after a date change UPDATE the
 * existing event in the recipient's calendar instead of duplicating it or
 * being ignored as a same-revision duplicate (RFC 5545 §3.8.7.4).
 */
export function buildBookingIcs(input: {
  stay: BookingCalendarStay;
  lodgeName: string;
  /** Monotonic per-booking revision; pass epoch-seconds of `updatedAt`. */
  sequence: number;
  /** DTSTAMP instant; callers pass `new Date()` at generation time. */
  generatedAt: Date;
}): string {
  const { startIso, endExclusiveIso } = stayDates(
    input.stay.checkIn,
    input.stay.checkOut,
  );
  const host = new URL(getAppBaseUrl()).hostname;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AlpineClubBookingsNZ//Booking Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:booking-${input.stay.bookingId}@${host}`,
    `SEQUENCE:${Math.max(0, Math.floor(input.sequence))}`,
    `DTSTAMP:${icsTimestamp(input.generatedAt)}`,
    `DTSTART;VALUE=DATE:${compactDate(startIso)}`,
    `DTEND;VALUE=DATE:${compactDate(endExclusiveIso)}`,
    `SUMMARY:${escapeIcsText(`${input.lodgeName} stay`)}`,
    `LOCATION:${escapeIcsText(input.lodgeName)}`,
    `DESCRIPTION:${escapeIcsText(
      `Lodge booking from ${startIso} to checkout. Manage your booking: ${getAppBaseUrl()}/bookings`,
    )}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

// The web-calendar URLs carry ONLY the title and the dates — no location or
// details params. The .ics file is the rich form; here every extra param
// lengthens a URL that admin override bodies render as unbreakable plain text
// in a fixed-width email table (the flat {{ical}} block), so the short form
// is the one that renders acceptably everywhere.
export function googleCalendarUrl(input: {
  stay: BookingCalendarStay;
  lodgeName: string;
}): string {
  const { startIso, endExclusiveIso } = stayDates(
    input.stay.checkIn,
    input.stay.checkOut,
  );
  const url = new URL("https://calendar.google.com/calendar/render");
  url.searchParams.set("action", "TEMPLATE");
  url.searchParams.set("text", `${input.lodgeName} stay`);
  url.searchParams.set(
    "dates",
    `${compactDate(startIso)}/${compactDate(endExclusiveIso)}`,
  );
  return url.toString();
}

export function outlookCalendarUrl(input: {
  stay: BookingCalendarStay;
  lodgeName: string;
}): string {
  const { startIso, endExclusiveIso } = stayDates(
    input.stay.checkIn,
    input.stay.checkOut,
  );
  const url = new URL("https://outlook.live.com/calendar/0/deeplink/compose");
  url.searchParams.set("path", "/calendar/action/compose");
  url.searchParams.set("rru", "addevent");
  url.searchParams.set("allday", "true");
  url.searchParams.set("subject", `${input.lodgeName} stay`);
  url.searchParams.set("startdt", startIso);
  url.searchParams.set("enddt", endExclusiveIso);
  return url.toString();
}

export function bookingIcsDownloadUrl(stay: BookingCalendarStay): string {
  const expiresAtSeconds = bookingCalendarLinkExpiry(stay);
  const token = bookingCalendarToken(stay.bookingId, expiresAtSeconds);
  // /api/booking-calendar, NOT /api/calendar — that prefix is module-gated
  // behind the eventsCalendar flag, and this link belongs to bookings.
  return `${getAppBaseUrl()}/api/booking-calendar/${stay.bookingId}?token=${token}&exp=${expiresAtSeconds}`;
}

export function bookingCalendarLinks(input: {
  stay: BookingCalendarStay;
  lodgeName: string;
}): BookingCalendarLinks {
  return {
    icsUrl: bookingIcsDownloadUrl(input.stay),
    googleUrl: googleCalendarUrl(input),
    outlookUrl: outlookCalendarUrl(input),
  };
}

/**
 * The pre-composed `{{ical}}` block for the booking-confirmed body: complete
 * lines the admin body editor can place but not reformat, per the
 * email-messages guide's block-token convention. The lead-in line carries no
 * trailing colon — the clean-body guards read a colon-terminated line as a
 * dangling label. The sender renders the token EMPTY when link building fails
 * or when the recipient's booking-link authority denies placing the booking
 * id in outbound mail (the same decision that governs `{{bookingUrl}}`),
 * which is why `ical` is declared in OPTIONAL_TEMPLATE_TOKENS.
 */
/**
 * The icon row `{{ical}}` renders EVERYWHERE — the built-in template and,
 * via the renderer's sentinel swap (fork #43), admin override bodies too.
 * Icons first (owner direction, 26 Aug 2026); the service names appear only
 * when a mail client blocks images, through each icon's alt text; the raw
 * URLs are never member-visible. Icons are self-hosted originals under
 * /branding/calendar (the email logo pattern — no third-party image hosts).
 * The Google/Outlook targets are cross-origin by nature, so the href
 * sanitiser runs without a same-origin restriction. "Outlook.com", not
 * "Outlook": the deeplink serves personal Microsoft accounts only, and the
 * name must not promise a Microsoft 365 work/school reader a link that
 * lands them on a consumer sign-in.
 */
export function bookingAddToCalendarHtmlRow(
  links: BookingCalendarLinks,
): string {
  const p = emailPalette();
  const iconLink = (alt: string, icon: string, url: string) =>
    `<a href="${escapeHtml(sanitizeEmailHref(url))}" target="_blank" title="${escapeHtml(alt)}" style="display: inline-block; margin: 0 10px 0 0; text-decoration: none;"><img src="${getAppBaseUrl()}/branding/calendar/${icon}" alt="${escapeHtml(alt)}" width="28" height="28" style="display: inline-block; width: 28px; height: 28px; vertical-align: middle; border: 0;"></a>`;
  return `<span style="display: inline-block; margin-right: 10px; color: ${p.deep};">Add this stay to your calendar:</span>${iconLink("Calendar file", "ics.png", links.icsUrl)}${iconLink("Google Calendar", "google-calendar.png", links.googleUrl)}${iconLink("Outlook.com", "outlook.png", links.outlookUrl)}`;
}

export function bookingAddToCalendarBlock(links: BookingCalendarLinks): string {
  return [
    "Add this stay to your calendar",
    `Calendar file (.ics): ${links.icsUrl}`,
    `Google Calendar: ${links.googleUrl}`,
    // "Outlook.com", not "Outlook": the deeplink serves personal Microsoft
    // accounts only — a work/school (Microsoft 365) reader lands on a
    // consumer sign-in, so the label must not promise them a working link.
    `Outlook.com: ${links.outlookUrl}`,
  ].join("\n");
}
