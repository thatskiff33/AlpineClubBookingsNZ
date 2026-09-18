import { dateOnlyInstantOf, parseInstant, type BoundClubTime } from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import {
  FINANCE_DASHBOARD_COMPARE_LABELS,
  FINANCE_DASHBOARD_FORWARD_LABELS,
  FINANCE_DASHBOARD_RANGE_LABELS,
  FINANCE_DASHBOARD_VIEW_LABELS,
  financeDashboardViewUsesLodgeScope,
  resolveFinanceDashboardSelection,
  resolveFinanceDashboardView,
  type FinanceDashboardSelection,
} from "@/lib/finance-dashboard-ranges";
import { financeDashboardWindowDetail } from "@/lib/finance-dashboard-labels";
import { buildBookingsDashboard } from "@/lib/finance-dashboard-page/bookings-view";
import {
  appendFinancialYearsPanel,
  buildMappedPnlDashboard,
  buildRevenueDashboard,
} from "@/lib/finance-dashboard-page/pnl-view";
import { buildRatiosDashboard } from "@/lib/finance-dashboard-page/ratios-view";
import { buildPricingSensitivityDashboard } from "@/lib/finance-dashboard-page/pricing-sensitivity-view";
import {
  buildBalanceOrWorkingCapitalDashboard,
  buildCashDashboard,
} from "@/lib/finance-dashboard-page/balance-sheet-views";
import { buildSyncHealthDashboard } from "@/lib/finance-dashboard-page/sync-health-view";
import {
  type FinanceDashboardPageModel,
  type FinanceDashboardRatioExplorerModel,
  type FinanceDashboardSyncStatus,
  type FinanceDashboardViewModel,
} from "@/lib/finance-dashboard-page/model";
import { refreshFinancialYearConfig } from "@/lib/financial-year-server";
import { hasFinanceManagerAccess } from "@/lib/admin-permissions";
import type { FinanceAccessMember } from "@/lib/finance-auth";
import { getFinanceSyncDiagnosticsStatus } from "@/lib/finance-sync-diagnostics";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * A real INSTANT — a sync run's completion stamp, or the moment this page model
 * was built — in the club's PERSISTED zone (#3123, `INV-CONFIG-002`).
 *
 * It used to go through `formatNZDateTime`, i.e. through `APP_TIME_ZONE`, so for
 * a club west of Greenwich the finance page could say its figures were last
 * synced on the wrong day. Unlike `formatShortDate` in `finance-dashboard-page/bookings-view.ts` — which renders a
 * `yyyy-MM-dd` CALENDAR key and rightly takes no zone — this one holds a moment,
 * which has no civil date until a zone is chosen.
 *
 * The binding is threaded from `buildFinanceDashboardPageModel`, which resolves
 * it once per render pass; see the note there.
 */
function formatDateTime(club: BoundClubTime, value: string | Date) {
  const instant = parseInstant(value);
  return instant === null ? "Unavailable" : club.instantDateTime(instant);
}

/**
 * Active seasons for the page's reporting scope (#2919). They drive the "Rest
 * of Season" forward window, so reading them unscoped let one lodge's season
 * define another lodge's forward range with nothing on screen saying so. A
 * selected lodge reads only its own; All Lodges reads every ACTIVE lodge's and
 * carries the lodge name so the window can say whose season it picked.
 *
 * `lodge: { active: true }` is deliberate and is not the Season's own `active`
 * flag: a deactivated lodge disappears from the selector and from the
 * summed-capacity denominator, so a still-active season row of its own must not
 * set the club-wide forward window or put a name on screen that appears nowhere
 * else (review finding, #2919). Season.lodgeId is NOT NULL, so this excludes no
 * lodgeless rows — there are none.
 */
async function loadSeasons(lodgeId: string | null, labelWithLodge: boolean) {
  const seasons = await prisma.season.findMany({
    where: {
      active: true,
      lodge: { active: true },
      ...(lodgeId ? lodgeNullTolerantScope(lodgeId) : {}),
    },
    select: {
      name: true,
      startDate: true,
      endDate: true,
      active: true,
      lodge: { select: { name: true } },
    },
    orderBy: [{ startDate: "asc" }],
  });
  return seasons.map(({ lodge, ...season }) => ({
    ...season,
    // Only in All-Lodges mode, and only for a club that has more than one:
    // labelling a single-lodge club's own season with its own name is noise.
    lodgeName: labelWithLodge ? lodge.name : null,
  }));
}

