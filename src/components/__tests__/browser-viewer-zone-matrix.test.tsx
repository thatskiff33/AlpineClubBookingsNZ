// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { ClubTimeProvider } from "@/components/club-time-provider";
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
 * CT-6 (#2991) — the BROWSER/VIEWER matrix.
 *
 * ## What this adds to `club-time-client-boundary.test.tsx`
 *
 * That suite moves the CLUB's zone and holds the viewer's still, which proves
 * the provider is the authority. This one moves the opposite axis: the club's
 * zone is fixed and the VIEWER's is walked around the world, which proves the
 * viewer is not an authority at all.
 *
 * The two claims are genuinely different and neither implies the other. A
 * component reading `new Date().getHours()` passes the first suite whenever both
 * of its club zones happen to agree with the viewer, and a component with a
 * hard-coded zone passes this one perfectly. Together they close the pair.
 *
 * ## The viewer's zone in jsdom IS the process zone
 *
 * jsdom's `Date` and `Intl` are Node's, so pinning `process.env.TZ` is what a
 * viewer in that zone would see — the same lever the host matrix uses, and the
 * reason `captureHostTimeZone` exists (#2485: Node re-derives its cached zone on
 * ASSIGNMENT and never on `delete`, so a bare delete leaks the last zone into
 * whichever suite the worker runs next).
 *
 * ## Every row proves its premise as a civil answer
 *
 * Before any invariance claim, each block shows the viewer's own clock giving a
 * materially different reading — a different calendar day, on both sides of the
 * club's. Comparing identifiers would prove a string was assigned; these
 * components are being asked whether they can tell.
 *
 * A premise failure is a FAILURE and never a skip (owner decision, #2870).
 */

/**
 * The club's configured zone, fixed for every row. Behind UTC, where the
 * date-only defects show, and not what `APP_TIME_ZONE` falls back to.
 */
const CLUB_ZONE = "America/Denver";

/**
 * The viewers. Chosen to straddle the club: two zones ahead of it far enough to
 * be on the NEXT calendar day at the fixtures below, one behind it, one equal to
 * UTC (the CI runner's own), and one equal to `Pacific/Auckland` — this
 * repository's shipped fallback, which is the single most likely zone for a
 * viewer-reading bug to look correct in.
 */
const VIEWER_ZONES = [
  "UTC",
  "Pacific/Auckland",
  "Asia/Tokyo",
  "Europe/Berlin",
  "Pacific/Kiritimati",
  "Pacific/Pago_Pago",
] as const;

/**
 * 16 April 2026 at 02:30 UTC. In Denver (UTC-6) that is 15 April; in every
 * viewer zone ahead of UTC it is 16 April, and in `Pacific/Pago_Pago` (UTC-11)
 * it is 15 April as well — so the viewers do not agree with each other either,
 * which is what makes the invariance claim below load-bearing rather than lucky.
 */
const INSTANT = "2026-04-16T02:30:00.000Z";

/** A stored `@db.Date` lodge night, which crosses the wire as UTC midnight. */
const STORED_NIGHT = "2026-04-16T00:00:00.000Z";

const hostTimeZone = captureHostTimeZone();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  hostTimeZone.restore();
});

/** The viewer's OWN calendar day — the one legitimate unzoned read. */
function viewerCalendarDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: undefined }).format(
    new Date(iso),
  );
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

function renderForViewer(ui: React.ReactElement) {
  return render(<ClubTimeProvider zone={CLUB_ZONE}>{ui}</ClubTimeProvider>);
}

