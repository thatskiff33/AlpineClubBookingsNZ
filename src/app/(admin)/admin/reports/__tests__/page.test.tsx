// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ name: "Test Club", bookingsName: "Bookings" }),
}));

let lodgeOptions: {
  lodges: Array<{ id: string; name: string }>;
  loading: boolean;
  failed?: boolean;
  forbidden?: boolean;
};
vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => lodgeOptions,
}));

beforeEach(() => {
  lodgeOptions = {
    lodges: [
      { id: "lodge-1", name: "Lodge One" },
      { id: "lodge-2", name: "Lodge Two" },
    ],
    loading: false,
    failed: false,
    forbidden: false,
  };
});

import ReportsPage from "@/app/(admin)/admin/reports/page";
import type { ReactNode } from "react";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { APP_TIME_ZONE } from "@/config/operational";
import { getReportsDatasetDefaults } from "@/lib/admin-dataset-reset-state";
import { chooseDivergentClubZone } from "@/lib/__tests__/helpers/club-time-zone";

const EMPTY_REPORT = {
  summary: {
    totalBookings: 0,
    totalRevenueCents: 0,
    netCollectedCents: 0,
    additionalLedgerGapCents: 0,
    additionalLedgerGapBookings: 0,
    outstandingAdditionalCents: 0,
    outstandingAdditionalBookings: 0,
    totalGuests: 0,
    avgOccupancyRate: 0,
    memberGuests: 0,
    nonMemberGuests: 0,
  },
  statusBreakdown: {
    pending: 0,
    paymentPending: 0,
    confirmed: 0,
    paid: 0,
    awaitingReview: 0,
    completed: 0,
  },
  memberStats: {
    totalActiveMembers: 0,
    paidMembers: 0,
    unpaidMembers: 0,
    overdueMembers: 0,
    newMembers: 0,
    currentSeasonYear: 2026,
    currentSeasonLabel: "2026",
  },
  occupancy: [],
  revenueGranularity: "monthly",
  revenue: [],
  trends: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ReportsPage quick ranges", () => {
  it("wraps the full multi-lodge toolbar without changing its keyboard order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(EMPTY_REPORT), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    render(<ReportsPage />);
    const toolbar = await screen.findByRole("group", {
      name: "Report filters and exports",
    });
    const quickRange = screen.getByRole("combobox", { name: "Quick Range" });
    const from = screen.getByLabelText("From");
    const to = screen.getByLabelText("To");
    const lodge = screen.getByDisplayValue("All lodges");
    const deleted = screen.getByDisplayValue("Hide deleted");
    const reset = screen.getByRole("button", { name: /^Reset\./ });
    const update = screen.getByRole("button", { name: "Update" });
    const csv = await screen.findByRole("button", { name: "CSV" });
    const pdf = screen.getByRole("button", { name: "Download PDF" });

    expect(toolbar).toHaveClass("w-full", "flex-wrap");
    expect(reset).toBeDisabled();

    const controls = Array.from(
      toolbar.querySelectorAll<HTMLElement>("input, select, button"),
    );
    expect(controls.indexOf(quickRange)).toBeLessThan(controls.indexOf(from));
    expect(controls.indexOf(from)).toBeLessThan(controls.indexOf(to));
    expect(controls.indexOf(to)).toBeLessThan(controls.indexOf(lodge));
    expect(controls.indexOf(lodge)).toBeLessThan(controls.indexOf(deleted));
    expect(controls.indexOf(deleted)).toBeLessThan(controls.indexOf(reset));
    expect(controls.indexOf(reset)).toBeLessThan(controls.indexOf(update));
    expect(controls.indexOf(update)).toBeLessThan(controls.indexOf(csv));
    expect(controls.indexOf(csv)).toBeLessThan(controls.indexOf(pdf));
  });

  it("preserves lodge and deleted scope when Next Month changes only the dates", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response(JSON.stringify(EMPTY_REPORT), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    render(<ReportsPage />);
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));

    fireEvent.change(screen.getByDisplayValue("All lodges"), {
      target: { value: "lodge-2" },
    });
    fireEvent.change(screen.getByDisplayValue("Hide deleted"), {
      target: { value: "include" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Quick Range" }), {
      target: { value: "next_month" },
    });

    // This file used to `vi.mock("@/lib/date-only")` and pin `getTodayDateOnly`
    // to 2026-04-13, which fixed these bounds at May. The CT-4 review read that
    // mock as DEAD — the reports page itself no longer imports `date-only` —
    // but it was not: `DateRangeControls` calls `getDateRangeForPreset(preset)`
    // with no `today`, so the presets reach `getTodayDateOnly()` one module
    // across. What the mock really did was give this file a SECOND "today"
    // disagreeing with the frozen clock every other suite runs on, which is the
    // reading trap the clock convention exists to remove.
    //
    // So the mock is gone and the window is DERIVED from the zone the presets
    // genuinely read — `APP_TIME_ZONE` — with an independent `Intl` projection
    // rather than through `date-only` itself, which would let the test agree
    // with the code it is checking. Hard-coding August instead would have been
    // a sixth `TZ=America/Denver` failure: behind UTC the frozen instant is
    // still 30 June, so "next month" is July there.
    //
    // That the QUICK RANGES still read the environment rather than the club's
    // persisted zone is a real remaining gap, in `DateRangeControls`
    // (`src/components/**`) — reported on #2870 for the group that owns that
    // file. This test pins today's behaviour honestly rather than asserting the
    // behaviour we want and failing everywhere.
    const [envYear, envMonth] = new Intl.DateTimeFormat("en-CA", {
      timeZone: APP_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .format(new Date())
      .split("-")
      .map(Number);
    const nextYear = envMonth === 12 ? envYear + 1 : envYear;
    const nextMonth = envMonth === 12 ? 1 : envMonth + 1;
    const pad = (value: number) => String(value).padStart(2, "0");
    const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
    const expectedFrom = `${nextYear}-${pad(nextMonth)}-01`;
    const expectedTo = `${nextYear}-${pad(nextMonth)}-${pad(lastDay)}`;

    await waitFor(() => {
      const latest = requests.at(-1);
      expect(latest).toContain(`from=${expectedFrom}`);
      expect(latest).toContain(`to=${expectedTo}`);
      expect(latest).toContain("lodgeId=lodge-2");
      expect(latest).toContain("deleted=include");
    });
  });

  it("renders booked revenue, payment-derived cash, and outstanding additions as distinct figures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ...EMPTY_REPORT,
            summary: {
              ...EMPTY_REPORT.summary,
              totalBookings: 1,
              totalRevenueCents: 33,
              netCollectedCents: 34,
              outstandingAdditionalCents: 13_500,
              outstandingAdditionalBookings: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    render(<ReportsPage />);
    const bookedRevenueCard = (await screen.findByText("Booked Revenue")).closest(
      ".reports-print-card",
    );
    const collectedCashCard = screen
      .getByText("Net Collected Cash")
      .closest(".reports-print-card");
    const outstandingAdditionsCard = screen
      .getByText("Outstanding Additions")
      .closest(".reports-print-card");
    expect(bookedRevenueCard).toHaveTextContent("$0.33");
    expect(collectedCashCard).toHaveTextContent("$0.34");
    expect(outstandingAdditionsCard).toHaveTextContent("$135.00");
    expect(screen.getByText("Booked Revenue by Month")).toBeVisible();
    expect(screen.getByText(/Price allocated to selected stay nights/)).toBeVisible();
  });

  it("exports stay-night booked revenue and collected cash with unambiguous CSV labels", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ...EMPTY_REPORT,
            summary: {
              ...EMPTY_REPORT.summary,
              totalRevenueCents: 10_000,
              netCollectedCents: 7_500,
              additionalLedgerGapCents: 2_100,
              additionalLedgerGapBookings: 1,
              outstandingAdditionalCents: 2_500,
              outstandingAdditionalBookings: 1,
            },
            revenue: [
              {
                periodStart: "2026-04-01",
                periodEnd: "2026-04-30",
                label: "Apr 2026",
                tooltipLabel: "April 2026",
                revenueCents: 10_000,
                bookingCount: 1,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const createObjectUrl = vi.fn<(blob: Blob) => string>(() => "blob:report");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<ReportsPage />);
    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent(
      "Net Collected Cash may understate by $21.00",
    );
    expect(warning).toHaveTextContent(
      "Ask a developer to reconcile that payment's ledger before trusting this figure.",
    );
    expect(warning.closest(".reports-print-root")).not.toBeNull();
    const csvButton = await screen.findByRole("button", { name: "CSV" });
    await waitFor(() => expect(csvButton).toBeEnabled());
    fireEvent.click(csvButton);

    const blob = createObjectUrl.mock.calls[0][0] as Blob;
    const csv = await blob.text();
    expect(csv).toContain("Booked Revenue,100.00");
    expect(csv).toContain("Net Collected Cash,75.00");
    expect(csv).toContain(
      "Net Collected Cash Warning,Net Collected Cash may understate by $21.00",
    );
    expect(csv).toContain("Possible Additional Ledger Gap,21.00");
    expect(csv).toContain("Bookings With An Additional Ledger Gap,1");
    expect(csv).toContain("Outstanding Additions,25.00");
    expect(csv).not.toContain("Outstanding Additional Payments");
    expect(csv).toContain("Booked Revenue by Month");
    expect(csv).toContain("Month,Booked Revenue,Distinct Bookings");
    expect(csv).not.toContain("Booked Revenue Less Outstanding");
  });
});

