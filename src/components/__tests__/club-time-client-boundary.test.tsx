// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { ClubTimeProvider } from "@/components/club-time-provider";
import {
  bindClubTime,
  formatClubDate,
  requireCalendarDate,
  requireClubTimeZone,
} from "@/lib/club-time";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 20 }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { BookingCalendar } from "@/components/booking-calendar";
import { NoticeAcknowledgeButton } from "@/components/notice-acknowledge-button";
import { MembershipCancellationBlockerNotice } from "@/components/admin/membership-cancellation-blocker-notice";

/**
 * THE CLUB'S PERSISTED TIMEZONE IS THE AUTHORITY IN THE BROWSER (CT-4 group C,
 * #2870; epic #2988; INV-CONFIG-002).
 *
 * ## Why this suite is separate from the component suites
 *
 * Every other test in this tree renders through
 * `src/lib/__tests__/support/club-time-render`, whose default zone is
 * `Pacific/Auckland` — deliberately, because that is what `APP_TIME_ZONE`
 * resolves to under test, so every pre-existing assertion keeps its exact
 * expected string. That default makes those tests useful for what they assert
 * and USELESS for zone authority: where the persisted zone and the environment
 * agree, the migrated code and the code it replaced give the identical answer.
 * `CLUB_TIME_KERNEL.md` names that trap outright — a claim that is
 * "false and green".
 *
 * So this suite renders under `America/Denver`, which is neither the
 * environment's zone nor CI's host zone, and asserts answers only that zone
 * produces.
 *
 * ## Denver, and why BEHIND UTC specifically
 *
 * `TZ` is unset on CI, so the host resolves UTC while `APP_TIME_ZONE` falls back
 * to `Pacific/Auckland`. A club zone AHEAD of UTC agrees with one or both of
 * those for most of the day, so an assertion made under it cannot tell the three
 * authorities apart. Denver disagrees with both, on the frozen instant, in the
 * direction where the date-only defects live.
 *
 * ## The premise is asserted, not assumed — and it does not depend on the host
 *
 * Each case comes in a PAIR: the same component, the same fixture, rendered
 * under two different provider zones. In the first two cases the two halves are
 * asserted to produce DIFFERENT answers, and that difference is the
 * discrimination — it is what a test of zone AUTHORITY looks like, because an
 * implementation that ignores the provider and reads the environment, or the
 * viewer's clock, or a hard-coded zone, gives the SAME answer to both halves and
 * fails one of them whatever the host happens to be.
 *
 * THE THIRD CASE IS THE EXCEPTION, AND ITS PAIR MEANS THE OPPOSITE. Its claim is
 * INDEPENDENCE — a calendar day is the same day in every zone — so its two halves
 * are asserted to produce the SAME answer, and a difference between them would be
 * the failure. Saying "each case is a pair asserted to produce two different
 * answers" as a blanket rule would be untrue of it, and worse, would invite
 * somebody to "fix" the case into asserting the defect. Its own comments say what
 * it does and does not prove.
 *
 * Each case also states, as an ANSWER rather than an identifier, that the two
 * zones really do disagree about this fixture. An identifier check —
 * `expect(zone).not.toBe("America/Denver")` — passes happily under
 * `America/Chicago` while the assertion beneath it goes vacuous.
 *
 * `APP_TIME_ZONE` IS DELIBERATELY NOT REFERENCED. It reads `process.env.TZ`,
 * so a premise written against it changes meaning with the machine: on a host
 * running `TZ=America/Denver` it would EQUAL the club zone under test and the
 * suite would be asserting nothing, and on `TZ=UTC` it is not even a valid club
 * zone. `LEGACY_REFERENCE_ZONE` below is fixed instead, and the pair above is
 * what carries the proof.
 *
 * ## And the browser is a third authority, set to somewhere else again
 *
 * Every case below points `process.env.TZ` at `Asia/Tokyo`, which agrees with
 * neither of the two answers being distinguished. A component that read its own
 * host — the thing `INV-CONFIG-002` forbids — therefore cannot pass by accident.
 */

/** Neither the environment's zone nor CI's host zone. Behind UTC. */
const CLUB_ZONE = "America/Denver";

