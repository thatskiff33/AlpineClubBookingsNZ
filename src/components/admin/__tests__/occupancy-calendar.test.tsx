// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { OccupancyCalendar } from "@/components/admin/occupancy-calendar";

const occupancyResponse = {
  month: "2099-07",
  nights: [
    {
      date: "2099-07-10",
      guestCount: 1,
      bookings: [
        {
          id: "booking-1",
          reference: "BOOKING1",
          ownerName: "Alex Snow",
          checkIn: "2099-07-10",
          checkOut: "2099-07-12",
          guestCount: 1,
          status: "PAID",
        },
      ],
    },
    {
      date: "2099-07-11",
      guestCount: 2,
      bookings: [
        {
          id: "booking-1",
          reference: "BOOKING1",
          ownerName: "Alex Snow",
          checkIn: "2099-07-10",
          checkOut: "2099-07-12",
          guestCount: 2,
          status: "PAID",
        },
      ],
    },
  ],
  bookings: [
    {
      id: "booking-1",
      reference: "BOOKING1",
      ownerName: "Alex Snow",
      checkIn: "2099-07-10",
      checkOut: "2099-07-12",
      guestCount: 2,
      status: "PAID",
    },
  ],
};

const crossMonthResponses = {
  "2099-07": {
    month: "2099-07",
    nights: [
      {
        date: "2099-07-31",
        guestCount: 1,
        bookings: [
          {
            id: "booking-cross",
            reference: "CROSS1",
            ownerName: "Riley Frost",
            checkIn: "2099-07-31",
            checkOut: "2099-08-02",
            guestCount: 1,
            status: "PAID",
          },
        ],
      },
    ],
    bookings: [
      {
        id: "booking-cross",
        reference: "CROSS1",
        ownerName: "Riley Frost",
        checkIn: "2099-07-31",
        checkOut: "2099-08-02",
        guestCount: 2,
        status: "PAID",
      },
    ],
  },
  "2099-08": {
    month: "2099-08",
    nights: [
      {
        date: "2099-08-01",
        guestCount: 1,
        bookings: [
          {
            id: "booking-cross",
            reference: "CROSS1",
            ownerName: "Riley Frost",
            checkIn: "2099-07-31",
            checkOut: "2099-08-02",
            guestCount: 1,
            status: "PAID",
          },
        ],
      },
    ],
    bookings: [
      {
        id: "booking-cross",
        reference: "CROSS1",
        ownerName: "Riley Frost",
        checkIn: "2099-07-31",
        checkOut: "2099-08-02",
        guestCount: 2,
        status: "PAID",
      },
    ],
  },
};

