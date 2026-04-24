import { FinanceSnapshotType } from "@prisma/client";
import {
  type FinanceAccessMember,
  hasFinanceManagerAccess,
} from "@/lib/finance-auth";
import {
  parseBalanceSheetSnapshot,
  type ParsedBalanceSheetSnapshot,
} from "@/lib/finance-balance-sheet-report-page";
import {
  DEFAULT_FINANCE_SNAPSHOT_SCOPE,
  listFinanceSnapshots,
} from "@/lib/finance-sync-storage";
import { formatCents } from "@/lib/utils";

const FINANCE_TIMEZONE = "Pacific/Auckland";
const DEFAULT_FINANCE_WORKING_CAPITAL_PERIODS = 6;
const MAX_FINANCE_WORKING_CAPITAL_PERIODS = 24;
const MIN_FINANCE_WORKING_CAPITAL_PERIODS = 1;

type FinanceWorkingCapitalReportSearchParams = Record<
  string,
  string | string[] | undefined
>;

interface ParsedWorkingCapitalSnapshot extends ParsedBalanceSheetSnapshot {
  currentAssetsCents: number;
  currentLiabilitiesCents: number;
  workingCapitalCents: number;
}

export interface FinanceWorkingCapitalReportFilters {
  periods: number;
}

export interface FinanceWorkingCapitalReportSummaryCard {
  title: string;
  value: string;
  description: string;
  footnote?: string;
}

export interface FinanceWorkingCapitalReportPeriodRow {
  snapshotId: string;
  asOfDateLabel: string;
  sourceWindow: string;
  currentAssets: string;
  currentLiabilities: string;
  workingCapital: string;
  currentRatio: string;
  sourceUpdatedAtLabel: string;
}

export interface FinanceWorkingCapitalReportPageModel {
  generatedOn: string;
  isManager: boolean;
  filters: FinanceWorkingCapitalReportFilters;
  reportHref: string;
  filterWarnings: string[];
  loadError?: string;
  coverageSummary: string;
  summaryCards: FinanceWorkingCapitalReportSummaryCard[];
  periodRows: FinanceWorkingCapitalReportPeriodRow[];
  sourceNotes: Array<{
    label: string;
    description: string;
  }>;
}

export function buildDefaultFinanceWorkingCapitalReportFilters() {
  return {
    periods: DEFAULT_FINANCE_WORKING_CAPITAL_PERIODS,
  } satisfies FinanceWorkingCapitalReportFilters;
}

export function buildFinanceWorkingCapitalReportQueryString(
  filters: FinanceWorkingCapitalReportFilters
) {
  return new URLSearchParams({
    periods: String(filters.periods),
  }).toString();
}

export function buildFinanceWorkingCapitalReportHref(
  filters: FinanceWorkingCapitalReportFilters
) {
  return `/finance/working-capital?${buildFinanceWorkingCapitalReportQueryString(filters)}`;
}

export function resolveFinanceWorkingCapitalReportFilters(input: {
  searchParams?: FinanceWorkingCapitalReportSearchParams;
}) {
  const filters = buildDefaultFinanceWorkingCapitalReportFilters();
  const warnings: string[] = [];
  const requestedPeriods = readSearchParam(input.searchParams, "periods");

  if (!requestedPeriods) {
    return { filters, warnings };
  }

  const normalizedPeriods = requestedPeriods.trim();

  if (!/^\d+$/.test(normalizedPeriods)) {
    warnings.push(
      `Working-capital periods must be a whole number between ${MIN_FINANCE_WORKING_CAPITAL_PERIODS} and ${MAX_FINANCE_WORKING_CAPITAL_PERIODS}. Showing the default ${DEFAULT_FINANCE_WORKING_CAPITAL_PERIODS}-period window.`
    );
    return { filters, warnings };
  }

  const parsedPeriods = Number(normalizedPeriods);

  if (
    !Number.isInteger(parsedPeriods) ||
    parsedPeriods < MIN_FINANCE_WORKING_CAPITAL_PERIODS ||
    parsedPeriods > MAX_FINANCE_WORKING_CAPITAL_PERIODS
  ) {
    warnings.push(
      `Working-capital periods must be a whole number between ${MIN_FINANCE_WORKING_CAPITAL_PERIODS} and ${MAX_FINANCE_WORKING_CAPITAL_PERIODS}. Showing the default ${DEFAULT_FINANCE_WORKING_CAPITAL_PERIODS}-period window.`
    );
    return { filters, warnings };
  }

  filters.periods = parsedPeriods;
  return { filters, warnings };
}