async function buildSyncStatus(club: BoundClubTime): Promise<{
  status: FinanceDashboardSyncStatus;
  warnings: string[];
}> {
  try {
    const sync = await getFinanceSyncDiagnosticsStatus();
    const latest = sync.latestRun;
    if (!latest) {
      return {
        status: {
          label: "Not yet synced",
          tone: "warning",
          detail: `Scheduled ${sync.cron.schedule} (${sync.cron.timezone}).`,
          lastSyncedAt: null,
        },
        warnings: ["No finance sync run has completed in this environment yet."],
      };
    }

    const completedOrStarted = latest.completedAt ?? latest.startedAt;
    const tone =
      latest.status === "SUCCEEDED"
        ? "success"
        : latest.status === "PARTIAL"
          ? "warning"
          : latest.status === "RUNNING"
            ? "secondary"
            : "destructive";

    return {
      status: {
        label:
          latest.status === "SUCCEEDED"
            ? "Synced"
            : latest.status === "PARTIAL"
              ? "Partial sync"
              : latest.status === "RUNNING"
                ? "Running"
                : "Sync failed",
        tone,
        detail: `${latest.snapshotCount} snapshots, ${latest.totalRowCount} rows. ${formatDateTime(club, completedOrStarted)}.`,
        lastSyncedAt: completedOrStarted,
      },
      warnings:
        latest.status === "FAILED" || latest.status === "PARTIAL"
          ? [latest.errorSummary ?? "The latest finance sync needs manager review."]
          : [],
    };
  } catch {
    return {
      status: {
        label: "Sync unavailable",
        tone: "warning",
        detail: "Finance sync status could not be loaded.",
        lastSyncedAt: null,
      },
      warnings: ["Finance sync status could not be loaded."],
    };
  }
}

function buildSelectionLabels(selection: FinanceDashboardSelection) {
  return {
    view: FINANCE_DASHBOARD_VIEW_LABELS[selection.view],
    range: FINANCE_DASHBOARD_RANGE_LABELS[selection.range],
    compare: FINANCE_DASHBOARD_COMPARE_LABELS[selection.compare],
    forward: FINANCE_DASHBOARD_FORWARD_LABELS[selection.forward],
    primaryWindow: financeDashboardWindowDetail(selection.primary),
    comparisonWindow: financeDashboardWindowDetail(selection.comparison),
    // #2919: in All-Lodges mode at a multi-lodge club, say WHOSE season set the
    // forward window — dates alone never did. That string is the one the range
    // resolver already built (`label`), reused rather than rebuilt so there is
    // no second construction to keep in step. Every other case (one lodge
    // selected, or a single-lodge club) keeps the dates-only wording it had.
    forwardWindow: selection.forwardWindow.seasonLodgeName
      ? selection.forwardWindow.label
      : financeDashboardWindowDetail(selection.forwardWindow),
  };
}

