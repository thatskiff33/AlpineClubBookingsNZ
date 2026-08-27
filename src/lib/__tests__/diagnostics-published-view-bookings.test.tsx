/**
 * THE BOOKINGS LIST PUBLISHES WHAT IT APPLIED, NOT WHAT THE ADDRESS SAYS
 * (#2816, owner decision 13 Aug 2026).
 *
 * This page is the reason the address bar was rejected as the channel:
 * `adminBookingsQuerySchema.safeParse` is TOTAL, so one malformed value drops the
 * ENTIRE filter set back to defaults while the URL still displays every filter.
 * A view read from the address would then tell the model the operator had
 * narrowed a list they are in fact seeing unfiltered.
 *
 * The assertions read the `view` prop the page hands `DiagnosticsViewStatePublisher`
 * rather than rendering it: the publisher renders null by design, and its effect
 * belongs to the client. What is under test here is the page's DERIVATION.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // The club-time delegate. `loadPersistedClubTimeSettings` returns `null`
    // when it is ABSENT, and the page then falls back to the environment — the
    // very defect CT-4 removes, silently, with nothing able to tell. Every test
    // here leaves it resolving `null`, which reproduces the no-row fallback and
    // keeps their expectations unchanged; the zone-authority test supplies a row.
    clubTimeSettings: { findUnique: vi.fn() },
    booking: { findMany: vi.fn(), count: vi.fn() },
    bookingGuest: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    hostingCoverageIncident: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    xeroSyncOperation: { findMany: vi.fn() },
    xeroObjectLink: { findMany: vi.fn() },
    lodge: {
      findMany: vi.fn().mockResolvedValue([{ id: "lodge-1", name: "Lodge" }]),
    },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/components/admin/booking-filters", () => ({
  BookingFilters: () => null,
}));
vi.mock("@/components/admin-booking-calendar", () => ({
  AdminBookingCalendar: () => null,
}));
vi.mock("@/lib/module-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/module-settings")>();
  return {
    ...actual,
    loadEffectiveModuleFlags: vi.fn(),
  };
});

import AdminBookingsPage from "@/app/(admin)/admin/bookings/page";
import { DiagnosticsViewStatePublisher } from "@/components/help-widget/diagnostics-view-state-publisher";
import type { DiagnosticsViewState } from "@/components/help-widget/help-widget-context";
import { getDiagnosticsPageContextRoute } from "@/lib/diagnostics/page-context/registry";
import { buildUnpaidFinishedStaysHref } from "@/lib/unpaid-finished-stays";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

const MODULES_OFF = {
  kiosk: false,
  chores: false,
  financeDashboard: false,
  waitlist: false,
  xeroIntegration: false,
  bedAllocation: false,
  internetBankingPayments: false,
  addressAutocomplete: false,
  groupBookings: false,
  lockers: false,
  induction: false,
  workParties: false,
  promoCodes: false,
  hutLeaders: false,
  communications: false,
  skifieldConditions: false,
  twoFactor: false,
  magicLink: false,
  googleLogin: false,
  analytics: false,
  lobbyDisplay: false,
  aiAssistant: false,
  memberNotices: false,
  eventsCalendar: false,
  memberGuests: false,
  aiDiagnostics: true,
  maintenanceReports: true,
  alpineCentralServer: false,
  commsPortal: false,
};

/** Depth-first walk for the publisher element, wherever the page puts it. */
function findPublishedView(node: ReactNode): DiagnosticsViewState | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findPublishedView(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.type === DiagnosticsViewStatePublisher) {
    return element.props.view as DiagnosticsViewState;
  }
  return findPublishedView(element.props.children as ReactNode);
}

async function publishedViewFor(
  searchParams: Record<string, string>,
): Promise<DiagnosticsViewState | undefined> {
  const tree = await AdminBookingsPage({
    searchParams: Promise.resolve(searchParams),
  });
  return findPublishedView(tree);
}