export async function buildFinanceWorkingCapitalReportPageModel(input: {
  member: FinanceAccessMember;
  searchParams?: FinanceWorkingCapitalReportSearchParams;
}): Promise<FinanceWorkingCapitalReportPageModel> {
  const { filters, warnings } = resolveFinanceWorkingCapitalReportFilters({
    searchParams: input.searchParams,
  });
  const reportHref = buildFinanceWorkingCapitalReportHref(filters);

  try {
    const snapshots = await listFinanceSnapshots({
      snapshotType: FinanceSnapshotType.BALANCE_SHEET,
      scope: DEFAULT_FINANCE_SNAPSHOT_SCOPE,
      limit: filters.periods,
    });
    const parsedSnapshots = snapshots
      .map((snapshot) => parseBalanceSheetSnapshot(snapshot))
      .filter(
        (snapshot): snapshot is ParsedBalanceSheetSnapshot => snapshot !== null
      );
    const skippedSnapshotCount = snapshots.length - parsedSnapshots.length;

    if (snapshots.length === 0) {
      return buildUnavailableWorkingCapitalReportModel({
        filters,
        reportHref,
        isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
        warnings,
        loadError:
          "No balance-sheet snapshots are available yet. Run the finance sync and try again once the balance-sheet dataset has landed.",
      });
    }

    if (skippedSnapshotCount > 0) {
      warnings.push(
        `${skippedSnapshotCount} stored balance-sheet snapshot${skippedSnapshotCount === 1 ? "" : "s"} could not be parsed and ${skippedSnapshotCount === 1 ? "was" : "were"} ignored.`
      );
    }

    const comparableSnapshots = parsedSnapshots.filter(hasWorkingCapitalFields);
    const skippedComparableCount = parsedSnapshots.length - comparableSnapshots.length;

    if (skippedComparableCount > 0) {
      warnings.push(
        `${skippedComparableCount} stored balance-sheet snapshot${skippedComparableCount === 1 ? "" : "s"} did not expose current-asset and current-liability sections and ${skippedComparableCount === 1 ? "was" : "were"} ignored.`
      );
    }

    if (comparableSnapshots.length === 0) {
      return buildUnavailableWorkingCapitalReportModel({
        filters,
        reportHref,
        isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
        warnings,
        loadError:
          "Working capital is temporarily unavailable because none of the selected balance-sheet snapshots exposed both current-asset and current-liability totals.",
      });
    }

    const latestSnapshot = comparableSnapshots[0];
    const averageCurrentAssetsCents = Math.round(
      comparableSnapshots.reduce(
        (total, snapshot) => total + snapshot.currentAssetsCents,
        0
      ) / comparableSnapshots.length
    );
    const averageCurrentLiabilitiesCents = Math.round(
      comparableSnapshots.reduce(
        (total, snapshot) => total + snapshot.currentLiabilitiesCents,
        0
      ) / comparableSnapshots.length
    );
    const averageWorkingCapitalCents = Math.round(
      comparableSnapshots.reduce(
        (total, snapshot) => total + snapshot.workingCapitalCents,
        0
      ) / comparableSnapshots.length
    );
    const comparableRatios = comparableSnapshots.flatMap((snapshot) =>
      snapshot.currentRatio === null ? [] : [snapshot.currentRatio]
    );
    const averageCurrentRatio =
      comparableRatios.length > 0
        ? comparableRatios.reduce((total, ratio) => total + ratio, 0) /
          comparableRatios.length
        : null;

    return {
      generatedOn: formatDateTime(new Date().toISOString()),
      isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
      filters,
      reportHref,
      filterWarnings: warnings,
      coverageSummary: `Showing ${comparableSnapshots.length} stored working-capital snapshot${comparableSnapshots.length === 1 ? "" : "s"} from ${latestSnapshot.snapshotLabel} backwards.`,
      summaryCards: [
        {
          title: "Latest current assets",
          value: formatFinanceAmount(latestSnapshot.currentAssetsCents),
          description:
            "Current-asset total from the latest stored balance-sheet snapshot.",
          footnote: `${latestSnapshot.sourceWindow}. Updated ${latestSnapshot.sourceUpdatedAtLabel}.`,
        },
        {
          title: "Latest current liabilities",
          value: formatFinanceAmount(latestSnapshot.currentLiabilitiesCents),
          description:
            "Current-liability total from the latest stored balance-sheet snapshot.",
          footnote: `Average selected current liabilities ${formatFinanceAmount(averageCurrentLiabilitiesCents)}.`,
        },
        {
          title: "Latest working capital",
          value: formatSignedFinanceAmount(latestSnapshot.workingCapitalCents),
          description:
            "Current assets minus current liabilities from the latest stored balance-sheet snapshot.",
          footnote: `Average selected working capital ${formatSignedFinanceAmount(averageWorkingCapitalCents)}.`,
        },
        {
          title: "Latest current ratio",
          value:
            latestSnapshot.currentRatio === null
              ? "Unavailable"
              : formatCurrentRatio(latestSnapshot.currentRatio),
          description:
            "Current assets divided by current liabilities for the latest stored snapshot.",
          footnote:
            latestSnapshot.currentRatio === null
              ? "Current ratio is unavailable when the latest stored snapshot records zero current liabilities."
              : averageCurrentRatio === null
                ? `Average selected current assets ${formatFinanceAmount(averageCurrentAssetsCents)}.`
                : `Average selected current ratio ${formatCurrentRatio(averageCurrentRatio)}.`,
        },
      ],
      periodRows: comparableSnapshots.map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        asOfDateLabel: snapshot.snapshotLabel,
        sourceWindow: snapshot.sourceWindow,
        currentAssets: formatFinanceAmount(snapshot.currentAssetsCents),
        currentLiabilities: formatFinanceAmount(snapshot.currentLiabilitiesCents),
        workingCapital: formatSignedFinanceAmount(snapshot.workingCapitalCents),
        currentRatio:
          snapshot.currentRatio === null
            ? "—"
            : formatCurrentRatio(snapshot.currentRatio),
        sourceUpdatedAtLabel: snapshot.sourceUpdatedAtLabel,
      })),
      sourceNotes: buildWorkingCapitalSourceNotes(),
    };
  } catch (error) {
    console.error("Failed to load finance working-capital report snapshots", error);

    return buildUnavailableWorkingCapitalReportModel({
      filters,
      reportHref,
      isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
      warnings,
      loadError:
        "Finance working capital snapshots are temporarily unavailable. Try again shortly or use manager diagnostics to confirm the latest finance sync status.",
    });
  }
}

