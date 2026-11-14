// @vitest-environment jsdom

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import {
  CLUB_TIME_TEST_ZONE,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BookingCalendar } from "@/components/booking-calendar";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";

/*
  #4954: when a month's availability request failed, every night rendered `?`
  (honestly unknown since #2930) but nothing said WHY, and nothing offered a way
  to ask again — a member on a weak signal picked nights blind and learned they
  were full only at submit. The calendar now records each month's load outcome
  for the lodge on screen, says so in an error alert with Try again, and the
  legend explains `?`. Unknown nights stay selectable: the server re-checks
  capacity at submit, so a failed read must never block a booking.

  Fixtures are relative to the CLUB's day, as in the sibling calendar suites.
  Every test works in NEXT month so no night is in the past.
*/
const clubToday = bindClubTime(requireClubTimeZone(CLUB_TIME_TEST_ZONE), CLUB_FORMAT_TEST).today();
const [clubYear, clubMonth, clubDay] = clubToday.split("-").map(Number);
const now = new Date(clubYear, clubMonth - 1, clubDay);

const DAY = 12;
/** The 0-based month the calendar's request names for `offset` months ahead. */
const requestMonth = (offset: number) => (now.getMonth() + offset) % 12;

function monthHeading(offset: number) {
  return new Date(now.getFullYear(), now.getMonth() + offset, 1).toLocaleDateString(
    CLUB_FORMAT_TEST.locale,
    { month: "long", year: "numeric" },
  );
}

function dayButton(day: number) {
  const prefix = new Date(now.getFullYear(), now.getMonth() + 1, day).toLocaleDateString(
    CLUB_FORMAT_TEST.locale,
    { weekday: "long", day: "numeric", month: "long", year: "numeric" },
  );
  return screen.getByRole("button", {
    name: (accessibleName: string) => accessibleName.startsWith(prefix),
  }) as HTMLButtonElement;
}

async function goToMonth(offset: number, direction: "Next" | "Prev" = "Next") {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(direction) }));
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: monthHeading(offset) })).toBeTruthy(),
  );
}

function failureAlert() {
  return screen.queryByRole("alert");
}

type Outcome = "ok" | "refused" | "offline" | "bad-json" | "pending";