describe("stale responses never own the screen (#2378 fix round)", () => {
  /**
   * Every filter change refires the report fetch while earlier requests are still
   * in flight, and the figures used to belong to whichever response landed LAST —
   * the mount-time default-range response overwriting a narrowed range's numbers a
   * moment after they rendered. PR #2817's Playwright run caught it as a "wrong
   * cash figure" failure; the fix is the fetch sequence guard in `fetchReports`.
   * This stages exactly that inversion: the FIRST (default-range) response is held
   * back and resolved AFTER the second (narrowed) one.
   */
  it("keeps the latest query's figures when an earlier response lands later", async () => {
    const wideReport = {
      ...EMPTY_REPORT,
      summary: { ...EMPTY_REPORT.summary, totalBookings: 4 },
    };
    const narrowReport = {
      ...EMPTY_REPORT,
      summary: { ...EMPTY_REPORT.summary, totalBookings: 1 },
    };
    let releaseFirst: (() => void) | undefined;
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return new Response(JSON.stringify(wideReport), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(narrowReport), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    render(<ReportsPage />);
    const from = await screen.findByLabelText("From");
    fireEvent.change(from, { target: { value: "2026-03-01" } });

    // The narrowed query's response arrives first and renders its figure.
    const bookingsCard = (await screen.findByText("Total Bookings")).closest(
      ".reports-print-card",
    );
    await waitFor(() => expect(bookingsCard?.textContent).toContain("1"));

    // Now the SUPERSEDED default-range response lands. It must change nothing.
    releaseFirst?.();
    await waitFor(() => expect(call).toBeGreaterThanOrEqual(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bookingsCard?.textContent).toContain("1");
    expect(bookingsCard?.textContent).not.toContain("4");
  });
});

describe("occupancy scope label survives a lost lodge list (#2887)", () => {
  /*
    `/admin/reports` is in the FINANCE area. `FINANCE_ADMIN`, `FINANCE_USER` and
    `ADMIN_MEMBERSHIP` hold no `lodge` entry, so `/api/admin/lodges` is a
    permanent 403 for them — `lodges` comes back empty and `lodges.length > 1`
    is false for exactly the same reason a single-lodge club is false. The
    qualifier then vanished from the occupancy stat card and the chart title,
    and a club-wide figure became indistinguishable from one lodge's.
  */
  afterEach(() => vi.unstubAllGlobals());

  async function renderReports() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => EMPTY_REPORT })),
    );
    render(<ReportsPage />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  }

  it("labels the scope when the lodge list is FORBIDDEN", async () => {
    lodgeOptions = { lodges: [], loading: false, failed: false, forbidden: true };
    await renderReports();
    await waitFor(() =>
      expect(screen.getAllByText(/All lodges/i).length).toBeGreaterThan(0),
    );
  });

  it("labels the scope when the lodge list FAILED", async () => {
    lodgeOptions = { lodges: [], loading: false, failed: true, forbidden: false };
    await renderReports();
    await waitFor(() =>
      expect(screen.getAllByText(/All lodges/i).length).toBeGreaterThan(0),
    );
  });

  it("stays unqualified for a club that really has one lodge (ADR-002)", async () => {
    lodgeOptions = {
      lodges: [{ id: "lodge-1", name: "Lodge One" }],
      loading: false,
      failed: false,
      forbidden: false,
    };
    await renderReports();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByText(/All lodges/i)).toBeNull();
  });
});


