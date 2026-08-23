// @vitest-environment jsdom

/**
 * #2631 / #2628 — the Departing BADGE and the Mark Departed BUTTON are two
 * separate flags, and the button's must be exactly what the server will accept.
 *
 * `isDeparting` is the operational day: "somebody leaves the lodge today". A
 * sparse stay (nights {11, 14}) leaves the lodge twice — on the 12th and again
 * on the 15th — so the badge is correct on both mornings. The button rides on
 * `canMarkDeparted`, which the guests route derives from the depart endpoint's
 * OWN predicate (`isGuestDepartureMorning`), so the kiosk never offers a
 * check-out the server refuses and never withholds one it would accept.
 *
 * #2631 shipped this split with the flag computed as `stayEnd` equality, which
 * matched the endpoint AT THE TIME: it resolved its guest that way and 404'd on
 * any earlier morning. That made the sparse stay's first check-out
 * unrecordable — badge on, button withheld, nothing the hut leader could do.
 * #2628 fixed the endpoint per segment, so the button is now offered on BOTH
 * mornings. The two cases below are the same two cases, with the intermediate
 * one flipped to the answer the server now gives.
 *
 * Frozen clock discipline: the fixtures are anchored to a fixed instant in
 * July 2026 rather than to the real calendar.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import KioskPage from "../page";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import { restoreHostTimeZone } from "@/lib/__tests__/helpers/timezone";
import { buildWeekDateKeys } from "../_components/kiosk-week-view";

/*
  THE MACHINE IS MOVED ABOVE THE IMPORTS, AND IT HAS TO BE.

  `page.tsx` renders the day heading through a module-level
  `Intl.DateTimeFormat` CONSTANT and `kiosk-week-view.tsx` renders each tile's
  `aria-label` through another, both frozen when those modules load. A zone
  assigned in a `beforeEach` arrives after that and never reaches them — so a
  formatter that dropped its `timeZone: "UTC"` pin and rendered in the runtime's
  own zone could not be told from a correct one, least of all on CI, where `TZ`
  is unset and the host resolves `UTC`.

  `America/New_York` is UTC-4 in July, where a UTC-midnight encoding reads as the
  previous evening. The reading is taken by hand because `vi.hoisted` runs above
  this file's imports, so `captureHostTimeZone` does not exist yet;
  `restoreHostTimeZone` below is the shared #2485 rule.
*/
const { originalHostTimeZone } = vi.hoisted(() => {
  const original = {
    envTz: process.env.TZ,
    resolvedZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  process.env.TZ = "America/New_York";
  return { originalHostTimeZone: original };
});

/*
  THE CLUB'S ZONE NOW ARRIVES THROUGH THE PROVIDER, AND THE ENVIRONMENT IS SET
  SOMEWHERE ELSE ON PURPOSE (CT-4, #2870; INV-CONFIG-002).

  Before CT-4 the kiosk read `APP_TIME_ZONE`, so this mock was the club's zone
  and pinning it to `Pacific/Auckland` was what kept the rollover cases meaning
  anything once the HOST zone moved. The page now takes the club's day from
  `ClubTimeProvider` instead, and `renderKiosk` below supplies it — so the mock
  is free to become a third zone, and it should be.

  WHAT THAT DOES AND DOES NOT BUY, stated precisely, because the obvious claim is
  wrong. Three authorities are in play — club `Pacific/Auckland` (the provider),
  environment `America/Denver` (this mock), host `America/New_York` (above) — and
  at the 02:00 UTC instants every case here pins, the club is on one calendar day
  and BOTH of the others are on the day before. So a date assertion tells the
  club apart from either wrong authority, which is what matters; it does not tell
  the environment apart from the host, and no assertion at this instant could,
  because at any single moment there are only ever two calendar days on earth.

  The zone claim is carried by "opens on the club's day" below. Every other case
  here reaches its night by CLICKING a tile by name, which self-corrects: pick
  the wrong day to open on and the tile is still in the same week and still gets
  clicked. Measured before that case existed: every zone mutant killed 0 of the
  7 tests in this file, while the comment above claimed all of them discriminated
  all three zones.

  `APP_LOCALE` still matters and is left alone — the kiosk header's long-weekday
  formatter is a calendar-date shape with no house entry in the kernel, so it
  stays local and is pinned to `UTC` over the UTC-midnight encoding.
*/
vi.mock("@/config/operational", () => ({
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
}));

vi.mock("@/components/kiosk-lodge-instructions", () => ({
  KioskLodgeInstructions: () => null,
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

// The sparse stay from the route fixture: nights {2026-07-11, 2026-07-14},
// `stayEnd` 2026-07-15. Present on the 11th, 12th, 14th and 15th, and leaving
// the lodge on the 12th AND the 15th. The two mornings fall in different
// kiosk weeks, so each case opens the kiosk on its own day.
const INTERMEDIATE_DEPARTURE = {
  dateKey: "2026-07-12",
  openLabel: "Open Sunday, 12 July",
};
const FINAL_DEPARTURE = {
  dateKey: "2026-07-15",
  openLabel: "Open Wednesday, 15 July",
};

/** The guest's return night, in the same stay: back on the 14th. */
const RETURN_NIGHT = {
  dateKey: "2026-07-14",
  openLabel: "Open Tuesday, 14 July",
};

function guestPayload(opts: {
  isDeparting: boolean;
  canMarkDeparted: boolean;
  isArriving?: boolean;
  canMarkArrived?: boolean;
  arrivedAt?: string | null;
  departedAt?: string | null;
}) {
  return {
    bookings: [
      {
        bookingId: "booking-1",
        memberName: "Bev Booker",
        expectedArrivalTime: null,
        blockedFromCheckin: false,
        guests: [
          {
            id: "sparse",
            firstName: "Sam",
            lastName: "Sparse",
            ageTier: "ADULT",
            isMember: false,
            isArriving: false,
            canMarkArrived: false,
            arrivedAt: null,
            departedAt: null,
            phone: null,
            ...opts,
          },
        ],
      },
    ],
    totalGuests: 1,
  };
}

/**
 * Serves the kiosk's endpoints with a week that spans both departure mornings,
 * and the given guest payload for whichever day is opened.
 */
function installFetchMock(
  payload: ReturnType<typeof guestPayload>,
  // #2737: the attendance WRITES are unmocked by default and the throw below is
  // deliberate — a test that presses a button without declaring what the server
  // says is not testing anything. Pass this to declare it.
  arriveResponse?: () => Response,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;

    if (/^\/api\/lodge\/guests\/\d{4}-\d{2}-\d{2}\/arrive$/.test(path) && arriveResponse) {
      return arriveResponse();
    }

    if (path === "/api/lodge/access") {
      return Response.json({
        tier: "hut-leader",
        dateRange: null,
        canManageRoster: true,
        canMarkAttendance: true,
        canCompleteChores: true,
        lodgeName: "Whakapapa",
      });
    }

    if (path === "/api/lodge/week") {
      const start = url.searchParams.get("start") ?? "";
      return Response.json({
        start,
        days: buildWeekDateKeys(start).map((date) => ({
          date,
          accessible: true,
          guestCount: 1,
          arrivingCount: 0,
          departingCount: 1,
          rosterStatus: "needs-roster",
        })),
      });
    }

    if (/^\/api\/lodge\/guests\/\d{4}-\d{2}-\d{2}$/.test(path)) {
      return Response.json(payload);
    }

    if (/^\/api\/lodge\/roster\/\d{4}-\d{2}-\d{2}$/.test(path)) {
      return Response.json({ assignments: [] });
    }

    throw new Error(`Unexpected fetch ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Opens the kiosk's day view on the given morning and returns the guest row. */
async function openGuestRow(day: {
  dateKey: string;
  openLabel: string;
}): Promise<HTMLElement> {
  // 02:00 UTC is mid-afternoon in New Zealand on the same date, so the club's
  // "today" — which is what the kiosk opens on — is the day under test.
  vi.setSystemTime(new Date(`${day.dateKey}T02:00:00.000Z`));

  renderKiosk();

  fireEvent.click(await screen.findByRole("button", { name: day.openLabel }));

  const name = await screen.findByText("Sam Sparse");
  await waitFor(() => expect(screen.getByText("Lodge List")).toBeVisible());
  // The guest row is the flex container holding the name and the badges.
  const row = name.closest("div.flex.items-center.justify-between");
  if (!row) throw new Error("no guest row rendered for Sam Sparse");
  return row as HTMLElement;
}

afterAll(() => {
  // Never `delete process.env.TZ`: Node re-derives the zone on ASSIGNMENT only,
  // so a bare delete leaks this zone into whichever suite runs next (#2485).
  restoreHostTimeZone(originalHostTimeZone);
});

/** The club this kiosk belongs to. Delivered the way the application does it. */
const CLUB_ZONE = "Pacific/Auckland";

function renderKiosk() {
  return render(
    <ClubTimeProvider zone={CLUB_ZONE}>
      <KioskPage />
    </ClubTimeProvider>,
  );
}

describe("kiosk Mark Departed follows the check-out flag, not the badge (#2631)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.setSystemTime(frozenTestNow());
  });

  it("opens on the CLUB's day, not the environment's and not the tablet's", async () => {
    /*
      THE ONLY CASE IN THIS FILE THAT MAKES A ZONE CLAIM, and it exists because
      the others cannot: they reach their night by clicking a tile by name, so
      opening on the wrong day self-corrects and every zone mutant survived.

      At 02:00 UTC on 12 July the club (`Pacific/Auckland`, UTC+12) is on the
      12th; the environment (`America/Denver`) and the tablet's own clock
      (`America/New_York`) are both still on the 11th. So the Today chip lands on
      a different tile for each answer, and the day heading names a different
      night — which is a hut leader served the wrong guest list.

      It also pins the two module-level `Intl.DateTimeFormat` constants that
      produce these strings: the tile's `aria-label` in `kiosk-week-view.tsx` and
      the heading in `page.tsx`. Both are calendar-day formatters pinned to
      `UTC`, and with the host behind Greenwich a dropped pin renames both.
    */
    installFetchMock(guestPayload({ isDeparting: true, canMarkDeparted: true }));
    vi.setSystemTime(new Date(`${INTERMEDIATE_DEPARTURE.dateKey}T02:00:00.000Z`));

    renderKiosk();

    const clubDay = await screen.findByRole("button", {
      name: INTERMEDIATE_DEPARTURE.openLabel,
    });
    expect(within(clubDay).getByText("Today")).toBeVisible();

    // And on no other tile — the day both wrong authorities would have chosen.
    const dayBefore = screen.getByRole("button", {
      name: "Open Saturday, 11 July",
    });
    expect(within(dayBefore).queryByText("Today")).toBeNull();

    // The day view opens on the same night, named in full by `page.tsx`.
    fireEvent.click(clubDay);
    expect(
      await screen.findByRole("heading", { name: "Sunday, 12 July 2026" }),
    ).toBeVisible();
  });

  it("an intermediate departure morning shows the chip AND the button (#2628)", async () => {
    installFetchMock(
      guestPayload({ isDeparting: true, canMarkDeparted: true }),
    );

    const row = await openGuestRow(INTERMEDIATE_DEPARTURE);

    // The badge is right: they really are leaving the lodge this morning.
    expect(within(row).getByText("Departing")).toBeVisible();
    // …and so is the button now, because the endpoint accepts this morning.
    expect(
      within(row).getByRole("button", { name: "Mark Departed" }),
    ).toBeVisible();
  });

  it("the FINAL departure morning shows the chip and the button together", async () => {
    installFetchMock(
      guestPayload({ isDeparting: true, canMarkDeparted: true }),
    );

    const row = await openGuestRow(FINAL_DEPARTURE);

    expect(within(row).getByText("Departing")).toBeVisible();
    expect(
      within(row).getByRole("button", { name: "Mark Departed" }),
    ).toBeVisible();
  });

  it("leaves a control on the row when the guest comes BACK (#2628)", async () => {
    // The dead end an intermediate check-out used to create. `departedAt` is
    // one column for the whole stay, so on the return night it still holds the
    // 12th's departure: the row was faded, the check-in button was hidden on
    // `!departedAt`, and the check-out button was correctly absent because the
    // 14th is a night, not a departure morning. The hut leader was left with
    // NOTHING to press for a guest standing in front of them.
    installFetchMock(
      guestPayload({
        isDeparting: false,
        canMarkDeparted: false,
        isArriving: true,
        canMarkArrived: true,
        arrivedAt: "2026-07-11T06:00:00.000Z",
        departedAt: "2026-07-12T22:00:00.000Z",
      }),
    );

    const row = await openGuestRow(RETURN_NIGHT);

    expect(within(row).getByText("Arriving")).toBeVisible();
    // Offered, and offered as an ACTION — a stale `arrivedAt` from the first
    // segment must not render as "Arrived" for a guest who has not checked back
    // in yet.
    expect(within(row).getByRole("button", { name: "Mark Arrived" })).toBeVisible();
    expect(within(row).queryByRole("button", { name: "Arrived" })).toBeNull();
    // And the row is not greyed out as departed while they are standing there.
    expect(row.className).not.toContain("opacity-60");
  });

  it("STILL WITHHOLDS the button where the server would refuse", async () => {
    // The split itself, which #2628 narrowed but did not remove. The two flags
    // coincide today; the button must follow the SERVER's flag, so a payload
    // where they disagree renders the badge and no button. Gate the button on
    // `isDeparting` instead and this fails.
    installFetchMock(
      guestPayload({ isDeparting: true, canMarkDeparted: false }),
    );

    const row = await openGuestRow(INTERMEDIATE_DEPARTURE);

    expect(within(row).getByText("Departing")).toBeVisible();
    expect(
      within(row).queryByRole("button", { name: "Mark Departed" }),
    ).toBeNull();
  });
});

describe("the kiosk repeats the server's gap-night refusal verbatim (#2737)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.setSystemTime(frozenTestNow());
  });

  const REFUSAL =
    "This guest is not booked in for this night, so they cannot be checked in. Reload the day to see who is staying.";

  it("shows the refusal sentence, not 'Failed to update arrival'", async () => {
    // The only way the endpoint's new 409 is reachable in practice: a page left
    // open from an earlier night still shows a Mark Arrived button that the
    // server now refuses. The generic line sends the hut leader looking for a
    // fault that is not there; the server's own sentence tells them to reload.
    installFetchMock(
      guestPayload({
        isDeparting: false,
        canMarkDeparted: false,
        isArriving: true,
        canMarkArrived: true,
      }),
      () =>
        Response.json(
          { error: REFUSAL, code: "GUEST_NOT_BOOKED_THIS_NIGHT" },
          { status: 409 },
        ),
    );

    const row = await openGuestRow(RETURN_NIGHT);
    fireEvent.click(within(row).getByRole("button", { name: "Mark Arrived" }));

    expect(await screen.findByText(REFUSAL)).toBeVisible();
    expect(screen.queryByText("Failed to update arrival")).toBeNull();
  });

  it("keeps the generic line for any OTHER failure", async () => {
    // The STATUS half of the whitelist. A 500 must not put arbitrary server
    // text on the kiosk screen. MUTATION PROBE: drop the `res.status === 409`
    // clause in `toggleArrival` and this fails.
    installFetchMock(
      guestPayload({
        isDeparting: false,
        canMarkDeparted: false,
        isArriving: true,
        canMarkArrived: true,
      }),
      () =>
        Response.json(
          { error: "Internal detail nobody at the lodge should read" },
          { status: 500 },
        ),
    );

    const row = await openGuestRow(RETURN_NIGHT);
    fireEvent.click(within(row).getByRole("button", { name: "Mark Arrived" }));

    expect(await screen.findByText("Failed to update arrival")).toBeVisible();
    expect(
      screen.queryByText("Internal detail nobody at the lodge should read"),
    ).toBeNull();
  });

  it("keeps the generic line for a 409 carrying some OTHER code", async () => {
    // The CODE half of the same whitelist, which the 500 case above cannot
    // reach. `toggleArrival` passes the server's sentence through only for
    // `GUEST_NOT_BOOKED_THIS_NIGHT`; every other code keeps the generic line,
    // so a future 409 on this endpoint cannot start rendering arbitrary server
    // prose on a screen in the hut by doing nothing at all.
    //
    // MUTATION PROBE: drop the `refusal?.code === "GUEST_NOT_BOOKED_THIS_NIGHT"`
    // clause and this fails while every other test in the tree stays green —
    // which is exactly why it is here.
    installFetchMock(
      guestPayload({
        isDeparting: false,
        canMarkDeparted: false,
        isArriving: true,
        canMarkArrived: true,
      }),
      () =>
        Response.json(
          {
            error: "Internal detail nobody at the lodge should read",
            code: "SOME_OTHER_CODE",
          },
          { status: 409 },
        ),
    );

    const row = await openGuestRow(RETURN_NIGHT);
    fireEvent.click(within(row).getByRole("button", { name: "Mark Arrived" }));

    expect(await screen.findByText("Failed to update arrival")).toBeVisible();
    expect(
      screen.queryByText("Internal detail nobody at the lodge should read"),
    ).toBeNull();
  });
});
