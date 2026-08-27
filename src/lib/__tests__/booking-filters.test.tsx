// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingFilters } from "@/components/admin/booking-filters";

/*
 * Fixed date fixtures, NOT "today" (#3123). These values are only ever written
 * into a URL query string and read back out of an input — `BookingFilters`
 * takes the club's year from `ClubTimeProvider` (`clubTime.today()`) and never
 * compares a filter bound against today — so the suite has no reason to consult
 * a clock at all. The particular day is arbitrary; it is the frozen clock's
 * Auckland day, so every assertion below keeps the exact string it had.
 */
const FILTER_DAY = "2026-07-01";
const FILTER_DAY_PLUS_14 = "2026-07-15";
const FILTER_DAY_PLUS_30 = "2026-07-31";

const mocks = vi.hoisted(() => ({
  currentSearch: "",
  routerPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: mocks.routerPush,
  }),
  useSearchParams: () => new URLSearchParams(mocks.currentSearch),
}));

function pushedBookingsUrl() {
  const pushedPath = mocks.routerPush.mock.calls.at(-1)?.[0] as string;
  return new URL(pushedPath, "http://localhost");
}

function setLocation(search: string) {
  window.history.replaceState(
    {},
    "",
    search ? `/admin/bookings?${search}` : "/admin/bookings",
  );
}