/**
 * The other half of every pair: the zone this application used to render
 * everything in. It is `CLUB_TIME_ZONE_FALLBACK`, it is what `APP_TIME_ZONE`
 * resolves to wherever `TZ` is unset — CI included — and it is ahead of UTC
 * where `CLUB_ZONE` is behind it, so the two disagree about the frozen instant.
 */
const LEGACY_REFERENCE_ZONE = "Pacific/Auckland";

/**
 * The frozen test clock (`vitest.clock-setup.ts`), restated because every
 * expectation below is derived from it: 2026-07-01T00:00:00.000Z is 1 July in
 * Auckland (UTC+12) and in UTC, and 30 JUNE in Denver (UTC-6).
 */
const FROZEN_INSTANT = "2026-07-01T00:00:00.000Z";

const hostTimeZone = captureHostTimeZone();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  hostTimeZone.restore();
});

function renderInClubZone(ui: React.ReactElement, zone = CLUB_ZONE) {
  return render(<ClubTimeProvider zone={zone}>{ui}</ClubTimeProvider>);
}

function stubEmptyAvailability() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ availability: {}, seasons: {} }),
    })),
  );
}

describe("CT-4: today comes from the club, not the environment or the browser", () => {
  it("opens the booking calendar on the club's month, not the host's", async () => {
    // PREMISE, as an ANSWER rather than an identifier: on the frozen instant the
    // club's day and the environment's day fall in DIFFERENT MONTHS. If they ever
    // stop differing this fails loudly instead of going vacuous.
    expect(new Date().toISOString()).toBe(FROZEN_INSTANT);
    const clubDay = bindClubTime(requireClubTimeZone(CLUB_ZONE)).today();
    const legacyDay = bindClubTime(
      requireClubTimeZone(LEGACY_REFERENCE_ZONE),
    ).today();
    expect(clubDay).toBe("2026-06-30");
    expect(legacyDay).toBe("2026-07-01");
    expect(clubDay.slice(0, 7)).not.toBe(legacyDay.slice(0, 7));

    process.env.TZ = "Asia/Tokyo";
    stubEmptyAvailability();

    renderInClubZone(<BookingCalendar onDateSelect={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/Select check-in date/)).toBeTruthy(),
    );

    // June, which only the club's zone produces here.
    expect(screen.getByText("June 2026")).toBeTruthy();
    expect(screen.queryByText("July 2026")).toBeNull();
  });

  it("the same calendar follows a DIFFERENT club zone", async () => {
    // The mirror image, and it is what makes the case above about the PROVIDER
    // rather than about a hard-coded June: the component is not producing June
    // for some reason of its own.
    process.env.TZ = "Asia/Tokyo";
    stubEmptyAvailability();

    renderInClubZone(
      <BookingCalendar onDateSelect={vi.fn()} />,
      "Pacific/Auckland",
    );
    await waitFor(() =>
      expect(screen.getByText(/Select check-in date/)).toBeTruthy(),
    );

    expect(screen.getByText("July 2026")).toBeTruthy();
  });
});

describe("CT-4: an instant is projected through the club's zone", () => {
  /**
   * 16 April 2026 at 02:30 UTC is 15 April in Denver (UTC-6) and 16 April in
   * Auckland (UTC+12). One instant, two civil days — exactly the reading the
   * epic's first rule is about.
   */
  const INSTANT = "2026-04-16T02:30:00.000Z";

  it("shows the club's day for an acknowledgement stamp", () => {
    // PREMISE as an answer: the club's projection of this instant and the legacy
    // environment projection are DIFFERENT STRINGS.
    const inClub = bindClubTime(requireClubTimeZone(CLUB_ZONE)).instantDate(
      new Date(INSTANT),
    );
    const inLegacy = bindClubTime(
      requireClubTimeZone(LEGACY_REFERENCE_ZONE),
    ).instantDate(new Date(INSTANT));
    expect(inClub).toBe("15 Apr 2026");
    expect(inLegacy).toBe("16 Apr 2026");
    expect(inClub).not.toBe(inLegacy);

    process.env.TZ = "Asia/Tokyo";

    renderInClubZone(
      <NoticeAcknowledgeButton
        noticeId="n1"
        acknowledged
        acknowledgedAt={INSTANT}
      />,
    );

    expect(screen.getByText(/15 Apr 2026/)).toBeTruthy();
    expect(screen.queryByText(/16 Apr 2026/)).toBeNull();
  });

  it("shows the OTHER club's day for the same stamp", () => {
    // The other half of the pair. An implementation that ignored the provider —
    // reading the environment, the viewer's clock, or a hard-coded zone — would
    // answer both halves identically and fail one of them.
    process.env.TZ = "Asia/Tokyo";

    renderInClubZone(
      <NoticeAcknowledgeButton
        noticeId="n1"
        acknowledged
        acknowledgedAt={INSTANT}
      />,
      LEGACY_REFERENCE_ZONE,
    );

    expect(screen.getByText(/16 Apr 2026/)).toBeTruthy();
    expect(screen.queryByText(/15 Apr 2026/)).toBeNull();
  });
});