describe("the matrix premise: each viewer really sees a different day", () => {
  it("puts viewers on both sides of the club's day for the instant fixture", () => {
    const days = new Map<string, string>();
    for (const zone of VIEWER_ZONES) {
      process.env.TZ = zone;
      days.set(zone, viewerCalendarDay(INSTANT));
    }
    hostTimeZone.restore();

    // The club reads 15 April. FIVE viewers read the 16th and ONE reads the
    // 15th — only `Pacific/Pago_Pago` at UTC-11, which is behind the club as
    // well. So a component that took the viewer's day would be visibly wrong in
    // five rows and accidentally right in one, and that single agreeing row is
    // exactly the one a weaker test would have dropped for looking redundant.
    // (Counted rather than assumed: an earlier version of this comment said
    // four and two, which was wrong while every assertion below was right —
    // the kind of drift that makes a reader trust the prose over the code.)
    expect(days.get("Asia/Tokyo")).toBe("2026-04-16");
    expect(days.get("Pacific/Kiritimati")).toBe("2026-04-16");
    expect(days.get("Pacific/Pago_Pago")).toBe("2026-04-15");
    expect(new Set(days.values())).toEqual(
      new Set(["2026-04-15", "2026-04-16"]),
    );
  });

  it("puts viewers on both sides of the frozen clock's today", () => {
    // The second premise, for the "today" block: on the frozen instant the
    // viewers disagree about what day it is, and about what MONTH it is.
    const days = new Map<string, string>();
    for (const zone of VIEWER_ZONES) {
      process.env.TZ = zone;
      days.set(zone, viewerCalendarDay(new Date().toISOString()));
    }
    hostTimeZone.restore();

    expect(new Date().toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(days.get("Pacific/Pago_Pago")).toBe("2026-06-30");
    expect(days.get("Asia/Tokyo")).toBe("2026-07-01");
    expect(new Set(days.values())).toEqual(
      new Set(["2026-06-30", "2026-07-01"]),
    );
  });
});

describe("a rendered INSTANT is the club's day in every viewer zone", () => {
  it.each(VIEWER_ZONES)("viewer in %s sees the club's 15 April", (zone) => {
    process.env.TZ = zone;

    renderForViewer(
      <NoticeAcknowledgeButton
        noticeId="n1"
        acknowledged
        acknowledgedAt={INSTANT}
      />,
    );

    // The club's answer, hand-written. Asserting only "every row agrees" would
    // be satisfied by every row being uniformly wrong.
    expect(screen.getByText(/15 Apr 2026/)).toBeTruthy();
    // And the viewer's answer is specifically absent, which is the assertion a
    // viewer-reading implementation fails in four of the six rows.
    expect(screen.queryByText(/16 Apr 2026/)).toBeNull();
  });
});

describe("the club's TODAY is the club's in every viewer zone", () => {
  it.each(VIEWER_ZONES)(
    "viewer in %s opens the calendar on the club's June",
    async (zone) => {
      process.env.TZ = zone;
      stubEmptyAvailability();

      renderForViewer(<BookingCalendar onDateSelect={vi.fn()} />);
      await waitFor(() =>
        expect(screen.getByText(/Select check-in date/)).toBeTruthy(),
      );

      // The frozen instant is 30 June in Denver and 1 July nearly everywhere
      // else, so the month heading is where a viewer-derived "today" shows up
      // as a whole month rather than a single day.
      expect(screen.getByText("June 2026")).toBeTruthy();
      expect(screen.queryByText("July 2026")).toBeNull();
    },
  );
});

describe("a CALENDAR DAY is the same day for every viewer", () => {
  it.each(VIEWER_ZONES)(
    "viewer in %s sees the stored lodge night unshifted",
    (zone) => {
      process.env.TZ = zone;

      renderForViewer(
        <MembershipCancellationBlockerNotice
          blockers={[
            {
              type: "owned_booking",
              bookingId: "b1",
              bookingStatus: "CONFIRMED",
              checkIn: STORED_NIGHT,
              checkOut: "2026-04-18T00:00:00.000Z",
            },
          ]}
          returnTo="/admin/members"
        />,
      );

      // The stronger claim: not "in the club's zone" but "in no zone at all". A
      // calendar day's UTC midnight IS its encoding, so 16 April must render as
      // 16 April for a viewer in Kiritimati and one in Pago Pago alike -- and
      // the club being on the 15th at this instant is precisely the coincidence
      // that would hide a projection creeping back in.
      expect(screen.getByText(/16 Apr 2026/)).toBeTruthy();
      expect(screen.queryByText(/15 Apr 2026/)).toBeNull();
    },
  );
});