function stubFetchByMonth(
  responses: Record<string, typeof occupancyResponse>,
) {
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    const response = responses[url.searchParams.get("month") ?? ""];
    return {
      ok: Boolean(response),
      json: async () => response,
    };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

function stubFetch() {
  return stubFetchByMonth({ [occupancyResponse.month]: occupancyResponse });
}

function stubFetchWithFirstJulyFailure() {
  let julyAttempts = 0;
  const emptyAugustResponse = {
    month: "2099-08",
    nights: [],
    bookings: [],
  };
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    const month = url.searchParams.get("month");
    if (month === "2099-07") {
      julyAttempts += 1;
      if (julyAttempts === 1) {
        return {
          ok: false,
          json: async () => ({}),
        };
      }
      return {
        ok: true,
        json: async () => occupancyResponse,
      };
    }
    return {
      ok: month === "2099-08",
      json: async () => emptyAugustResponse,
    };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

function stubFetchWithAugustFailure() {
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    const month = url.searchParams.get("month");
    if (month === "2099-07") {
      return {
        ok: true,
        json: async () => occupancyResponse,
      };
    }
    return {
      ok: false,
      json: async () => ({}),
    };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

/**
 * #2887: the heat-map is lodge-scoped and `lodgeId` is a REQUIRED prop, because
 * `GET /api/admin/occupancy` refuses a request that names no lodge. Every
 * harness names one, and the URL assertions below pin the lodge in the query
 * string — this file used to assert the lodgeless URL, which meant it pinned
 * the broken call and went green while the calendar was dead on both pages.
 */
const TEST_LODGE_ID = "lodge-1";

function RangeHarness() {
  const [selection, setSelection] = useState({ startDate: "2099-07-01", endDate: "" });
  return (
    <>
      <output data-testid="range-output">
        {selection.startDate}|{selection.endDate}
      </output>
      <OccupancyCalendar
        mode="range"
        lodgeId={TEST_LODGE_ID}
        selectedStartDate={selection.startDate}
        selectedEndDate={selection.endDate}
        onSelectionChange={setSelection}
      />
    </>
  );
}

function SingleHarness() {
  const [selectedDate, setSelectedDate] = useState("2099-07-01");
  return (
    <>
      <output data-testid="single-output">{selectedDate}</output>
      <OccupancyCalendar
        mode="single"
        lodgeId={TEST_LODGE_ID}
        selectedStartDate={selectedDate}
        selectedEndDate={selectedDate}
        onSelectionChange={({ startDate }) => setSelectedDate(startDate)}
      />
    </>
  );
}

function OverlayHarness({
  onVisibleMonthChange,
}: {
  onVisibleMonthChange?: (month: string) => void;
}) {
  const [selectedDate, setSelectedDate] = useState("2099-07-01");
  return (
    <OccupancyCalendar
      mode="single"
      lodgeId={TEST_LODGE_ID}
      selectedStartDate={selectedDate}
      selectedEndDate={selectedDate}
      onSelectionChange={({ startDate }) => setSelectedDate(startDate)}
      overlayByDate={{ "2099-07-10": { tone: "orange", label: "Needs chores" } }}
      overlayLegend={[
        { tone: "orange", label: "Confirmed — some guests need chores" },
      ]}
      onVisibleMonthChange={onVisibleMonthChange}
    />
  );
}

/**
 * The ROSTER caller: its overlay colours the operational day, so it opts into
 * the sentence that explains the difference from the guest-night panel (#2631).
 */
function OperationalDayOverlayHarness() {
  const [selectedDate, setSelectedDate] = useState("2099-07-01");
  return (
    <OccupancyCalendar
      mode="single"
      lodgeId={TEST_LODGE_ID}
      selectedStartDate={selectedDate}
      selectedEndDate={selectedDate}
      onSelectionChange={({ startDate }) => setSelectedDate(startDate)}
      overlayByDate={{ "2099-07-10": { tone: "orange", label: "Needs chores" } }}
      overlayLegend={[
        { tone: "orange", label: "Confirmed — some guests need chores" },
      ]}
      overlayCountsOperationalDay
    />
  );
}

function VioletRingHarness() {
  const [selectedDate, setSelectedDate] = useState("2099-07-01");
  return (
    <OccupancyCalendar
      mode="single"
      lodgeId={TEST_LODGE_ID}
      selectedStartDate={selectedDate}
      selectedEndDate={selectedDate}
      onSelectionChange={({ startDate }) => setSelectedDate(startDate)}
      overlayByDate={{
        "2099-07-11": { tone: "violet", label: "Smith", emphasis: "ring" },
      }}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("OccupancyCalendar", () => {
  it("asks the route a question it will answer — every read names a lodge (#2887)", async () => {
    // The seam this file used to miss. `GET /api/admin/occupancy` refuses a
    // lodgeless request with 400, and the route's own suite only ever calls it
    // WITH a lodge, so both halves passed while the heat-map was dead on
    // /admin/roster and Hut Leaders. Assert the shape rather than one literal:
    // any read that reaches the network must carry a lodge.
    const fetchMock = stubFetch();
    render(<RangeHarness />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const reads = (fetchMock.mock.calls as Array<[string]>).map(([url]) => url);
    expect(reads.length).toBeGreaterThan(0);
    for (const url of reads) {
      expect(
        new URL(url, "http://localhost").searchParams.get("lodgeId"),
        `occupancy read without a lodge: ${url}`,
      ).toBe(TEST_LODGE_ID);
    }
  });

  it("does not read at all until a lodge is known, and re-reads for a new one (#2887)", async () => {
    // An empty id is the "scope has not settled" case. Firing then would only
    // paint "Occupancy could not be loaded." over an empty grid.
    const fetchMock = stubFetch();
    const { rerender } = render(
      <OccupancyCalendar
        mode="single"
        lodgeId=""
        selectedStartDate="2099-07-01"
        selectedEndDate="2099-07-01"
        onSelectionChange={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByText(/July 2099/i)).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();

    rerender(
      <OccupancyCalendar
        mode="single"
        lodgeId="lodge-b"
        selectedStartDate="2099-07-01"
        selectedEndDate="2099-07-01"
        onSelectionChange={() => undefined}
      />,
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/occupancy?month=2099-07&lodgeId=lodge-b",
      ),
    );
  });

  it("selects a range and shows bookings for the selected nights", async () => {
    const fetchMock = stubFetch();
    render(<RangeHarness />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(`/api/admin/occupancy?month=2099-07&lodgeId=${TEST_LODGE_ID}`),
    );

    fireEvent.click(screen.getByRole("button", { name: /10 Jul.*1 staying overnight/i }));
    expect(screen.getByTestId("range-output")).toHaveTextContent("2099-07-10|");

    fireEvent.click(screen.getByRole("button", { name: /11 Jul.*2 staying overnight/i }));
    expect(screen.getByTestId("range-output")).toHaveTextContent("2099-07-10|2099-07-11");

    expect(screen.getByText("Alex Snow")).toBeInTheDocument();
    expect(screen.getAllByText(/3 guest-nights/i).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/2099-07-10 to 2099-07-12 - 3 guest-nights/i),
    ).toBeInTheDocument();
  });

  it("loads every month needed for a cross-month selected range", async () => {
    const fetchMock = stubFetchByMonth(crossMonthResponses);
    render(<RangeHarness />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(`/api/admin/occupancy?month=2099-07&lodgeId=${TEST_LODGE_ID}`),
    );

    fireEvent.click(screen.getByRole("button", { name: /31 Jul.*1 staying overnight/i }));
    expect(screen.getByTestId("range-output")).toHaveTextContent("2099-07-31|");

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(`/api/admin/occupancy?month=2099-08&lodgeId=${TEST_LODGE_ID}`),
    );
    fireEvent.click(await screen.findByRole("button", { name: /1 Aug.*1 staying overnight/i }));

    expect(screen.getByTestId("range-output")).toHaveTextContent(
      "2099-07-31|2099-08-01",
    );
    expect(screen.getByText("Riley Frost")).toBeInTheDocument();
    expect(screen.getAllByText(/2 guest-nights/i).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/2099-07-31 to 2099-08-02 - 2 guest-nights/i),
    ).toBeInTheDocument();
  });

  it("shows a failed selection state and retries a failed month later", async () => {
    const fetchMock = stubFetchWithFirstJulyFailure();
    render(<RangeHarness />);

    await screen.findByText("Occupancy could not be loaded.");
    expect(
      screen.getByText("Occupancy could not be loaded for this selection."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Loading occupancy for this selection..."),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(`/api/admin/occupancy?month=2099-08&lodgeId=${TEST_LODGE_ID}`),
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => input === `/api/admin/occupancy?month=2099-07&lodgeId=${TEST_LODGE_ID}`,
        ),
      ).toHaveLength(2);
    });

    expect(await screen.findByRole("button", { name: /10 Jul.*1 staying overnight/i }))
      .toBeInTheDocument();
  });

  it("clears a stale error banner when returning to a cached loaded month", async () => {
    stubFetchWithAugustFailure();
    render(<RangeHarness />);

    expect(await screen.findByRole("button", { name: /10 Jul.*1 staying overnight/i }))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    await screen.findByText("Occupancy could not be loaded.");

    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await waitFor(() =>
      expect(screen.queryByText("Occupancy could not be loaded.")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /10 Jul.*1 staying overnight/i }))
      .toBeInTheDocument();
  });

  it("selects one date in single mode", async () => {
    stubFetch();
    render(<SingleHarness />);

    await screen.findByRole("button", { name: /11 Jul.*2 staying overnight/i });
    fireEvent.click(screen.getByRole("button", { name: /11 Jul.*2 staying overnight/i }));

    expect(screen.getByTestId("single-output")).toHaveTextContent("2099-07-11");
    expect(screen.getByText(/2099-07-11 to 2099-07-11/i)).toBeInTheDocument();
    expect(screen.getByText("Alex Snow")).toBeInTheDocument();
  });

  it("applies the overlay tone class, aria-label, and badge to a day cell", async () => {
    stubFetch();
    render(<OverlayHarness />);

    const dayButton = await screen.findByRole("button", {
      name: /10 Jul.*Needs chores/i,
    });
    // Overlay tone/emphasis are exposed as stable data attributes (the token
    // class strings may be re-tinted by the "Restrained Alpine" restyle).
    expect(dayButton).toHaveAttribute("data-overlay-tone", "orange");
    expect(dayButton).toHaveAttribute("data-overlay-emphasis", "fill");
    // The "orange" tone now renders on the semantic info tokens; its muted fill
    // paints over the guest-gold tint.
    expect(dayButton.className).toContain("bg-info-muted");
    expect(dayButton.className).not.toContain("bg-brand-gold/10");
    // aria-label keeps the existing guest label and appends the overlay label.
    expect(dayButton.getAttribute("aria-label")).toMatch(/1 staying overnight, Needs chores$/);
    // Compact overlay badge renders the label as visible text.
    expect(screen.getByText("Needs chores")).toBeInTheDocument();
  });

  it("renders the overlay legend entries", async () => {
    stubFetch();
    render(<OverlayHarness />);

    await screen.findByRole("button", { name: /10 Jul.*Needs chores/i });
    expect(
      screen.getByText("Confirmed — some guests need chores"),
    ).toBeInTheDocument();
  });

  it("fires onVisibleMonthChange with the visible month on mount and navigation", async () => {
    stubFetch();
    const onVisibleMonthChange = vi.fn();
    render(<OverlayHarness onVisibleMonthChange={onVisibleMonthChange} />);

    await waitFor(() =>
      expect(onVisibleMonthChange).toHaveBeenCalledWith("2099-07"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    await waitFor(() =>
      expect(onVisibleMonthChange).toHaveBeenCalledWith("2099-08"),
    );
  });

  it("paints a ring-emphasis violet overlay as a low-emphasis outline, not a solid fill", async () => {
    stubFetch();
    render(<VioletRingHarness />);

    const dayButton = await screen.findByRole("button", {
      name: /11 Jul.*Smith/i,
    });
    // Ring variant: a low-emphasis inset outline over a card cell, never a solid
    // tint. Emphasis is asserted via the stable data attribute; the ring is drawn
    // with the semantic tokens rather than a hardcoded hue.
    expect(dayButton).toHaveAttribute("data-overlay-emphasis", "ring");
    expect(dayButton.className).toContain("ring-inset");
    expect(dayButton.className).toContain("bg-card");
    // Badge still renders the label.
    expect(screen.getByText("Smith")).toBeInTheDocument();
  });

  it("leaves day cells, aria-labels, and badges unchanged with no overlay props", async () => {
    stubFetch();
    render(<SingleHarness />);

    const dayButton = await screen.findByRole("button", {
      name: /10 Jul.*1 staying overnight/i,
    });
    // No overlay label appended; aria-label ends at the guest count.
    expect(dayButton.getAttribute("aria-label")).toMatch(/, 1 staying overnight$/);
    // No overlay data attributes when no overlay prop is supplied.
    expect(dayButton).not.toHaveAttribute("data-overlay-tone");
    // Guest cells use a directly gated card pair with a brand border; no
    // interpolated text-bearing tint or overlay tone token leaks in.
    expect(dayButton.className).toContain("bg-card");
    expect(dayButton.className).toContain("text-card-foreground");
    expect(dayButton.className).not.toContain("bg-brand-gold/10");
    expect(dayButton.className).not.toContain("bg-info-muted");
  });

  // -------------------------------------------------------------------------
  // #2631: the day cell says WHICH number it is reading out, and the
  // operational-day explainer belongs only to the overlay that is one
  // -------------------------------------------------------------------------

  it("names the unit in the accessible day label, so a colour cannot contradict it", async () => {
    stubFetch();
    render(<OperationalDayOverlayHarness />);

    // A day with nobody sleeping there. The overlay beside it can still say a
    // roster is needed (a checkout morning), so a bare "No guests" read out
    // next to "Needs roster" was a flat contradiction for a screen-reader user.
    const emptyDay = await screen.findByRole("button", {
      // Anchored: every empty day in the month carries this label.
      name: /^\w+, 9 Jul, No overnight guests$/,
    });
    expect(emptyDay.getAttribute("aria-label")).toContain(
      "No overnight guests",
    );
    expect(emptyDay.getAttribute("aria-label")).not.toMatch(/No guests\b/);

    const busyDay = screen.getByRole("button", {
      name: /11 Jul.*2 staying overnight/i,
    });
    expect(busyDay.getAttribute("aria-label")).not.toMatch(/\d guests?\b/);
  });

  it("explains the two units only for an overlay that counts the operational day", async () => {
    stubFetch();
    render(<OperationalDayOverlayHarness />);

    await screen.findByRole("button", { name: /10 Jul.*Needs chores/i });
    expect(
      screen.getByText(/The day colours above count who is in the lodge/i),
    ).toBeInTheDocument();
  });

  it("stays silent for a NIGHT-based overlay, which the sentence would misdescribe", async () => {
    // The hut-leader assignment calendar passes an overlay legend but paints
    // hut-leader COVERAGE, which is night-based and fenced. Gating the sentence
    // on "an overlay exists" put a false statement under that calendar.
    stubFetch();
    render(<OverlayHarness />);

    await screen.findByRole("button", { name: /10 Jul.*Needs chores/i });
    // The legend still renders — only the operational-day explainer is absent.
    expect(
      screen.getByText("Confirmed — some guests need chores"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/The day colours above count who is in the lodge/i),
    ).toBeNull();
  });
});