describe("CT-4: a calendar date consults NO zone at all", () => {
  /**
   * A `@db.Date` lodge night crosses the wire as UTC midnight. It must render as
   * the day it encodes for every club and every viewer — a stronger claim than
   * "in the club's zone", and the one the calendar-date formatters make good on
   * by pinning UTC over that encoding.
   */
  const NIGHT = "2026-04-16T00:00:00.000Z";

  function blockerNotice() {
    return (
      <MembershipCancellationBlockerNotice
        blockers={[
          {
            type: "owned_booking",
            bookingId: "b1",
            bookingStatus: "CONFIRMED",
            checkIn: NIGHT,
            checkOut: "2026-04-18T00:00:00.000Z",
          },
        ]}
        returnTo="/admin/members"
      />
    );
  }

  it("renders the stored day under a club zone that would have shifted it", () => {
    /*
      PREMISE as an answer: projecting this value through the PROVIDER's zone
      gives a different day from decoding it as the calendar day it encodes. So
      this half fails against an implementation that projects the value through
      whatever zone the provider carries — the shape a future author is most
      likely to reach for, since every neighbouring value in this tree is an
      instant and `instantDate` is right there.

      WHAT IT DOES NOT PROVE, said plainly because the comment here used to claim
      it did. This is NOT what the code this replaced did. That was
      `formatNZDate(new Date(value))`, which projects through `APP_TIME_ZONE` —
      `Pacific/Auckland` wherever `TZ` is unset — and for a UTC-midnight lodge
      night east of Greenwich that yields "16 Apr 2026", the same answer as the
      calendar-date formatter. The predecessor implementation therefore passes
      BOTH halves of this case, and so would any implementation pinned to a zone
      ahead of UTC. What the case is worth is stated on the second half.
    */
    const projected = bindClubTime(requireClubTimeZone(CLUB_ZONE)).instantDate(
      new Date(NIGHT),
    );
    const asCalendarDay = formatClubDate(requireCalendarDate("2026-04-16"));
    expect(projected).toBe("15 Apr 2026");
    expect(asCalendarDay).toBe("16 Apr 2026");
    expect(projected).not.toBe(asCalendarDay);

    process.env.TZ = "Asia/Tokyo";
    renderInClubZone(blockerNotice());

    expect(screen.getByText(/16 Apr 2026/)).toBeTruthy();
    expect(screen.queryByText(/15 Apr 2026/)).toBeNull();
  });

  it("renders the same day under a completely different club zone", () => {
    /*
      The whole point of a calendar day: the provider's zone cannot move it.
      Kiritimati is UTC+14, the far side of the world from Denver.

      THIS HALF IS THE INDEPENDENCE CLAIM, and it deliberately asserts the SAME
      answer as the half above rather than a different one — the only case in this
      file that does. Against a zone-PROJECTING implementation the Denver half is
      what fails; this half would keep passing, because Kiritimati is ahead of UTC
      and projects the UTC-midnight encoding onto the day it already encodes. It is
      here as a forward-looking regression guard on the pair — it pins that the two
      halves agree, so an implementation that starts consulting the provider for a
      calendar date reddens one of them — and not as a second, independent proof.
    */
    process.env.TZ = "Asia/Tokyo";
    renderInClubZone(blockerNotice(), "Pacific/Kiritimati");

    expect(screen.getByText(/16 Apr 2026/)).toBeTruthy();
    expect(screen.queryByText(/15 Apr 2026/)).toBeNull();
    expect(screen.queryByText(/17 Apr 2026/)).toBeNull();
  });
});
