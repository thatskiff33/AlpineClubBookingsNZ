/**
 * #3123 — the booking narrative reads instants in the CLUB's zone, and reads
 * lodge nights in no zone at all.
 *
 * This file exists because `booking-narrative.ts` renders both kinds of date
 * inside a single sentence, and getting either one wrong is invisible on this
 * deployment. The lead defect the issue is named for is the paid message: a
 * member is told the day their payment landed, and it used to be the day it
 * landed on the CONTAINER's clock.
 *
 * ## How this suite can fail, which is the whole point
 *
 * The environment zone — the container's `TZ`, and the only thing
 * `formatNZDate` ever read — used to be pinned here to `America/Denver`, BEHIND
 * Greenwich, via a `@/config/operational` mock. #3567 deleted that module and
 * nothing reads the environment's zone any more, so the pin is gone; the
 * premise below still compares against Denver, the side on which the defect is
 * visible. The club's own zone is supplied as data and varied per test, so no
 * assertion here can pass by coincidence.
 *
 * The fixture instant `2026-07-01T02:00:00Z` is 1 July 14:00 in Auckland and
 * 30 June 20:00 in Denver — two different calendar days. The frozen clock
 * (`2026-07-01T00:00:00.000Z`) is irrelevant here: every value under test is a
 * SUPPLIED date, never "now", so no `vi.setSystemTime` pin is needed.
 *
 * ## The other half — the trap this migration had to avoid
 *
 * `checkIn`/`checkOut` are `DateTime @db.Date` lodge nights
 * (`prisma/schema.prisma:1662-1663`). A calendar day is the same day everywhere
 * on earth, so the stay window must render IDENTICALLY under every club zone.
 * A future sweep that "migrates the remaining `nzst-date` sites onto the club
 * zone" would break exactly that, which is why it is asserted here rather than
 * left to the reader of a docblock.
 */
import { describe, expect, it } from "vitest";
import { BookingEventType } from "@prisma/client";

import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import {
  resolveBookingNarrative,
  type NarrativeBooking,
  type NarrativeEvent,
} from "@/lib/booking-narrative";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/** 1 July 14:00 in Auckland, 30 June 20:00 in Denver. */
const OCCURRED_AT = "2026-07-01T02:00:00.000Z";

/** `@db.Date` lodge nights: UTC-midnight encodings of 1 and 3 August 2026. */
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

const AUCKLAND = bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST);
const KIRITIMATI = bindClubTime(requireClubTimeZone("Pacific/Kiritimati"), CLUB_FORMAT_TEST);
const PAGO = bindClubTime(requireClubTimeZone("Pacific/Pago_Pago"), CLUB_FORMAT_TEST);

function booking(overrides: Partial<NarrativeBooking> = {}): NarrativeBooking {
  return {
    status: "PAID",
    finalPriceCents: 12000,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    firstName: "Sam",
    adminReviewStatus: null,
    adminReviewNotes: null,
    adminReviewReason: null,
    ...overrides,
  };
}

function event(
  type: BookingEventType,
  occurredAt: string,
  extra: Partial<NarrativeEvent> = {}
): NarrativeEvent {
  return {
    type,
    occurredAt: new Date(occurredAt),
    amountCents: null,
    reason: null,
    snapshot: null,
    ...extra,
  };
}

describe("the premise these assertions rest on", () => {
  it("the environment and the club really do disagree about this instant", () => {
    const inEnvironment = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Denver",
    }).format(new Date(OCCURRED_AT));
    const atTheClub = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Pacific/Auckland",
    }).format(new Date(OCCURRED_AT));

    expect(inEnvironment).toBe("2026-06-30");
    expect(atTheClub).toBe("2026-07-01");
  });
});

