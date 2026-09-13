// @vitest-environment jsdom

/**
 * The Seasons page as a SCHEDULE (#2938).
 *
 * The rules are pinned elsewhere — `season-timeline.test.ts` for the boundary
 * arithmetic, `season-schedule.test.ts` for the decode policy this page shares
 * with Fees → Hut Fees. What had no test at all was this page's own wiring, and
 * the wiring is where three of its four failure modes live: where "today" comes
 * from, what happens to a season whose edges cannot be read, and whether the
 * schedule is navigable by anyone who cannot see it.
 *
 * That last one is this issue's own `a11y` label, and it produces a concrete
 * wrong outcome rather than a checklist miss: a run of identically-named
 * buttons on identically-unlabelled cards is a delete button an officer picks
 * by counting.
 *
 * The frozen clock puts "today" at 2026-07-01; every season edge below is
 * written against that instant rather than against the real calendar.
 */

import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FROZEN_TEST_CLOCK_BASE_ISO } from "@/lib/__tests__/helpers/clock";
import { divergentClubZone } from "@/lib/__tests__/helpers/club-time-zone";
import { addCalendarDays, clubToday } from "@/lib/club-time";

const mocks = vi.hoisted(() => ({ canEdit: true as boolean | undefined }));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => mocks.canEdit,
}));

vi.mock("@/components/lodge-select", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/components/lodge-select");
  return {
    ...actual,
    initialLodgeIdFromLocation: () => null,
    useLodgeOptions: () => ({
      lodges: [{ id: "lodge-a", name: "Lodge A" }],
      loading: false,
      failed: false,
      forbidden: false,
      reload: vi.fn(),
    }),
    LodgeSelect: ({
      lodges,
      value,
      onChange,
    }: {
      lodges: ReadonlyArray<{ id: string; name: string }>;
      value: string | null;
      onChange: (value: string | null) => void;
    }) => {
      useEffect(() => {
        if (!value && lodges[0]) onChange(lodges[0].id);
      }, [lodges, onChange, value]);
      return <div data-testid="lodge-select" />;
    },
  };
});

import { ClubTimeProvider } from "@/components/club-time-provider";
import SeasonsPage from "../page";

type SeasonPayload = {
  id: string;
  name: string;
  type: string;
  startDate: string;
  endDate: string;
  active: boolean;
};

function season(overrides: Partial<SeasonPayload> = {}): SeasonPayload {
  return {
    id: "season-winter",
    name: "Winter 2026",
    type: "WINTER",
    startDate: "2026-06-01T00:00:00.000Z",
    endDate: "2026-09-30T00:00:00.000Z",
    active: true,
    ...overrides,
  };
}

const SUMMER = season({
  id: "season-summer",
  name: "Summer 2026-27",
  type: "SUMMER",
  startDate: "2026-12-01T00:00:00.000Z",
  endDate: "2027-04-30T00:00:00.000Z",
});

function mockApi(seasons: SeasonPayload[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/seasons")) return Response.json(seasons);
      throw new Error(`unexpected request: ${url}`);
    }),
  );
}

function renderPage() {
  return render(
    <ClubTimeProvider zone="Pacific/Auckland">
      <SeasonsPage />
    </ClubTimeProvider>,
  );
}

afterEach(() => {
  cleanup();
  mocks.canEdit = true;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
});