export async function buildFinanceDashboardPageModel(input: {
  member: FinanceAccessMember;
  searchParams?: SearchParams;
}): Promise<FinanceDashboardPageModel> {
  /*
    THE CLUB'S ZONE, RESOLVED ONCE FOR THE WHOLE PAGE (#3123; INV-CONFIG-002).

    This is the finance dashboard's single zone boundary, and everything below
    is handed the binding rather than reaching for one of its own.
    `clubTime()` is `cache()`-wrapped, so the persisted row is read once per
    render pass no matter how many builders ask.

    IT ALSO SUPPLIES `today`. `finance-dashboard-ranges.ts` is on the browser
    graph and may not read a zone at all, so the day that picks the reporting
    month and the financial-year bucket is resolved here and threaded in — one
    value, from one authority, instead of three `getTodayDateOnly()` reads of
    the container's clock.

    THE READER IS THE `server-only` ONE, and that was checked rather than
    assumed: `cli-server-only-reach-census.test.ts` walks the real static import
    graph from every `tsx` entrypoint and reports no operator script reaching
    this module. `server-only` throws at import outside the react-server
    condition, so a CLI edge here would break `npm run` scripts that no route
    test covers.
  */
  const club = await clubTime();
  const activeLodges = await prisma.lodge.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  // Booking-derived reporting scope (occupancy, guest nights, booked revenue).
  // ADR-002: only expose the selector once a second active lodge exists — a
  // single-lodge club gets an empty list and no selector. An unknown/omitted
  // lodgeId param falls back to all active lodges (summed-capacity denominator).
  const requestedLodgeId =
    typeof input.searchParams?.lodgeId === "string"
      ? input.searchParams.lodgeId
      : undefined;
  const selectableLodges = activeLodges.length > 1 ? activeLodges : [];
  const selectedLodgeId =
    requestedLodgeId &&
    selectableLodges.some((lodge) => lodge.id === requestedLodgeId)
      ? requestedLodgeId
      : null;

  // Which lodge (if any) the seasons are read for. The view select and the lodge
  // select share one GET form, so switching from Bookings to an accounting view
  // resubmits the lodgeId the previous view had — on a page that then renders no
  // lodge selector at all. Honouring it there would let an invisible lodge set
  // the forward window, or raise a "configure seasons" warning with no control
  // to explain or clear it (review finding, #2919). The view is resolved from the
  // query string alone, which needs no seasons, so there is no cycle; and the
  // "which views are lodge-scoped" rule lives once, in
  // FINANCE_DASHBOARD_LODGE_SCOPED_VIEWS, shared with the client's render gate.
  const seasonLodgeId = financeDashboardViewUsesLodgeScope(
    resolveFinanceDashboardView(input.searchParams)
  )
    ? selectedLodgeId
    : null;
  // Seed the financial-year cache (override → Xero org → March default) so
  // FY-aligned ranges resolve correctly before the selection is built. The
  // seasons read is resolved AFTER the lodge scope (#2919) because it honours
  // it, exactly as the occupancy and pricing reads below do.
  const [seasons, sync, financialYearEndMonth] = await Promise.all([
    loadSeasons(seasonLodgeId, seasonLodgeId === null && selectableLodges.length > 1),
    buildSyncStatus(club),
    refreshFinancialYearConfig(),
  ]);
  const selection = resolveFinanceDashboardSelection({
    searchParams: input.searchParams,
    today: dateOnlyInstantOf(club.today()),
    seasons,
    financialYearEndMonth,
  });
  const labels = buildSelectionLabels(selection);

  let viewModel: FinanceDashboardViewModel;
  let ratios: FinanceDashboardRatioExplorerModel | null = null;

  if (selection.view === "bookings") {
    viewModel = await buildBookingsDashboard(selection, selectedLodgeId);
  } else if (selection.view === "revenue") {
    viewModel = await buildRevenueDashboard(selection);
  } else if (selection.view === "costs") {
    const costsModel = await buildMappedPnlDashboard({
      selection,
      kind: "EXPENSE",
    });
    await appendFinancialYearsPanel(costsModel, selection, "EXPENSE");
    viewModel = costsModel;
  } else if (selection.view === "ratios") {
    const ratiosModel = await buildRatiosDashboard(selection);
    ratios = ratiosModel.ratios;
    viewModel = ratiosModel;
  } else if (selection.view === "pricing-sensitivity") {
    viewModel = await buildPricingSensitivityDashboard(selection, selectedLodgeId);
  } else if (selection.view === "cash") {
    viewModel = await buildCashDashboard(club, selection);
  } else if (selection.view === "working-capital") {
    viewModel = await buildBalanceOrWorkingCapitalDashboard({
      selection,
      workingCapitalOnly: true,
    });
  } else if (selection.view === "sync-health") {
    viewModel = await buildSyncHealthDashboard(selection);
  } else {
    viewModel = await buildBalanceOrWorkingCapitalDashboard({
      selection,
      workingCapitalOnly: false,
    });
  }

  return {
    generatedOn: formatDateTime(club, new Date()),
    isManager: hasFinanceManagerAccess(input.member),
    selection,
    ratios,
    selectionLabels: labels,
    syncStatus: sync.status,
    warnings: [
      ...selection.warnings,
      ...sync.warnings,
      ...viewModel.warnings,
    ],
    cards: viewModel.cards,
    trends: viewModel.trends,
    mix: viewModel.mix,
    statusPanels: viewModel.statusPanels,
    costFilters: viewModel.costFilters,
    sourceNotes: viewModel.sourceNotes,
    lodges: selectableLodges,
    selectedLodgeId,
    exportSections: [
      {
        title: "Dashboard selection",
        rows: [
          {
            View: labels.view,
            Range: labels.range,
            PrimaryWindow: labels.primaryWindow,
            Compare: labels.compare,
            ComparisonWindow: labels.comparisonWindow,
            Forward: labels.forward,
            ForwardWindow: labels.forwardWindow,
          },
        ],
      },
      ...viewModel.exportSections,
    ],
  };
}