describe("an instant is read in the club's zone (#3123's lead defect)", () => {
  it("names the club's day in the payment confirmation, not the container's", () => {
    const result = resolveBookingNarrative({
      club: AUCKLAND,
      booking: booking(),
      events: [
        event(BookingEventType.MEMBER_PAID, OCCURRED_AT, {
          amountCents: 12000,
        }),
      ],
    }, CLUB_FORMAT_TEST);

    // Before this migration the message read "30 Jun 2026" — the day it was in
    // Denver, where nobody involved in this booking lives.
    expect(result.message).toContain("we've received your payment of $120.00 on 1 Jul 2026");
    expect(result.message).not.toContain("30 Jun 2026");
  });

  it("moves with the club's zone, which kills a hard-coded one", () => {
    const paid = [
      event(BookingEventType.MEMBER_PAID, OCCURRED_AT, { amountCents: 12000 }),
    ];
    const ahead = resolveBookingNarrative({
      club: KIRITIMATI,
      booking: booking(),
      events: paid,
    }, CLUB_FORMAT_TEST);
    const behind = resolveBookingNarrative({
      club: PAGO,
      booking: booking(),
      events: paid,
    }, CLUB_FORMAT_TEST);

    expect(ahead.message).toContain("payment of $120.00 on 1 Jul 2026");
    expect(behind.message).toContain("payment of $120.00 on 30 Jun 2026");
    expect(ahead.message).not.toBe(behind.message);
  });

  it("reads the cancellation, payment and settlement stamps in the club's zone too", () => {
    const events = [
      event(BookingEventType.MEMBER_PAID, OCCURRED_AT, { amountCents: 12000 }),
      event(BookingEventType.CANCELLED, OCCURRED_AT),
      event(BookingEventType.REFUNDED, OCCURRED_AT, { amountCents: 9000 }),
    ];
    const atTheClub = resolveBookingNarrative({
      club: AUCKLAND,
      booking: booking({ status: "CANCELLED" }),
      events,
    }, CLUB_FORMAT_TEST);
    const behindGreenwich = resolveBookingNarrative({
      club: PAGO,
      booking: booking({ status: "CANCELLED" }),
      events,
    }, CLUB_FORMAT_TEST);

    expect(atTheClub.state).toBe("cancelled_post_payment");
    // Cancelled on / paid on / refunded on — all three stamps, one zone.
    expect(atTheClub.message.match(/1 Jul 2026/g)).toHaveLength(3);
    expect(atTheClub.message).not.toContain("30 Jun 2026");
    expect(behindGreenwich.message.match(/30 Jun 2026/g)).toHaveLength(3);
  });

  it("reads a bumped booking's release stamp in the club's zone", () => {
    const events = [event(BookingEventType.BUMPED, OCCURRED_AT)];

    expect(
      resolveBookingNarrative({
        club: AUCKLAND,
        booking: booking({ status: "BUMPED" }),
        events,
      }, CLUB_FORMAT_TEST).message
    ).toContain("released on 1 Jul 2026");
    expect(
      resolveBookingNarrative({
        club: PAGO,
        booking: booking({ status: "BUMPED" }),
        events,
      }, CLUB_FORMAT_TEST).message
    ).toContain("released on 30 Jun 2026");
  });

  it("reads a pre-payment cancellation's stamp in the club's zone", () => {
    const events = [event(BookingEventType.CANCELLED, OCCURRED_AT)];

    expect(
      resolveBookingNarrative({
        club: AUCKLAND,
        booking: booking({ status: "CANCELLED" }),
        events,
      }, CLUB_FORMAT_TEST).message
    ).toContain("was cancelled on 1 Jul 2026");
    expect(
      resolveBookingNarrative({
        club: PAGO,
        booking: booking({ status: "CANCELLED" }),
        events,
      }, CLUB_FORMAT_TEST).message
    ).toContain("was cancelled on 30 Jun 2026");
  });
});

describe("a lodge night takes no zone at all — the half a sweep would break", () => {
  it("renders the same stay window under every club zone", () => {
    const rendered = [AUCKLAND, KIRITIMATI, PAGO].map(
      (club) =>
        resolveBookingNarrative({
          club,
          booking: booking({ status: "PENDING" }),
          events: [],
        }, CLUB_FORMAT_TEST).message
    );

    for (const message of rendered) {
      expect(message).toContain("1 Aug 2026 to 3 Aug 2026");
    }
    expect(new Set(rendered).size).toBe(1);
  });

  it("keeps the stay window fixed while the payment date moves in the SAME sentence", () => {
    const paid = [
      event(BookingEventType.MEMBER_PAID, OCCURRED_AT, { amountCents: 12000 }),
    ];
    const ahead = resolveBookingNarrative({
      club: KIRITIMATI,
      booking: booking(),
      events: paid,
    }, CLUB_FORMAT_TEST).message;
    const behind = resolveBookingNarrative({
      club: PAGO,
      booking: booking(),
      events: paid,
    }, CLUB_FORMAT_TEST).message;

    // One sentence, two kinds of date, and only one of them is allowed to move.
    expect(ahead).toContain("stay from 1 Aug 2026 to 3 Aug 2026 is confirmed");
    expect(behind).toContain("stay from 1 Aug 2026 to 3 Aug 2026 is confirmed");
    expect(ahead).toContain("on 1 Jul 2026");
    expect(behind).toContain("on 30 Jun 2026");
  });

  it("refuses a real timestamp handed in as a lodge night rather than rendering a plausible wrong day", () => {
    expect(() =>
      resolveBookingNarrative({
        club: AUCKLAND,
        booking: booking({
          status: "PENDING",
          // A `createdAt` carrying a time of day, which is what a mis-wired
          // caller looks like. Flooring it to its UTC day would be silently
          // right for a club east of Greenwich and silently wrong for one
          // behind it — INV-DATE-019's defect.
          checkIn: new Date("2026-08-01T11:30:00.000Z"),
        }),
        events: [],
      }, CLUB_FORMAT_TEST)
    ).toThrow(/takes a stored calendar day, not a moment/);
  });
});