/**
 * THE DISCRIMINATING ONE (CT-4, #2870).
 *
 * Everything above renders under the default `CLUB_TIME_TEST_ZONE`, which is
 * deliberately the zone `APP_TIME_ZONE` also resolves to, so the default range
 * is the same either way and none of it proves the provider was consulted.
 *
 * The range is not cosmetic here. `getReportsDatasetDefaults` takes the club's
 * day back three whole months and forward to the end of ITS month, so a day
 * either side of a month boundary moves BOTH bounds by a month — the officer is
 * shown a different quarter's numbers from the one they asked for, with nothing
 * on screen saying so. This file used to carry a `@/lib/date-only` mock pinning
 * "2026-04-13" for exactly this range; the page stopped importing that module,
 * the mock went dead, and the default range lost its only coverage. That mock
 * is now gone and this is what replaces it.
 */
describe("reports default range comes from the club's zone (CT-4, #2870)", () => {
  const dayIn = (zone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      // An independent oracle, not the kernel under test.
    }).format(new Date());

  it("anchors from/to on the PERSISTED club zone's today, not APP_TIME_ZONE's", async () => {
    const chosen = chooseDivergentClubZone({
      subject: "the club's today at the frozen instant",
      answerKey: "day",
      cases: [
        // -6: still 30 June, so the window is 1 Mar .. 30 Jun.
        { zone: "America/Denver", day: "2026-06-30", from: "2026-03-01", to: "2026-06-30" },
        // +14: already 1 July, so it is 1 Apr .. 31 Jul — a different quarter.
        { zone: "Pacific/Kiritimati", day: "2026-07-01", from: "2026-04-01", to: "2026-07-31" },
      ],
      answerFor: dayIn,
      // NOT `["UTC"]` — see the chooser's note on "today" assertions.
    });
    const environmentDay = dayIn(APP_TIME_ZONE);
    // The literals above are hand-written; this cross-checks them against the
    // pure defaults helper so a typo in one of the four cannot pass silently.
    expect(getReportsDatasetDefaults(chosen.day)).toMatchObject({
      from: chosen.from,
      to: chosen.to,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => EMPTY_REPORT })),
    );
    render(<ReportsPage />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ClubTimeProvider zone={chosen.zone}>{children}</ClubTimeProvider>
      ),
    });
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const requested = String(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? "",
    );
    expect(requested).toContain(`from=${chosen.from}`);
    expect(requested).toContain(`to=${chosen.to}`);
    const environmentDefaults = getReportsDatasetDefaults(environmentDay);
    expect(requested).not.toContain(`from=${environmentDefaults.from}`);
  });
});