function response(outcome: Outcome, month: number) {
  if (outcome === "pending") return new Promise<never>(() => {});
  if (outcome === "offline") return Promise.reject(new TypeError("Failed to fetch"));
  if (outcome === "refused") return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
  if (outcome === "bad-json") {
    return Promise.resolve({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
  }
  return Promise.resolve({
    ok: true,
    json: async () => ({ lodgeCapacity: 20, availability: emptyLodge(month), seasons: {} }),
  });
}

/** Every night of the requested 0-based month, with no bed taken. */
function emptyLodge(month: number): Record<string, number> {
  const year = now.getFullYear() + (month < now.getMonth() ? 1 : 0);
  const days = new Date(year, month + 1, 0).getDate();
  const nights: Record<string, number> = {};
  for (let day = 1; day <= days; day++) {
    nights[`${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`] = 0;
  }
  return nights;
}

/**
 * Serves each request by its month and lodge. `decide` is asked afresh on every
 * call, so a test can change its answer between a failure and Try again.
 */
function serve(decide: (month: number, lodgeId: string | null) => Outcome) {
  const fetchMock = vi.fn((url: string) => {
    const params = new URL(url, "http://localhost").searchParams;
    const month = Number(params.get("month"));
    return response(decide(month, params.get("lodgeId")), month);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("a month whose availability fails to load says so and offers Try again (#4954)", () => {
  it.each<[Outcome]>([["refused"], ["offline"], ["bad-json"]])(
    "raises an announced error alert when the request is %s, and the ? nights stay selectable",
    async (outcome) => {
      serve((month) => (month === requestMonth(1) ? outcome : "ok"));
      const onDateSelect = vi.fn();
      render(<BookingCalendar onDateSelect={onDateSelect} />);
      await goToMonth(1);

      await waitFor(() => expect(failureAlert()).not.toBeNull());
      expect(failureAlert()!.textContent).toContain(
        `Bed availability for ${monthHeading(1)} could not be loaded`,
      );
      expect(failureAlert()!.textContent).toContain("Days marked ? may already be full");
      expect(failureAlert()!.textContent).toContain("Nothing has been booked or charged");

      // Unchanged per-cell wording, and the night is still offered.
      const button = dayButton(DAY);
      expect(button.getAttribute("aria-label")).toContain("availability not loaded");
      expect(button.disabled).toBe(false);
      fireEvent.click(button);
      fireEvent.click(dayButton(DAY + 2));
      expect(onDateSelect).toHaveBeenCalledTimes(1);
    },
  );

  it("Try again asks for the month again and clears the alert once it loads", async () => {
    let nextMonthOutcome: Outcome = "refused";
    const fetchMock = serve((month) => (month === requestMonth(1) ? nextMonthOutcome : "ok"));
    render(<BookingCalendar onDateSelect={vi.fn()} lodgeId="lodge a" />);
    await goToMonth(1);
    await waitFor(() => expect(failureAlert()).not.toBeNull());
    const callsBefore = fetchMock.mock.calls.length;
    const failedUrl = fetchMock.mock.calls[callsBefore - 1]![0];

    nextMonthOutcome = "ok";
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(callsBefore + 1));
    await waitFor(() => expect(dayButton(DAY).getAttribute("aria-label")).not.toContain("not loaded"));
    expect(failureAlert()).toBeNull();
    expect(fetchMock.mock.calls[callsBefore]![0]).toBe(failedUrl);
    expect(failedUrl).toContain("lodgeId=lodge%20a");
    expect(dayButton(DAY).getAttribute("aria-label")).toContain("20 of 20 beds free");
    expect(dayButton(DAY).className).toContain("bg-success-muted");
    // Focus stays in the calendar rather than dropping to the page top.
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: monthHeading(1) }));
  });

  it("a Try again that fails again raises the alert again", async () => {
    const fetchMock = serve((month) => (month === requestMonth(1) ? "offline" : "ok"));
    render(<BookingCalendar onDateSelect={vi.fn()} />);
    await goToMonth(1);
    await waitFor(() => expect(failureAlert()).not.toBeNull());
    const callsBefore = fetchMock.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(callsBefore + 1));
    await waitFor(() => expect(failureAlert()).not.toBeNull());
  });

  it("says the counts may be out of date when a refetch fails over figures already loaded", async () => {
    let nextMonthOutcome: Outcome = "ok";
    const fetchMock = serve((month) => (month === requestMonth(1) ? nextMonthOutcome : "ok"));
    render(<BookingCalendar onDateSelect={vi.fn()} />);
    await goToMonth(1);
    await waitFor(() =>
      expect(dayButton(DAY).getAttribute("aria-label")).toContain("20 of 20 beds free"),
    );
    expect(failureAlert()).toBeNull();

    // Page away and back with the signal gone. Paging back refetches the month,
    // the refetch fails, and the earlier counts are still on the grid.
    nextMonthOutcome = "offline";
    await goToMonth(2);
    const callsBefore = fetchMock.mock.calls.length;
    await goToMonth(1, "Prev");
    await waitFor(() => expect(failureAlert()).not.toBeNull());
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);

    // Not "could not be loaded" and not "days marked ?": there are no ? days, and
    // the member can see figures that are now unconfirmed.
    const text = failureAlert()!.textContent!;
    expect(text).toContain(`Bed availability for ${monthHeading(1)} could not be refreshed`);
    expect(text).toContain("The bed counts shown may be out of date");
    expect(text).toContain("Nothing has been booked or charged");
    expect(text).not.toContain("could not be loaded");
    expect(text).not.toContain("Days marked ?");
    expect(dayButton(DAY).getAttribute("aria-label")).toContain("20 of 20 beds free");

    nextMonthOutcome = "ok";
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(failureAlert()).toBeNull());
    expect(dayButton(DAY).getAttribute("aria-label")).toContain("20 of 20 beds free");
  });

  it("belongs to the month that failed, not the one on screen after paging", async () => {
    serve((month) => (month === requestMonth(1) ? "refused" : "ok"));
    render(<BookingCalendar onDateSelect={vi.fn()} />);
    await goToMonth(1);
    await waitFor(() => expect(failureAlert()).not.toBeNull());

    await goToMonth(2);
    await waitFor(() => expect(failureAlert()).toBeNull());
    await goToMonth(1, "Prev");
    await waitFor(() => expect(failureAlert()?.textContent).toContain(monthHeading(1)));
  });

  it("ignores a late failure for a month the member has already left", async () => {
    let failLate: () => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const month = Number(new URL(url, "http://localhost").searchParams.get("month"));
        if (month !== requestMonth(1)) return response("ok", month);
        return new Promise((_resolve, reject) => {
          failLate = () => reject(new TypeError("Failed to fetch"));
        });
      }),
    );
    render(<BookingCalendar onDateSelect={vi.fn()} />);
    await goToMonth(1);
    await goToMonth(2);

    await act(async () => {
      failLate();
    });

    // Back on the month whose first request failed late: its fresh request is
    // still pending, so an alert here could only be the abandoned run's.
    await goToMonth(1, "Prev");
    expect(failureAlert()).toBeNull();
  });

  it("clears a failure when the lodge changes, and never shows one lodge's failure on another", async () => {
    // Lodge B's request never answers, so nothing about lodge B can clear the
    // alert: only the lodge change itself may. Nor does lodge A's second one.
    let pendingLodgeA = false;
    serve((month, lodgeId) =>
      lodgeId === "lodge-b" || pendingLodgeA
        ? "pending"
        : month === requestMonth(1)
          ? "refused"
          : "ok",
    );
    const { rerender } = render(<BookingCalendar onDateSelect={vi.fn()} lodgeId="lodge-a" />);
    await goToMonth(1);
    await waitFor(() => expect(failureAlert()).not.toBeNull());

    rerender(<BookingCalendar onDateSelect={vi.fn()} lodgeId="lodge-b" />);
    expect(failureAlert()).toBeNull();
    expect(dayButton(DAY).getAttribute("aria-label")).toContain("availability not loaded");

    // Back on lodge A, whose fresh request has not answered yet: the failure
    // recorded before the switch was cleared with it, so no alert stands.
    pendingLodgeA = true;
    rerender(<BookingCalendar onDateSelect={vi.fn()} lodgeId="lodge-a" />);
    expect(failureAlert()).toBeNull();
  });

  it("the legend explains the ? a night shows while its availability is unknown", async () => {
    serve(() => "ok");
    render(<BookingCalendar onDateSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Availability not loaded")).toBeTruthy());
  });

  it("hides the unknown legend when the lodge is not set up", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ lodgeCapacity: 0, availability: {}, seasons: {} }),
    })));
    render(<BookingCalendar onDateSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("lodge-not-set-up").textContent).not.toBe(""));
    expect(screen.queryByText("Availability not loaded")).toBeNull();
  });

  it("the officer calendar on /admin/book shows the same alert", async () => {
    serve((month) => (month === requestMonth(1) ? "refused" : "ok"));
    render(<BookingCalendar onDateSelect={vi.fn()} allowFullDates />);
    await goToMonth(1);
    await waitFor(() => expect(failureAlert()).not.toBeNull());
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
