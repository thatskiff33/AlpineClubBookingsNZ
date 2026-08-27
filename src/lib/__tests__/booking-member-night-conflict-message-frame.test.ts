/**
 * CT-4 (#2870), group F4b: a lodge-night KEY takes no timezone at all.
 *
 * `booking-member-night-conflict-messages.ts` names the nights a member is
 * already booked on. Those nights arrive as `YYYY-MM-DD` strings — the keys
 * `findBookingMemberNightConflicts` puts on the wire, which are calendar days
 * and nothing else. The copy used to render them with
 * `formatNZDate(parseDateOnly(night))`: `parseDateOnly` pins the key at UTC
 * midnight and `formatNZDate` then PROJECTS that instant through the
 * environment zone. For a club behind Greenwich that is the previous day, so
 * the member was told the wrong nights were the problem — a refusal naming
 * dates they never picked.
 *
 * `INV-DATE-019` is the rule: 11 June 2026 is 11 June 2026 everywhere on earth,
 * and asking which zone to render it in is asking a question with no answer.
 *
 * ## Why this file mocks the config instead of setting `TZ`
 *
 * `TZ` is not a usable lever on this repository's documented shell (Git Bash on
 * Windows drops any value containing a `/`), and it would move `APP_TIME_ZONE`
 * and the host together — so a suite that used it could not tell a projection
 * through the configured zone from one through the host's. Mocking
 * `@/config/operational` moves the ENVIRONMENT zone alone, which is exactly the
 * leak this file is about. The host axis is covered separately below with
 * `withTimeZone`, which catches a host-local-getter implementation that a
 * config mock cannot see.
 */
import { describe, expect, it, vi } from "vitest";

/*
 * The zone the replaced projection would have rendered through, declared ONCE
 * (#3123). `vi.mock` factories hoist above every plain `const`, so this zone
 * used to be written as the mock's literal and then read back implicitly as the
 * projection helper's default — two writings, one of them unpinned. `vi.hoisted`
 * gives the factory and the premise below the same declaration.
 */
const { LEGACY_PROJECTION_ZONE } = vi.hoisted(() => ({
  LEGACY_PROJECTION_ZONE: "America/Denver",
}));

vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: LEGACY_PROJECTION_ZONE,
  APP_LOCALE: "en-NZ",
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { formatDateOnlyForTimeZone, parseDateOnly } from "@/lib/date-only";
import {
  buildBookingMemberNightConflictMessage,
  buildBookingMemberNightConflictSummary,
  describeBookingMemberNightConflictNights,
} from "@/lib/booking-member-night-conflict-messages";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

/** The nights the member actually chose, as the keys the server sends. */
const NIGHTS = ["2026-06-11", "2026-06-12"];

/** How those keys must read, in every zone, on every host. */
const RENDERED = "11 Jun 2026 and 12 Jun 2026";

const bob = {
  memberName: "Bob Jones",
  conflictingNights: NIGHTS,
};

describe("member-night conflict copy renders the night KEY, not a projection", () => {
  it("PREMISE: the mocked environment zone really does move a UTC-midnight day", () => {
    // Measured, not assumed. If `America/Denver` ever stopped shifting a
    // UTC-midnight day back, every assertion below would hold for the wrong
    // reason and this file would be worthless while staying green.
    expect(APP_TIME_ZONE).toBe("America/Denver");
    // The zone is named rather than defaulted (#3123): this line models the
    // REPLACED rendering, so it has to say which zone it models. The line above
    // is what still ties that zone to the environment the leak would have used.
    expect(
      formatDateOnlyForTimeZone(parseDateOnly(NIGHTS[0]), LEGACY_PROJECTION_ZONE),
    ).toBe("2026-06-10");
  });

  it("names the nights the member chose, not the day before", () => {
    expect(describeBookingMemberNightConflictNights(bob)).toBe(
      `Already on a booking for ${RENDERED}.`,
    );
  });

  it("the summary sentence names them too", () => {
    expect(buildBookingMemberNightConflictSummary([bob])).toBe(
      `Bob Jones is already on a booking for ${RENDERED}.`,
    );
  });

  it("and the whole 409 message", () => {
    expect(buildBookingMemberNightConflictMessage([bob])).toBe(
      `Bob Jones is already on a booking for ${RENDERED}. ` +
        "Ask whoever made that booking, or the club, to take them off it.",
    );
  });

  it("the >4 nights summarised form counts from the right first night", () => {
    const many = {
      memberName: "Bob Jones",
      conflictingNights: [
        "2026-06-11",
        "2026-06-12",
        "2026-06-13",
        "2026-06-14",
        "2026-06-15",
      ],
    };
    expect(describeBookingMemberNightConflictNights(many)).toBe(
      "Already on a booking for 11 Jun 2026, 12 Jun 2026, 13 Jun 2026 and 2 more nights.",
    );
  });

  it("a key that names no real day is passed through rather than guessed at", () => {
    // `2026-02-30` does not exist. The old code rendered whatever
    // `parseDateOnly` rolled it to; a calendar day that cannot be parsed is
    // shown as it arrived instead, which at least says what the server sent.
    expect(
      describeBookingMemberNightConflictNights({
        memberName: "Bob Jones",
        conflictingNights: ["2026-02-30"],
      }),
    ).toBe("Already on a booking for 2026-02-30.");
  });

  it("HOST AXIS: a host behind Greenwich cannot move the night either", () => {
    // The config mock above cannot see a host-local-getter implementation —
    // `date.getDate()` reads `process.env.TZ`, not `APP_TIME_ZONE`. This is the
    // other half of the discrimination, and it is why the two axes are both
    // here: either one alone leaves a whole class of wrong implementation green.
    withTimeZone("Pacific/Pago_Pago", () => {
      expect(describeBookingMemberNightConflictNights(bob)).toBe(
        `Already on a booking for ${RENDERED}.`,
      );
    });
    withTimeZone("Pacific/Kiritimati", () => {
      expect(describeBookingMemberNightConflictNights(bob)).toBe(
        `Already on a booking for ${RENDERED}.`,
      );
    });
  });
});