describe("the bookings list publishes its APPLIED filters (#2816)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.clubTimeSettings.findUnique).mockResolvedValue(null);
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue(MODULES_OFF);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
    vi.mocked(prisma.booking.count).mockResolvedValue(0);
    vi.mocked(prisma.hostingCoverageIncident.count).mockResolvedValue(0);
    vi.mocked(prisma.hostingCoverageIncident.findMany).mockResolvedValue([]);
    vi.mocked(prisma.xeroSyncOperation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.xeroObjectLink.findMany).mockResolvedValue([]);
    vi.mocked(auth).mockResolvedValue({
      user: { id: "admin-1", accessRoles: [{ role: "ADMIN" }] },
    } as never);
  });

  it("publishes the status, window and search a well-formed address applied", async () => {
    expect(
      await publishedViewFor({
        status: "CONFIRMED",
        from: "2026-08-01",
        to: "2026-08-31",
        search: "  ngata  ",
        lodgeId: "lodge-1",
        page: "3",
      }),
    ).toEqual({
      // The registry's token vocabulary, so the ONE spelling reaches the model
      // whether a status arrives in the token field or in the status filter.
      status: "confirmed",
      filters: {
        // EACH BOUND UNDER THE COLUMN IT NARROWED. The legacy pair is asymmetric
        // in `buildBookingWhere` — `from` feeds `checkIn.gte` and `to` feeds
        // `checkOut.lte` — so publishing both under `from`/`to` told the model a
        // check-in bound was a check-out one (evidence review, 14 Aug 2026).
        checkInFrom: "2026-08-01",
        checkOutTo: "2026-08-31",
        // Post-trim, because the trim is what the query used.
        search: "ngata",
        lodgeId: "lodge-1",
      },
      // `page` is pagination: not in the row's allowlist, and it says nothing
      // about why the page shows what it shows.
    });
  });

  it("publishes each date bound under the column `buildBookingWhere` applied it to", async () => {
    // THE ASYMMETRY, pinned end to end. All four bounds in one URL, and the
    // clause the page actually queried with, read back from the mock: whatever
    // key a bound is published under has to be the column it appears on here.
    const view = await publishedViewFor({
      from: "2026-08-01",
      to: "2026-08-31",
      checkOutFrom: "2026-08-10",
    });
    expect(view).toEqual({
      filters: {
        checkInFrom: "2026-08-01",
        checkOutFrom: "2026-08-10",
        checkOutTo: "2026-08-31",
      },
    });
    const call = vi.mocked(prisma.booking.findMany).mock
      .calls[0][0] as unknown as {
      where: {
        checkIn?: { gte?: Date; lte?: Date };
        checkOut?: { gte?: Date; lte?: Date };
      };
    };
    // Legacy `from` is a check-IN lower bound; legacy `to` is a check-OUT upper
    // one. The published keys say exactly that.
    expect(call.where.checkIn?.gte).toBeDefined();
    expect(call.where.checkIn?.lte).toBeUndefined();
    expect(call.where.checkOut?.gte).toBeDefined();
    expect(call.where.checkOut?.lte).toBeDefined();
  });

  it("never publishes an over-long value the ask route would drop anyway", async () => {
    // `adminBookingsQuerySchema` bounds `search` to 100 characters and fails the
    // whole parse above that, but it bounds `lodgeId` only to non-empty — so this
    // is applied, narrows the list to a lodge that does not exist, and used to be
    // published for a route that drops it. Being told nothing about a filter that
    // IS narrowing is worse than being told nothing at all (review, 14 Aug 2026).
    expect(
      await publishedViewFor({ lodgeId: "x".repeat(200), status: "CONFIRMED" }),
    ).toEqual({ status: "confirmed" });
    // And it really was applied to the query.
    const call = vi.mocked(prisma.booking.findMany).mock
      .calls[0][0] as unknown as { where: Record<string, unknown> };
    expect(JSON.stringify(call.where)).toContain("x".repeat(200));
  });

  it("publishes `PAYMENT_PENDING` in the registry's spelling, not the enum's", async () => {
    expect(await publishedViewFor({ status: "PAYMENT_PENDING" })).toEqual({
      status: "payment-pending",
    });
  });

  it("PUBLISHES NOTHING when one malformed value made the parse drop every filter", async () => {
    // The whole reason this channel exists. `from` is not a date, the total
    // parse fails, and `adminBookingsQuerySchema.parse({})` replaces the lot —
    // so the list on screen is unfiltered even though the address shows a
    // status, a window and a search.
    const view = await publishedViewFor({
      status: "CONFIRMED",
      from: "13-45-2026",
      to: "2026-08-31",
      search: "ngata",
    });
    expect(view).toEqual({});

    // And the page really did apply nothing: the query is the default one.
    const where = vi.mocked(prisma.booking.findMany).mock
      .calls[0][0] as unknown as { where: Record<string, unknown> };
    expect(where.where.checkIn).toBeUndefined();
    expect(where.where.checkOut).toBeUndefined();
  });

  it("publishes `{}` rather than undefined, so the widget cannot fall back to the address", async () => {
    // `{}` is "I applied nothing" and suppresses the URL fallback; `undefined`
    // would be "I publish nothing" and invite it — straight back to the address
    // this page has just refused.
    expect(await publishedViewFor({ from: "13-45-2026" })).not.toBeUndefined();
  });

  it("publishes the WINNING bound when a legacy alias lost to an explicit one", async () => {
    // The bug this replaces: the first cut suppressed the LOSING alias and never
    // published the winner, so a narrowed list was reported as unnarrowed.
    // `checkInFrom ?? from` for the lower bound; `checkInTo` takes the upper one
    // and pushes the legacy `to` out of the query entirely.
    expect(
      await publishedViewFor({
        from: "2026-08-01",
        checkInFrom: "2026-09-01",
        to: "2026-08-31",
        checkInTo: "2026-09-30",
      }),
    ).toEqual({
      filters: { checkInFrom: "2026-09-01", checkInTo: "2026-09-30" },
    });
  });

  it("publishes a check-out bound, which is the only window two dashboard cards send", async () => {
    // `buildUnpaidFinishedStaysHref` deep-links here; the sibling
    // `additionalOwed` card sends the same `checkOutTo` with no status at all,
    // and used to publish `{}`.
    const href = buildUnpaidFinishedStaysHref("2026-07-01");
    const params = Object.fromEntries(
      new URLSearchParams(href.split("?")[1]).entries(),
    );
    expect(await publishedViewFor(params)).toEqual({
      status: "payment-pending",
      filters: { checkOutTo: "2026-07-01" },
    });
    expect(
      await publishedViewFor({
        additionalOwed: "owed",
        checkOutTo: "2026-07-01",
      }),
    ).toEqual({ filters: { checkOutTo: "2026-07-01" } });
  });

  it("publishes the computed window and pinned statuses of `?upcoming=`", async () => {
    // The dashboard's "Bookings" card. Neither half is in the address: the window
    // is [today, today+N] and the status set is pinned only because no explicit
    // status was asked for. The clock is frozen at 2026-07-01 (NZ) for every
    // suite, so these are stable.
    expect(await publishedViewFor({ upcoming: "7" })).toEqual({
      filters: {
        status: "payment-pending,confirmed,paid,pending",
        // `?upcoming=` bounds CHECK-IN at both ends.
        checkInFrom: "2026-07-01",
        checkInTo: "2026-07-08",
      },
    });
  });

  it("does not pin `?upcoming=`'s statuses when the URL named one", async () => {
    // `buildBookingWhere` only pins the set `if (!query.status)`.
    expect(
      await publishedViewFor({ upcoming: "7", status: "CONFIRMED" }),
    ).toEqual({
      status: "confirmed",
      filters: { checkInFrom: "2026-07-01", checkInTo: "2026-07-08" },
    });
  });

  it("does not pin `?upcoming=`'s statuses for `status=all` either, which is TRUTHY", async () => {
    // The builder's guard is `if (!query.status)`, and `"all"` passes it — so the
    // default `{ not: DRAFT }` stands and nothing is pinned. Approximating that
    // guard as "no real status was applied" would report a status set the list is
    // not using.
    expect(await publishedViewFor({ upcoming: "7", status: "all" })).toEqual({
      filters: { checkInFrom: "2026-07-01", checkInTo: "2026-07-08" },
    });
    // And the where-builder really did leave the default standing.
    const where = vi.mocked(prisma.booking.findMany).mock
      .calls[0][0] as unknown as { where: { status?: unknown } };
    expect(where.where.status).toEqual({ not: "DRAFT" });
  });

  it("publishes the month window `?month=` applied, which is nowhere in the address as dates", async () => {
    expect(await publishedViewFor({ month: "2026-09" })).toEqual({
      filters: { checkInFrom: "2026-09-01", checkInTo: "2026-09-30" },
    });
  });

  it("publishes several applied statuses as the allowlisted filter, not as one token", async () => {
    // The wire's `status` holds ONE token; silently sending the first would
    // misstate a two-status selection.
    expect(
      await publishedViewFor({ status: "CONFIRMED,PAID" }),
    ).toEqual({ filters: { status: "confirmed,paid" } });
  });

  it("publishes a status that is not a real one, because it is why the list is empty", async () => {
    // `?status=BOGUS` applies `{ in: [] }` — a narrowing that matches NOTHING.
    // This is the one URL where the list is empty BECAUSE OF the filter, so
    // saying nothing about it is the worst available answer.
    expect(await publishedViewFor({ status: "BOGUS" })).toEqual({
      filters: { status: "bogus" },
    });
  });

  it("publishes nothing while the consent ATTENTION queue has replaced the table", async () => {
    // That queue renders `listMemberGuestConsentExceptions()`, which takes no
    // filter arguments at all — nothing on screen is filtered by these values.
    expect(
      await publishedViewFor({ consentState: "attention", status: "CONFIRMED" }),
    ).toEqual({});
  });

  it("never publishes a key this page's registry row does not allowlist", async () => {
    // THE DRIFT GUARD. The row and the page are hand-matched, so this pins the
    // one thing that hand-matching can silently break: the route drops an
    // unlisted key, and a page publishing one has published nothing.
    const row = getDiagnosticsPageContextRoute("admin.bookings");
    expect(row).toBeDefined();
    const view = await publishedViewFor({
      status: "CONFIRMED,PAID",
      checkInFrom: "2026-08-01",
      checkOutTo: "2026-08-31",
      search: "ngata",
      lodgeId: "lodge-1",
      // Applied, and deliberately unpublishable: none is in the row.
      paymentSource: "STRIPE",
      xeroState: "invoiceLinked",
      bedState: "partial",
      additionalOwed: "owed",
      changeState: "requiresReview",
      updatedFrom: "2026-08-01",
      deleted: "all",
    });
    expect(Object.keys(view?.filters ?? {})).not.toHaveLength(0);
    for (const key of Object.keys(view?.filters ?? {})) {
      expect(row?.filterKeys).toContain(key);
    }
  });
});
