import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  bookingAddToCalendarBlock,
  bookingCalendarLinkExpiry,
  bookingCalendarLinks,
  bookingCalendarToken,
  bookingIcsDownloadUrl,
  buildBookingIcs,
  googleCalendarUrl,
  outlookCalendarUrl,
  verifyBookingCalendarToken,
} from "@/lib/calendar-links";
import { parseDateOnly } from "@/lib/date-only";
import { sampleValue } from "@/lib/email-message-registry";

/**
 * The add-to-calendar links for a booking's stay (fork issue #35).
 *
 * A stay is an NZ date-only night range (INV-DATE-001), so the one invariant
 * every format must hold is ALL-DAY dates with an EXCLUSIVE end of
 * checkout + 1 day — an event that spans check-in through the checkout day
 * and never mentions a time or a zone. The download token carries its expiry
 * INSIDE the signed message (review F2), so it cannot be extended by
 * tampering.
 */

// The stay used throughout: 3 nights, 1–4 Aug 2026 (future under the frozen
// test clock, 2026-07-01). All-day exclusive end = 5 Aug.
const STAY = {
  bookingId: "bkg_test123",
  checkIn: parseDateOnly("2026-08-01"),
  checkOut: parseDateOnly("2026-08-04"),
};
const LODGE = "Example Lodge";
// A future expiry relative to the frozen clock.
const FUTURE_EXP = Math.floor(parseDateOnly("2026-10-01").getTime() / 1000);

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "calendar-test-secret");
  vi.stubEnv("NEXTAUTH_URL", "https://bookings.example.org");
});

describe("bookingCalendarToken", () => {
  it("verifies its own token before expiry and is stable per (booking, exp)", () => {
    const token = bookingCalendarToken(STAY.bookingId, FUTURE_EXP);
    expect(token).toBe(bookingCalendarToken(STAY.bookingId, FUTURE_EXP));
    expect(
      verifyBookingCalendarToken({
        bookingId: STAY.bookingId,
        expiresAtSeconds: FUTURE_EXP,
        token,
        now: new Date(),
      }),
    ).toBe(true);
  });

  it("rejects a wrong-booking token, a truncated token, and garbage", () => {
    const token = bookingCalendarToken(STAY.bookingId, FUTURE_EXP);
    const verify = (bookingId: string, candidate: string) =>
      verifyBookingCalendarToken({
        bookingId,
        expiresAtSeconds: FUTURE_EXP,
        token: candidate,
        now: new Date(),
      });
    expect(verify("bkg_other", token)).toBe(false);
    expect(verify(STAY.bookingId, token.slice(0, -1))).toBe(false);
    expect(verify(STAY.bookingId, "not-a-token")).toBe(false);
  });

  it("rejects an expired token and a tampered expiry", () => {
    const pastExp = Math.floor(parseDateOnly("2026-06-01").getTime() / 1000);
    const expiredToken = bookingCalendarToken(STAY.bookingId, pastExp);
    expect(
      verifyBookingCalendarToken({
        bookingId: STAY.bookingId,
        expiresAtSeconds: pastExp,
        token: expiredToken,
        now: new Date(),
      }),
    ).toBe(false);
    // A token signed for the past expiry cannot be replayed with a future one.
    expect(
      verifyBookingCalendarToken({
        bookingId: STAY.bookingId,
        expiresAtSeconds: FUTURE_EXP,
        token: expiredToken,
        now: new Date(),
      }),
    ).toBe(false);
    // A non-integer expiry never verifies.
    expect(
      verifyBookingCalendarToken({
        bookingId: STAY.bookingId,
        expiresAtSeconds: Number.NaN,
        token: expiredToken,
        now: new Date(),
      }),
    ).toBe(false);
  });

  it("changes when the secret changes, so a token cannot outlive a rotated secret", () => {
    const token = bookingCalendarToken(STAY.bookingId, FUTURE_EXP);
    vi.stubEnv("AUTH_SECRET", "rotated-secret");
    expect(
      verifyBookingCalendarToken({
        bookingId: STAY.bookingId,
        expiresAtSeconds: FUTURE_EXP,
        token,
        now: new Date(),
      }),
    ).toBe(false);
  });

  it("throws without an auth secret rather than signing with nothing", () => {
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("NEXTAUTH_SECRET", "");
    expect(() => bookingCalendarToken(STAY.bookingId, FUTURE_EXP)).toThrow(
      /AUTH_SECRET/,
    );
  });
});

