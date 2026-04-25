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

const FINANCE_TIMEZONE = "Pacific/Auckland";
const DEFAULT_FINANCE_WORKING_CAPITAL_PERIODS = 6;
const MAX_FINANCE_WORKING_CAPITAL_PERIODS = 24;
const MIN_FINANCE_WORKING_CAPITAL_PERIODS = 1;

type FinanceWorkingCapitalReportSearchParams = Record<
  string,
  string | string[] | undefined
>;

interface WorkingCapitalSnapshotSummary {
  snapshotId: string;
  snapshotLabel: string;
  sourceWindow: string;
  currentAssetsCents: number;
  currentAssets: string;
  currentLiabilitiesCents: number;
  currentLiabilities: string;
  workingCapitalCents: number;
  workingCapital: string;
  currentRatio: number | null;
  currentAssetLineItemCount: number;
  currentLiabilityLineItemCount: number;
  sourceUpdatedAtLabel: string;
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
  currentAssetLineItemCount: string;
  currentLiabilityLineItemCount: string;
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
  filters: FinanceWorkingCapitalReportFilters,
) {
  return new URLSearchParams({
    periods: String(filters.periods),
  }).toString();
}

export function buildFinanceWorkingCapitalReportHref(
  filters: FinanceWorkingCapitalReportFilters,
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
      `Working-capital periods must be a whole number between ${MIN_FINANCE_WORKING_CAPITAL_PERIODS} and ${MAX_FINANCE_WORKING_CAPITAL_PERIODS}. Showing the default ${DEFAULT_FINANCE_WORKING_CAPITAL_PERIODS}-period window.`,
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
      `Working-capital periods must be a whole number between ${MIN_FINANCE_WORKING_CAPITAL_PERIODS} and ${MAX_FINANCE_WORKING_CAPITAL_PERIODS}. Showing the default ${DEFAULT_FINANCE_WORKING_CAPITAL_PERIODS}-period window.`,
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
        (snapshot): snapshot is ParsedBalanceSheetSnapshot => snapshot !== null,
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
        `${skippedSnapshotCount} stored balance-sheet snapshot${skippedSnapshotCount === 1 ? "" : "s"} could not be parsed and ${skippedSnapshotCount === 1 ? "was" : "were"} ignored.`,
      );
    }

    if (parsedSnapshots.length === 0) {
      return buildUnavailableWorkingCapitalReportModel({
        filters,
        reportHref,
        isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
        warnings,
        loadError:
          "Finance working-capital snapshots are temporarily unavailable. Try again shortly after the next finance sync completes.",
      });
    }

    const comparableSnapshots = parsedSnapshots.flatMap((snapshot) => {
      if (
        snapshot.currentAssetsCents === null ||
        snapshot.currentAssets === null ||
        snapshot.currentLiabilitiesCents === null ||
        snapshot.currentLiabilities === null ||
        snapshot.workingCapitalCents === null ||
        snapshot.workingCapital === null
      ) {
        warnings.push(
          `${snapshot.snapshotLabel} did not expose both current-asset and current-liability sections and was ignored.`,
        );
        return [];
      }

      return [
        {
          snapshotId: snapshot.snapshotId,
          snapshotLabel: snapshot.snapshotLabel,
          sourceWindow: snapshot.sourceWindow,
          currentAssetsCents: snapshot.currentAssetsCents,
          currentAssets: snapshot.currentAssets,
          currentLiabilitiesCents: snapshot.currentLiabilitiesCents,
          currentLiabilities: snapshot.currentLiabilities,
          workingCapitalCents: snapshot.workingCapitalCents,
          workingCapital: snapshot.workingCapital,
          currentRatio: snapshot.currentRatio,
          currentAssetLineItemCount: snapshot.currentAssetLineItemCount,
          currentLiabilityLineItemCount: snapshot.currentLiabilityLineItemCount,
          sourceUpdatedAtLabel: snapshot.sourceUpdatedAtLabel,
        } satisfies WorkingCapitalSnapshotSummary,
      ];
    });

    if (comparableSnapshots.length === 0) {
      return buildUnavailableWorkingCapitalReportModel({
        filters,
        reportHref,
        isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
        warnings,
        loadError:
          "Working capital is temporarily unavailable because none of the selected balance-sheet snapshots exposed both current-asset and current-liability detail.",
      });
    }

    const latestSnapshot = comparableSnapshots[0];

    return {
      generatedOn: formatDateTime(new Date().toISOString()),
      isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
      filters,
      reportHref,
      filterWarnings: warnings,
      coverageSummary: `Showing ${comparableSnapshots.length} stored working-capital snapshot${comparableSnapshots.length === 1 ? "" : "s"} from ${latestSnapshot.snapshotLabel} backwards.`,
      summaryCards: buildWorkingCapitalSummaryCards(comparableSnapshots),
      periodRows: comparableSnapshots.map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        asOfDateLabel: snapshot.snapshotLabel,
        sourceWindow: snapshot.sourceWindow,
        currentAssets: snapshot.currentAssets,
        currentLiabilities: snapshot.currentLiabilities,
        workingCapital: snapshot.workingCapital,
        currentRatio: formatWorkingCapitalRatio(snapshot.currentRatio),
        currentAssetLineItemCount: formatWholeNumber(
          snapshot.currentAssetLineItemCount,
        ),
        currentLiabilityLineItemCount: formatWholeNumber(
          snapshot.currentLiabilityLineItemCount,
        ),
        sourceUpdatedAtLabel: snapshot.sourceUpdatedAtLabel,
      })),
      sourceNotes: buildWorkingCapitalSourceNotes(),
    };
  } catch (error) {
    console.error(
      "Failed to load finance working-capital report snapshots",
      error,
    );

    return buildUnavailableWorkingCapitalReportModel({
      filters,
      reportHref,
      isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
      warnings,
      loadError:
        "Finance working-capital snapshots are temporarily unavailable. Try again shortly or use manager diagnostics to confirm the latest finance sync status.",
    });
  }
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