describe("BookingFilters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentSearch = "";
    setLocation("");
  });

  it("hides the bed-state filter and drops stale bed params when bed allocation is disabled", async () => {
    mocks.currentSearch = "status=PAID&bedState=unallocated&search=Aroha";
    setLocation(mocks.currentSearch);

    render(<BookingFilters showBedAllocation={false} />);

    expect(screen.queryByText("Beds")).toBeNull();

    // Filters apply automatically (debounced); the stale bedState param is
    // dropped without any Filter button click.
    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());

    const url = pushedBookingsUrl();
    expect(url.pathname).toBe("/admin/bookings");
    expect(url.searchParams.get("status")).toBe("PAID");
    expect(url.searchParams.get("search")).toBe("Aroha");
    expect(url.searchParams.has("bedState")).toBe(false);
  });

  it("does not navigate when the URL already matches the filters", async () => {
    mocks.currentSearch = "status=PAID";
    setLocation(mocks.currentSearch);

    render(<BookingFilters />);

    // Give the debounce a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("keeps Reset visible and disabled at the true dataset default", () => {
    render(<BookingFilters />);

    expect((
      screen.getByRole("button", {
        name: /Reset\. Search, filters, sort, and page are already at their defaults\./,
      }) as HTMLButtonElement
    ).disabled).toBe(true);
  });

  it.each([
    ["search-only", "search=Aroha"],
    ["filter-only", "status=PAID"],
    ["sort-only", "sortBy=member&sortDir=asc"],
    ["page-only", "page=2"],
    ["combined", "status=PAID&sortBy=member&sortDir=desc&page=3"],
  ])("enables Reset for %s dataset state", (_label, query) => {
    mocks.currentSearch = query;
    setLocation(query);

    render(<BookingFilters />);

    expect((screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("resets the whole dataset while preserving lodge and unknown context keys", () => {
    const query =
      "lodgeId=lodge-2&futureContext=keep&search=Aroha&status=PAID&consentState=waiting&upcoming=7&sortBy=member&sortDir=desc&page=3";
    mocks.currentSearch = query;
    setLocation(query);

    render(
      <BookingFilters
        lodgeOptions={[
          { id: "lodge-1", name: "North" },
          { id: "lodge-2", name: "South" },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    const url = pushedBookingsUrl();
    expect(url.searchParams.get("lodgeId")).toBe("lodge-2");
    expect(url.searchParams.get("futureContext")).toBe("keep");
    for (const key of [
      "search",
      "status",
      "consentState",
      "upcoming",
      "sortBy",
      "sortDir",
      "page",
    ]) {
      expect(url.searchParams.has(key)).toBe(false);
    }
  });

  it("preserves the dashboard upcoming check-ins deep link", async () => {
    mocks.currentSearch = "upcoming=7";
    setLocation(mocks.currentSearch);

    render(<BookingFilters />);

    // Regression guard for the debounced auto-apply effect: the dashboard link
    // must keep upcoming=7 instead of pushing /admin/bookings after load.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("renders comma-separated dashboard status deep links as the active state", async () => {
    mocks.currentSearch = "status=PAYMENT_PENDING,CONFIRMED,PAID,PENDING";
    setLocation(mocks.currentSearch);

    render(<BookingFilters />);

    expect(
      screen.getByText("Payment Pending + Confirmed (Unpaid) + Paid + Pending"),
    ).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("seeds legacy from/to into checkInFrom/checkOutTo, matching the server semantics (#1720)", async () => {
    // Server-side, legacy `from` bounds check-IN and legacy `to` bounds
    // check-OUT (admin-bookings-service). Seeding must match, so the URL
    // rewrite keeps the legacy link's result set.
    const legacyFrom = FILTER_DAY;
    const legacyTo = FILTER_DAY_PLUS_14;
    mocks.currentSearch = `from=${legacyFrom}&to=${legacyTo}`;
    setLocation(mocks.currentSearch);

    render(<BookingFilters />);

    expect((screen.getByLabelText("Check In From") as HTMLInputElement).value).toBe(legacyFrom);
    expect((screen.getByLabelText("Check In To") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Check Out To") as HTMLInputElement).value).toBe(legacyTo);

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    const url = pushedBookingsUrl();
    expect(url.searchParams.get("checkInFrom")).toBe(legacyFrom);
    expect(url.searchParams.get("checkOutTo")).toBe(legacyTo);
    expect(url.searchParams.has("checkInTo")).toBe(false);
    expect(url.searchParams.has("from")).toBe(false);
    expect(url.searchParams.has("to")).toBe(false);
  });

  it("ignores legacy to when an explicit checkInTo is present, matching the server precedence", async () => {
    // admin-bookings-service drops legacy `to` whenever an explicit
    // checkInTo/checkOutTo param exists, so seeding it here would add a
    // check-out bound the server never applied.
    const checkInTo = FILTER_DAY;
    const legacyTo = FILTER_DAY_PLUS_30;
    mocks.currentSearch = `checkInTo=${checkInTo}&to=${legacyTo}`;
    setLocation(mocks.currentSearch);

    render(<BookingFilters />);

    expect((screen.getByLabelText("Check In To") as HTMLInputElement).value).toBe(checkInTo);
    expect((screen.getByLabelText("Check Out To") as HTMLInputElement).value).toBe("");

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    const url = pushedBookingsUrl();
    expect(url.searchParams.get("checkInTo")).toBe(checkInTo);
    expect(url.searchParams.has("checkOutTo")).toBe(false);
    expect(url.searchParams.has("to")).toBe(false);
  });

  it("keeps an explicit checkOutTo over legacy to", async () => {
    const checkOutTo = FILTER_DAY;
    const legacyTo = FILTER_DAY_PLUS_30;
    mocks.currentSearch = `checkOutTo=${checkOutTo}&to=${legacyTo}`;
    setLocation(mocks.currentSearch);

    render(<BookingFilters />);

    expect((screen.getByLabelText("Check Out To") as HTMLInputElement).value).toBe(checkOutTo);

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    const url = pushedBookingsUrl();
    expect(url.searchParams.get("checkOutTo")).toBe(checkOutTo);
    expect(url.searchParams.has("to")).toBe(false);
  });

  it("preserves page across a pure legacy→canonical rewrite (#1732)", async () => {
    // A paginated legacy bookmark encodes the SAME result set the canonical
    // params do, so rewriting the param names must keep the user's place.
    const legacyFrom = FILTER_DAY;
    const legacyTo = FILTER_DAY_PLUS_14;
    mocks.currentSearch = `from=${legacyFrom}&to=${legacyTo}&page=3`;
    setLocation(mocks.currentSearch);

    render(<BookingFilters />);

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    const url = pushedBookingsUrl();
    expect(url.searchParams.get("checkInFrom")).toBe(legacyFrom);
    expect(url.searchParams.get("checkOutTo")).toBe(legacyTo);
    expect(url.searchParams.has("from")).toBe(false);
    expect(url.searchParams.has("to")).toBe(false);
    expect(url.searchParams.get("page")).toBe("3");
  });

  it("resets to page 1 when a filter actually changes", async () => {
    // A real filter change means a different result set — page 3 of the old
    // one is meaningless, so the rewrite drops the page param.
    const checkInFrom = FILTER_DAY;
    mocks.currentSearch = `checkInFrom=${checkInFrom}&page=3`;
    setLocation(mocks.currentSearch);

    render(<BookingFilters />);

    // The canonical paginated URL is already a no-op (page preserved by not
    // navigating at all).
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(mocks.routerPush).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("Name or email..."), {
      target: { value: "Aroha" },
    });

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    const url = pushedBookingsUrl();
    expect(url.searchParams.get("search")).toBe("Aroha");
    expect(url.searchParams.get("checkInFrom")).toBe(checkInFrom);
    expect(url.searchParams.has("page")).toBe(false);
  });

  it("does not re-attach a stale page after a change-then-revert (#1738)", async () => {
    // The change-then-revert trap: change a filter (page drops), paginate the
    // NEW result set to page 2, then revert the filter to the seeded value.
    // The reverted state equals the mount snapshot, so without the divergence
    // latch it would be treated as a pure rewrite and re-attach page 2 — a
    // stale page from a different result set.
    const checkInFrom = FILTER_DAY;
    mocks.currentSearch = `checkInFrom=${checkInFrom}&page=3`;
    setLocation(mocks.currentSearch);

    render(<BookingFilters />);

    // Real filter change: page must be dropped.
    fireEvent.change(screen.getByPlaceholderText("Name or email..."), {
      target: { value: "Aroha" },
    });
    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    expect(pushedBookingsUrl().searchParams.has("page")).toBe(false);

    // The new result set is now shown and the user paginates it to page 2.
    setLocation(`checkInFrom=${checkInFrom}&search=Aroha&page=2`);
    mocks.routerPush.mockClear();

    // Revert the search back to empty (state now equals the mount snapshot).
    fireEvent.change(screen.getByPlaceholderText("Name or email..."), {
      target: { value: "" },
    });
    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());

    const url = pushedBookingsUrl();
    expect(url.searchParams.get("checkInFrom")).toBe(checkInFrom);
    expect(url.searchParams.has("search")).toBe(false);
    // The stale page 2 from the search=Aroha result set must NOT ride along.
    expect(url.searchParams.has("page")).toBe(false);
  });

  it("does not rewrite an asc-default column's desc sort or drop its page (#1738)", async () => {
    // member/status default to asc server-side, so an explicit sortDir=desc is
    // a real user choice from a sort-header click. The filter auto-apply must
    // not canonicalise it away (which would both flip it back to asc and strip
    // the page ~350ms after landing).
    mocks.currentSearch = "sortBy=member&sortDir=desc&page=2";
    setLocation(mocks.currentSearch);

    render(<BookingFilters />);

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Either no push (preferred — sort/page are not the filter component's to
    // touch) or a push that keeps sortDir=desc AND page=2.
    if (mocks.routerPush.mock.calls.length > 0) {
      const url = pushedBookingsUrl();
      expect(url.searchParams.get("sortBy")).toBe("member");
      expect(url.searchParams.get("sortDir")).toBe("desc");
      expect(url.searchParams.get("page")).toBe("2");
    }
  });

  it("carries the sort verbatim through a legacy→canonical rewrite (#1738)", async () => {
    // A bookmarked legacy link that also pins a desc sort must keep that sort
    // (no asc flip) and its page while the param names are rewritten.
    const legacyFrom = FILTER_DAY;
    const legacyTo = FILTER_DAY_PLUS_14;
    mocks.currentSearch = `from=${legacyFrom}&to=${legacyTo}&sortBy=member&sortDir=desc&page=3`;
    setLocation(mocks.currentSearch);

    render(<BookingFilters />);

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    const url = pushedBookingsUrl();
    expect(url.searchParams.get("checkInFrom")).toBe(legacyFrom);
    expect(url.searchParams.get("checkOutTo")).toBe(legacyTo);
    expect(url.searchParams.has("from")).toBe(false);
    expect(url.searchParams.has("to")).toBe(false);
    expect(url.searchParams.get("sortBy")).toBe("member");
    expect(url.searchParams.get("sortDir")).toBe("desc");
    expect(url.searchParams.get("page")).toBe("3");
  });

  it("navigates when the search input changes", async () => {
    mocks.currentSearch = "";
    setLocation("");

    render(<BookingFilters />);

    fireEvent.change(screen.getByPlaceholderText("Name or email..."), {
      target: { value: "Aroha" },
    });

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    const url = pushedBookingsUrl();
    expect(url.searchParams.get("search")).toBe("Aroha");
  });
});
