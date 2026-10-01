// @vitest-environment jsdom

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import {
  CLUB_TIME_TEST_ZONE,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { BookingCalendar } from "@/components/booking-calendar";
import {
  LODGE_CAPACITY_OVERRIDE_FIELD_ID,
  lodgeCapacitySettingsHref,
  useLodgeCapacitySettingsHref,
} from "@/components/admin/lodge-capacity-settings-link";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

const BOOKINGS_ONLY: AdminPermissionMatrix = {
  overview: "view", bookings: "edit", membership: "none", finance: "none",
  lodge: "none", content: "none", support: "none",
};
const session: { matrix: AdminPermissionMatrix } = { matrix: BOOKINGS_ONLY };

// The census's two matchers: a settings-link prop given any value form, and a
// spread into either component, which could carry one unseen.
const PROP = /\b(?:lodgeSettingsHref|settingsHref)\s*=\s*[{"']/;
const SPREAD_INTO = /<(?:BookingCalendar|LodgeNotSetUpNotice)\b[^]*?\{\s*\.\.\.[^]*?\/>/;
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "officer-1", adminPermissionMatrix: session.matrix } },
    status: "authenticated",
  }),
}));
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { LODGE_NOT_SET_UP_FOR_BOOKINGS_MESSAGE } from "@/lib/lodge-booking-readiness";

/*
  #3407 (owner decision 14 Sep 2026): at a lodge nobody has given a capacity the
  availability route resolves 0 (`unconfigured_lodge`), and since #2930 the grid
  reads that real zero — so every arrival night used to say "Waitlist", inviting
  a member onto a queue the create route refuses before reaching it (a party of
  one already exceeds a limit of zero). The calendar now says the lodge is not
  set up yet and offers no night; a configured lodge is unchanged.

  Fixtures are relative to the CLUB's day, as in the sibling calendar suites.
*/
const clubToday = bindClubTime(requireClubTimeZone(CLUB_TIME_TEST_ZONE), CLUB_FORMAT_TEST).today();
const [clubYear, clubMonth, clubDay] = clubToday.split("-").map(Number);
const now = new Date(clubYear, clubMonth - 1, clubDay);

const DAY = 12;

function labelPrefix(day: number) {
  return new Date(now.getFullYear(), now.getMonth() + 1, day).toLocaleDateString(
    CLUB_FORMAT_TEST.locale,
    { weekday: "long", day: "numeric", month: "long", year: "numeric" },
  );
}

function monthHeading() {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toLocaleDateString(
    CLUB_FORMAT_TEST.locale,
    { month: "long", year: "numeric" },
  );
}

function dayButton(day: number) {
  const prefix = labelPrefix(day);
  return screen.getByRole("button", {
    name: (accessibleName: string) => accessibleName.startsWith(prefix),
  }) as HTMLButtonElement;
}

async function nextMonth() {
  fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  await waitFor(() => expect(screen.getByText(monthHeading())).toBeTruthy());
}