describe("Seasons page: the windows in order, with their holes", () => {
  it("orders the windows chronologically, whatever order the API returned", async () => {
    mockApi([SUMMER, season()]);
    renderPage();

    await screen.findByRole("heading", { name: "Winter 2026" });
    const names = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(names).toEqual(["Winter 2026", "Summer 2026-27"]);
  });

  it("marks the nights nothing prices, between the two windows either side", async () => {
    mockApi([season(), SUMMER]);
    renderPage();

    await screen.findByText(/No season covers 1 Oct 2026 to 30 Nov 2026 — 61 nights/);
    expect(
      screen.getByText(/There is a gap in the season schedule\./),
    ).toBeInTheDocument();
    // It warns; it never prices. Nothing on this page invents coverage.
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
  });

  it("takes today from the CLUB's persisted zone, not the environment's and not the host's", async () => {
    /*
      A hole wholly in the past is dropped, so which day "today" is decides
      which holes an officer is shown — and this page is `"use client"`, where
      the wrong answer is the viewer's own clock (`INV-DATE-019`).

      Asserting that against the default `Pacific/Auckland` wrapper proves
      nothing: under test `APP_TIME_ZONE` resolves to that same zone, so a
      provider-blind implementation gives the identical answer. `divergentClubZone`
      picks a club zone whose today differs from BOTH wrong answers and hands
      back all three, so the fixtures below can be built one day either side of
      the right one.

      Both directions are checked, because a wrong calendar day is at most one
      day out and could be out in either direction:

        - a hole whose last night IS the club's today must be shown — an
          implementation answering a LATER day would drop it;
        - a hole whose last night is the day BEFORE must not be — an
          implementation answering an EARLIER day would show it.
    */
    // The 10:00-11:00 UTC hour is the only window in which three calendar days
    // exist at once, which is what lets the helper find a third zone at all.
    vi.setSystemTime(new Date("2026-07-01T10:30:00.000Z"));
    const { zone, expected, environmentAnswer, hostAnswer } = divergentClubZone(
      (candidate) => clubToday(candidate),
    );
    expect(expected).not.toBe(environmentAnswer);
    expect(expected).not.toBe(hostAnswer);

    const at = (days: number) => addCalendarDays(expected, days);

    // Hole = [today - 1, today]. Reported: its last night is today.
    mockApi([
      season({ id: "before", name: "Before", startDate: at(-10), endDate: at(-2) }),
      season({ id: "after", name: "After", startDate: at(1), endDate: at(10) }),
    ]);
    const straddling = render(
      <ClubTimeProvider zone={zone}>
        <SeasonsPage />
      </ClubTimeProvider>,
    );
    await screen.findByRole("heading", { name: "Before" });
    expect(screen.getByText(/No season covers/)).toBeInTheDocument();
    straddling.unmount();

    // Hole = [today - 2, today - 1]. Dropped: it ended yesterday.
    mockApi([
      season({ id: "before", name: "Before", startDate: at(-10), endDate: at(-3) }),
      season({ id: "after", name: "After", startDate: at(0), endDate: at(10) }),
    ]);
    render(
      <ClubTimeProvider zone={zone}>
        <SeasonsPage />
      </ClubTimeProvider>,
    );
    await screen.findByRole("heading", { name: "Before" });
    expect(screen.queryByText(/No season covers/)).not.toBeInTheDocument();
  });

  it("lists a window whose dates it cannot read, and judges it by nothing", async () => {
    mockApi([
      season(),
      season({ id: "broken", name: "Mystery", endDate: "" }),
      SUMMER,
    ]);
    renderPage();

    await screen.findByRole("heading", { name: "Mystery" });
    // One hole — the real one between winter and summer. The unreadable window
    // neither closes it nor adds another.
    expect(
      screen.getAllByText(/No season covers/),
    ).toHaveLength(1);
    // And it is listed LAST, after the timeline it took no part in.
    const names = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(names).toEqual(["Winter 2026", "Summer 2026-27", "Mystery"]);
  });
});

describe("Seasons page: navigable without seeing it", () => {
  it("gives every season card a heading, so the schedule has an outline", async () => {
    // Without this the page is an <h1> and then a headingless run of cards with
    // gap notices interleaved — and a heading list is one of the two main ways
    // an assistive-technology user moves around a page.
    mockApi([season(), SUMMER]);
    renderPage();

    await screen.findByRole("heading", { name: "Winter 2026" });
    expect(screen.getByRole("heading", { level: 1, name: "Seasons" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Summer 2026-27" }),
    ).toBeInTheDocument();
  });

  it("names each card's buttons after its season", async () => {
    // Two seasons gave six buttons reading "Deactivate", "Edit window",
    // "Delete", "Deactivate", "Edit window", "Delete". `getAllByRole` finding
    // exactly one of each name below is the whole point: before this, the
    // ambiguity was the officer's problem too.
    mockApi([season(), SUMMER]);
    renderPage();

    await screen.findByRole("heading", { name: "Winter 2026" });
    for (const name of [
      "Deactivate Winter 2026",
      "Edit window of Winter 2026",
      "Delete Winter 2026",
      "Deactivate Summer 2026-27",
      "Edit window of Summer 2026-27",
      "Delete Summer 2026-27",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("keeps the visible label at the start of each accessible name", async () => {
    // WCAG 2.5.3: a voice-control user says what they can see. An aria-label
    // that replaced the visible text rather than extending it would break that.
    mockApi([season({ active: false })]);
    renderPage();

    const button = await screen.findByRole("button", {
      name: "Activate Winter 2026",
    });
    expect(button).toHaveTextContent("Activate");
  });

  it("shows a view-only admin the banner and no enabled controls", async () => {
    mocks.canEdit = false;
    mockApi([season()]);
    renderPage();

    await screen.findByRole("heading", { name: "Winter 2026" });
    expect(screen.getByTestId("admin-view-only-banner")).toHaveTextContent(
      /view-only access/i,
    );
    expect(
      screen.queryByRole("button", { name: /Delete Winter 2026/ }),
    ).not.toBeInTheDocument();
  });
});