describe("buildBookingIcs", () => {
  it("renders an all-day VEVENT spanning check-in through the checkout day (exclusive end)", () => {
    const ics = buildBookingIcs({
      stay: STAY,
      lodgeName: LODGE,
      sequence: 1754006400,
      generatedAt: new Date(),
    });
    // The frozen test clock makes DTSTAMP deterministic.
    expect(ics).toBe(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//AlpineClubBookingsNZ//Booking Calendar//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        "UID:booking-bkg_test123@bookings.example.org",
        "SEQUENCE:1754006400",
        "DTSTAMP:20260701T000000Z",
        "DTSTART;VALUE=DATE:20260801",
        "DTEND;VALUE=DATE:20260805",
        "SUMMARY:Example Lodge stay",
        "LOCATION:Example Lodge",
        "DESCRIPTION:Lodge booking from 2026-08-01 to checkout. Manage your booking",
        " : https://bookings.example.org/bookings",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
  });

  it("escapes RFC 5545 TEXT characters, including a bare carriage return", () => {
    const ics = buildBookingIcs({
      stay: STAY,
      lodgeName: "Ruapehu; North, Lodge\rAnnex",
      sequence: 0,
      generatedAt: new Date(),
    });
    expect(ics).toContain("SUMMARY:Ruapehu\\; North\\, Lodge\\nAnnex stay");
  });

  it("folds by UTF-8 octets, so no content line exceeds 75 bytes and no surrogate pair splits", () => {
    const macronName = "Whakapapa Kāinga Māhau Tūroa Pōkai Rāhui Wānaka 🏔️ Alpine Heritage Lodge";
    const ics = buildBookingIcs({
      stay: STAY,
      lodgeName: macronName,
      sequence: 0,
      generatedAt: new Date(),
    });
    for (const line of ics.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
      // A split surrogate would have been replaced by U+FFFD on encode.
      expect(line).not.toContain("�");
    }
  });

  it("keeps a stable UID and a rising SEQUENCE across booking updates, so re-imports replace rather than duplicate or no-op", () => {
    const first = buildBookingIcs({
      stay: STAY,
      lodgeName: LODGE,
      sequence: 100,
      generatedAt: new Date(),
    });
    const second = buildBookingIcs({
      stay: { ...STAY, checkOut: parseDateOnly("2026-08-06") },
      lodgeName: LODGE,
      sequence: 200,
      generatedAt: new Date(),
    });
    const lineOf = (ics: string, prefix: string) =>
      ics.split("\r\n").find((line) => line.startsWith(prefix));
    expect(lineOf(first, "UID:")).toBe(lineOf(second, "UID:"));
    expect(lineOf(first, "SEQUENCE:")).toBe("SEQUENCE:100");
    expect(lineOf(second, "SEQUENCE:")).toBe("SEQUENCE:200");
  });
});

describe("web calendar URLs", () => {
  it("Google uses compact all-day dates with the exclusive end, and no extra params (they bloat the flat block's URL lines)", () => {
    const url = new URL(googleCalendarUrl({ stay: STAY, lodgeName: LODGE }));
    expect(url.origin + url.pathname).toBe(
      "https://calendar.google.com/calendar/render",
    );
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("dates")).toBe("20260801/20260805");
    expect(url.searchParams.get("text")).toBe("Example Lodge stay");
    expect(url.searchParams.has("location")).toBe(false);
    expect(url.searchParams.has("details")).toBe(false);
  });

  it("Outlook uses allday=true with ISO dates and the exclusive end, and no extra params", () => {
    const url = new URL(outlookCalendarUrl({ stay: STAY, lodgeName: LODGE }));
    expect(url.origin + url.pathname).toBe(
      "https://outlook.live.com/calendar/0/deeplink/compose",
    );
    expect(url.searchParams.get("allday")).toBe("true");
    expect(url.searchParams.get("startdt")).toBe("2026-08-01");
    expect(url.searchParams.get("enddt")).toBe("2026-08-05");
    expect(url.searchParams.has("location")).toBe(false);
    expect(url.searchParams.has("body")).toBe(false);
  });

  it("the .ics download URL carries the booking's own verifiable token and its signed expiry (checkout + 60 days)", () => {
    const url = new URL(bookingIcsDownloadUrl(STAY));
    // /api/booking-calendar, NOT /api/calendar — that prefix is module-gated
    // behind the eventsCalendar flag (review finding I).
    expect(url.pathname).toBe("/api/booking-calendar/bkg_test123");
    const exp = Number(url.searchParams.get("exp"));
    expect(exp).toBe(bookingCalendarLinkExpiry(STAY));
    expect(exp).toBe(
      Math.floor(parseDateOnly("2026-10-03").getTime() / 1000),
    );
    expect(
      verifyBookingCalendarToken({
        bookingId: STAY.bookingId,
        expiresAtSeconds: exp,
        token: url.searchParams.get("token") ?? "",
        now: new Date(),
      }),
    ).toBe(true);
  });
});

describe("the {{ical}} block", () => {
  it("composes the three links as complete lines", () => {
    const links = bookingCalendarLinks({ stay: STAY, lodgeName: LODGE });
    const block = bookingAddToCalendarBlock(links);
    const lines = block.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("Add this stay to your calendar");
    expect(lines[1]).toBe(`Calendar file (.ics): ${links.icsUrl}`);
    expect(lines[2]).toBe(`Google Calendar: ${links.googleUrl}`);
    expect(lines[3]).toBe(`Outlook.com: ${links.outlookUrl}`);
  });

  it("the editor preview sample is the composer's own shape (stale-sample guard)", () => {
    // The registry hard-codes the sample (it cannot compose — composing needs
    // the HMAC secret and the registry is editor-facing), so this equality is
    // what keeps the preview honest when the composer's wording changes.
    expect(sampleValue("ical")).toBe(
      bookingAddToCalendarBlock({
        icsUrl:
          "https://bookings.example.org/api/booking-calendar/bkg_example?token=u3Zn4XhIYQ2p9cTe7wLkR5vBs1oJfD8mAqN6yPxWgE0&exp=1791244800",
        googleUrl:
          "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Example+Lodge+stay&dates=20260801/20260806",
        outlookUrl:
          "https://outlook.live.com/calendar/0/deeplink/compose?path=%2Fcalendar%2Faction%2Fcompose&rru=addevent&allday=true&subject=Example+Lodge+stay&startdt=2026-08-01&enddt=2026-08-06",
      }),
    );
  });
});