function hasWorkingCapitalFields(
  snapshot: ParsedBalanceSheetSnapshot
): snapshot is ParsedWorkingCapitalSnapshot {
  return (
    snapshot.currentAssetsCents !== null &&
    snapshot.currentLiabilitiesCents !== null &&
    snapshot.workingCapitalCents !== null
  );
}

function buildUnavailableWorkingCapitalReportModel(input: {
  filters: FinanceWorkingCapitalReportFilters;
  reportHref: string;
  isManager: boolean;
  warnings: string[];
  loadError: string;
}): FinanceWorkingCapitalReportPageModel {
  return {
    generatedOn: formatDateTime(new Date().toISOString()),
    isManager: input.isManager,
    filters: input.filters,
    reportHref: input.reportHref,
    filterWarnings: input.warnings,
    loadError: input.loadError,
    coverageSummary: "Working-capital snapshots unavailable",
    summaryCards: [],
    periodRows: [],
    sourceNotes: buildWorkingCapitalSourceNotes(),
  };
}

function buildWorkingCapitalSourceNotes() {
  return [
    {
      label: "Finance snapshot source",
      description:
        "Working-capital figures on this page come from stored `BALANCE_SHEET` FinanceSnapshot rows synced through the finance-only Xero boundary. They are not derived from TACBookings booking or payment data.",
    },
    {
      label: "Section assumptions",
      description:
        "Current assets and current liabilities are derived from stored balance-sheet sections whose labels include `Current Assets` and `Current Liabilities`. When a summary total row is present, the page uses it; otherwise it sums the stored line items in that section.",
    },
    {
      label: "Working-capital math",
      description:
        "Working capital is `currentAssets - currentLiabilities`. Current ratio is `currentAssets / currentLiabilities` and is shown as unavailable when a stored snapshot records zero current liabilities.",
    },
    {
      label: "Scope boundary",
      description:
        "This page compares stored working-capital positions only. It keeps balance-sheet figures distinct from TACBookings booking metrics, payment-derived cash summaries, the native cash report, and any live Xero read path.",
    },
  ];
}

function formatFinanceAmount(cents: number) {
  return formatCents(cents);
}

function formatSignedFinanceAmount(cents: number) {
  if (cents >= 0) {
    return formatFinanceAmount(cents);
  }

  return `-${formatFinanceAmount(Math.abs(cents))}`;
}

function formatCurrentRatio(value: number) {
  return `${new Intl.NumberFormat("en-NZ", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}x`;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: FINANCE_TIMEZONE,
  });
}

function readSearchParam(
  searchParams: FinanceWorkingCapitalReportSearchParams | undefined,
  key: string
) {
  const value = searchParams?.[key];
  return Array.isArray(value) ? value[0] : value;
}