function serveCapacity(lodgeCapacity: number, occupied: Record<string, number> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ lodgeCapacity, availability: occupied, seasons: {} }),
    })),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("a lodge with no capacity says it is not set up yet (#3407)", () => {
  it.each([
    ["member", false],
    ["officer on /admin/book", true],
  ])("offers the %s no night, and neither Waitlist nor Full", async (_who, allowFullDates) => {
    serveCapacity(0);
    const onDateSelect = vi.fn();
    render(
      <BookingCalendar onDateSelect={onDateSelect} allowFullDates={allowFullDates} />,
    );
    await nextMonth();

    await waitFor(() =>
      expect(screen.getByTestId("lodge-not-set-up").textContent).toContain(
        LODGE_NOT_SET_UP_FOR_BOOKINGS_MESSAGE,
      ),
    );
    const button = dayButton(DAY);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-label")).toContain(
      "lodge not set up for bookings yet",
    );
    expect(button.getAttribute("aria-label")).not.toMatch(/full|waitlist/i);
    expect(screen.queryByText("Waitlist")).toBeNull();
    expect(screen.queryByText("Full")).toBeNull();
    // Nor does the grid still explain how to reach the waitlist.
    expect(screen.queryByText(/offered the\s+waitlist/)).toBeNull();

    fireEvent.click(button);
    expect(onDateSelect).not.toHaveBeenCalled();
  });

  it("leaves a configured lodge's full night as the waitlist door it was", async () => {
    const d = new Date(now.getFullYear(), now.getMonth() + 1, DAY);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(DAY).padStart(2, "0")}`;
    serveCapacity(20, { [iso]: 20 });
    render(<BookingCalendar onDateSelect={() => {}} />);
    await nextMonth();

    await waitFor(() => {
      const button = dayButton(DAY);
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(button.getAttribute("aria-label")).toContain("full — waitlist only");
    });
    expect(screen.getByTestId("lodge-not-set-up").textContent).toBe("");
  });

  it("does not claim 'not set up' before the capacity has loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    render(<BookingCalendar onDateSelect={() => {}} />);
    await nextMonth();

    const button = dayButton(DAY);
    expect(button.getAttribute("aria-label")).toContain("availability not loaded");
    expect(screen.getByTestId("lodge-not-set-up").textContent).toBe("");
  });
});

describe("the not-set-up notice links an officer to the capacity settings (#3407)", () => {
  it("links /admin/book's calendar to the lodge hub's capacity field", async () => {
    serveCapacity(0);
    render(
      <BookingCalendar
        onDateSelect={() => {}}
        lodgeId="lodge 2"
        allowFullDates
        lodgeSettingsHref={lodgeCapacitySettingsHref("lodge 2")}
      />,
    );
    await nextMonth();

    const link = await screen.findByRole("link", { name: "Set this lodge's capacity" });
    expect(link.getAttribute("href")).toBe(
      `/admin/lodges/lodge%202#${LODGE_CAPACITY_OVERRIDE_FIELD_ID}`,
    );
    expect(lodgeCapacitySettingsHref(null)).toBe("/admin/lodges");
  });

  it("shows the member calendar the notice with no link", async () => {
    serveCapacity(0);
    render(<BookingCalendar onDateSelect={() => {}} />);
    await nextMonth();

    await waitFor(() =>
      expect(screen.getByTestId("lodge-not-set-up").textContent).toContain(
        LODGE_NOT_SET_UP_FOR_BOOKINGS_MESSAGE,
      ),
    );
    expect(screen.queryByRole("link")).toBeNull();
  });

  it.each([
    ["can view the lodge area", "view", "/admin/lodges/lodge-2#lodge-capacity-override"],
    ["can edit the lodge area", "edit", "/admin/lodges/lodge-2#lodge-capacity-override"],
    ["has no lodge-area access", "none", undefined],
  ] as const)("hands /admin/book a link only to an officer who %s", (_label, lodge, expected) => {
    session.matrix = { ...BOOKINGS_ONLY, lodge };
    const { result } = renderHook(() => useLodgeCapacitySettingsHref("lodge-2"));
    expect(result.current).toBe(expected);
  });

  it("is passed only by the admin booking page, never a member or public surface", () => {
    // Disk census over comment-stripped source: every production file that
    // hands the calendar or the notice a settings link, whether as an
    // expression, a string literal, or through a spread. The member calendar
    // (/book) and the public request and school forms render the same notice,
    // and a link there would be wrong.
    const passers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const source = stripComments(readFileSync(full, "utf8"));
          if (PROP.test(source) || SPREAD_INTO.test(source)) {
            passers.push(relative(process.cwd(), full).split("\\").join("/"));
          }
        }
      }
    };
    walk(join(process.cwd(), "src"));
    expect(passers.sort()).toEqual([
      "src/app/(admin)/admin/book/page.tsx",
      "src/components/booking-calendar.tsx",
    ]);
    // And /admin/book passes the access-gated link, not a bare href.
    const adminBook = stripComments(
      readFileSync(join(process.cwd(), "src/app/(admin)/admin/book/page.tsx"), "utf8"),
    );
    expect(adminBook).toMatch(/\buseLodgeCapacitySettingsHref\(lodgeId\)/);
    expect(adminBook).not.toMatch(/\blodgeCapacitySettingsHref\(/);
  });

  it("would catch a string-literal prop, a spread, and not a commented-out one", () => {
    expect(PROP.test(stripComments(`<BookingCalendar lodgeSettingsHref="/admin/lodges" />`))).toBe(true);
    expect(SPREAD_INTO.test(stripComments(`<LodgeNotSetUpNotice show {...props} />`))).toBe(true);
    expect(PROP.test(stripComments("// lodgeSettingsHref={x}\nconst a = 1;"))).toBe(false);
  });
});