function buildWorkingCapitalSummaryCards(
  snapshots: WorkingCapitalSnapshotSummary[],
): FinanceWorkingCapitalReportSummaryCard[] {
  const latestSnapshot = snapshots[0];

  return [
    {
      title: "Latest current assets",
      value: latestSnapshot.currentAssets,
      description:
        "Current-assets total from the latest stored balance-sheet snapshot.",
      footnote:
        latestSnapshot.currentAssetLineItemCount > 0
          ? `${formatWholeNumber(latestSnapshot.currentAssetLineItemCount)} current-asset line item${latestSnapshot.currentAssetLineItemCount === 1 ? "" : "s"} appeared in the latest stored snapshot.`
          : "No current-asset detail lines were available in the latest stored snapshot.",
    },
    {
      title: "Latest current liabilities",
      value: latestSnapshot.currentLiabilities,
      description:
        "Current-liabilities total from the latest stored balance-sheet snapshot.",
      footnote:
        latestSnapshot.currentLiabilityLineItemCount > 0
          ? `${formatWholeNumber(latestSnapshot.currentLiabilityLineItemCount)} current-liability line item${latestSnapshot.currentLiabilityLineItemCount === 1 ? "" : "s"} appeared in the latest stored snapshot.`
          : "No current-liability detail lines were available in the latest stored snapshot.",
    },
    {
      title: "Latest working capital",
      value: latestSnapshot.workingCapital,
      description:
        "Current assets less current liabilities from the latest stored balance-sheet snapshot.",
      footnote: `${latestSnapshot.sourceWindow}. Updated ${latestSnapshot.sourceUpdatedAtLabel}.`,
    },
    {
      title: "Current-assets coverage",
      value: formatWorkingCapitalRatio(latestSnapshot.currentRatio),
      description:
        "Current assets divided by current liabilities from the latest stored balance-sheet snapshot.",
      footnote:
        latestSnapshot.currentRatio === null
          ? "Current liabilities were zero in the latest stored snapshot, so the current ratio is not shown."
          : "Ratios above 1.00x indicate current assets exceeded current liabilities in the latest stored snapshot.",
    },
  ];
}

function buildWorkingCapitalSourceNotes() {
  return [
    {
      label: "Finance snapshot source",
      description:
        "Working-capital figures on this page come from stored `BALANCE_SHEET` FinanceSnapshot rows synced through the finance-only Xero boundary. They are not derived from Tokoroa Alpine Club booking or payment data.",
    },
    {
      label: "Current-section assumption",
      description:
        "Current assets and current liabilities are derived only from stored balance-sheet sections explicitly labelled as current-asset and current-liability detail. Snapshots without both sections are skipped with a viewer-safe warning.",
    },
    {
      label: "Distinct from cash totals",
      description:
        "Working capital here remains separate from Tokoroa Alpine Club payment-derived cash summaries and the native cash report. The page reads durable stored balance-sheet snapshots only and does not trigger live Xero reads, forecasts, or manual sync actions.",
    },
  ];
}

function formatWorkingCapitalRatio(value: number | null) {
  if (value === null) {
    return "—";
  }

  return `${value.toFixed(2)}x`;
}

function readSearchParam(
  searchParams: FinanceWorkingCapitalReportSearchParams | undefined,
  key: string,
) {
  const value = searchParams?.[key];

  if (Array.isArray(value)) {
    return value.at(-1);
  }

  return value;
}

function formatWholeNumber(value: number) {
  return new Intl.NumberFormat("en-NZ", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: FINANCE_TIMEZONE,
  }).format(new Date(value));
}
