import { FinanceSnapshotType } from "@prisma/client";
import {
  type FinanceAccessMember,
  hasFinanceManagerAccess,
} from "@/lib/finance-auth";
import {
  DEFAULT_FINANCE_SNAPSHOT_SCOPE,
  listFinanceSnapshots,
} from "@/lib/finance-sync-storage";
import { formatCents } from "@/lib/utils";

const FINANCE_TIMEZONE = "Pacific/Auckland";
const DEFAULT_FINANCE_REVENUE_PERIODS = 6;
const MAX_FINANCE_REVENUE_PERIODS = 24;
const MIN_FINANCE_REVENUE_PERIODS = 1;

type FinanceRevenueReportSearchParams = Record<
  string,
  string | string[] | undefined
>;

type FinanceSnapshotRecord = Awaited<
  ReturnType<typeof listFinanceSnapshots>
>[number];

interface FinanceSnapshotReportCell {
  value: string | null;
}

interface FinanceSnapshotReportRow {
  rowType: string | null;
  title: string | null;
  cells: FinanceSnapshotReportCell[];
  rows: FinanceSnapshotReportRow[];
}

interface FinanceSnapshotReportField {
  fieldId: string | null;
  description: string | null;
  value: string | null;
}

interface FinanceSnapshotReportPayload {
  reportDate: string | null;
  reportTitles: string[];
  fields: FinanceSnapshotReportField[];
  rows: FinanceSnapshotReportRow[];
}

interface ParsedRevenueLineItem {
  label: string;
  amountCents: number;
}

interface ParsedRevenueSnapshot {
  snapshotId: string;
  periodLabel: string;
  sourceWindow: string;
  totalRevenueCents: number;
  totalRevenue: string;
  lineItemCount: number;
  asOfDateLabel: string;
  sourceUpdatedAtLabel: string;
  lineItems: ParsedRevenueLineItem[];
}

export interface FinanceRevenueReportFilters {
  periods: number;
}

export interface FinanceRevenueReportSummaryCard {
  title: string;
  value: string;
  description: string;
  footnote?: string;
}

export interface FinanceRevenueReportMonthlyRow {
  snapshotId: string;
  periodLabel: string;
  sourceWindow: string;
  totalRevenue: string;
  lineItemCount: string;
  asOfDateLabel: string;
  sourceUpdatedAtLabel: string;
}

export interface FinanceRevenueReportLineItemRow {
  lineItem: string;
  latestPeriodAmount: string;
  selectedPeriodsAmount: string;
  periodsPresent: string;
}

export interface FinanceRevenueReportPageModel {
  generatedOn: string;
  isManager: boolean;
  filters: FinanceRevenueReportFilters;
  reportHref: string;
  filterWarnings: string[];
  loadError?: string;
  coverageSummary: string;
  summaryCards: FinanceRevenueReportSummaryCard[];
  monthlyRows: FinanceRevenueReportMonthlyRow[];
  lineItemRows: FinanceRevenueReportLineItemRow[];
  sourceNotes: Array<{
    label: string;
    description: string;
  }>;
}

export function buildDefaultFinanceRevenueReportFilters() {
  return {
    periods: DEFAULT_FINANCE_REVENUE_PERIODS,
  } satisfies FinanceRevenueReportFilters;
}

export function buildFinanceRevenueReportQueryString(
  filters: FinanceRevenueReportFilters
) {
  return new URLSearchParams({
    periods: String(filters.periods),
  }).toString();
}

export function buildFinanceRevenueReportHref(
  filters: FinanceRevenueReportFilters
) {
  return `/finance/revenue?${buildFinanceRevenueReportQueryString(filters)}`;
}

export function resolveFinanceRevenueReportFilters(input: {
  searchParams?: FinanceRevenueReportSearchParams;
}) {
  const filters = buildDefaultFinanceRevenueReportFilters();
  const warnings: string[] = [];
  const requestedPeriods = readSearchParam(input.searchParams, "periods");

  if (!requestedPeriods) {
    return { filters, warnings };
  }

  const normalizedPeriods = requestedPeriods.trim();

  if (!/^\d+$/.test(normalizedPeriods)) {
    warnings.push(
      `Revenue periods must be a whole number between ${MIN_FINANCE_REVENUE_PERIODS} and ${MAX_FINANCE_REVENUE_PERIODS}. Showing the default ${DEFAULT_FINANCE_REVENUE_PERIODS}-period window.`
    );
    return { filters, warnings };
  }

  const parsedPeriods = Number(normalizedPeriods);

  if (
    !Number.isInteger(parsedPeriods) ||
    parsedPeriods < MIN_FINANCE_REVENUE_PERIODS ||
    parsedPeriods > MAX_FINANCE_REVENUE_PERIODS
  ) {
    warnings.push(
      `Revenue periods must be a whole number between ${MIN_FINANCE_REVENUE_PERIODS} and ${MAX_FINANCE_REVENUE_PERIODS}. Showing the default ${DEFAULT_FINANCE_REVENUE_PERIODS}-period window.`
    );
    return { filters, warnings };
  }

  filters.periods = parsedPeriods;
  return { filters, warnings };
}

export async function buildFinanceRevenueReportPageModel(input: {
  member: FinanceAccessMember;
  searchParams?: FinanceRevenueReportSearchParams;
}): Promise<FinanceRevenueReportPageModel> {
  const { filters, warnings } = resolveFinanceRevenueReportFilters({
    searchParams: input.searchParams,
  });
  const reportHref = buildFinanceRevenueReportHref(filters);

  try {
    const snapshots = await listFinanceSnapshots({
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
      scope: DEFAULT_FINANCE_SNAPSHOT_SCOPE,
      limit: filters.periods,
    });
    const parsedSnapshots = snapshots
      .map((snapshot) => parseRevenueSnapshot(snapshot))
      .filter((snapshot): snapshot is ParsedRevenueSnapshot => snapshot !== null);
    const skippedSnapshotCount = snapshots.length - parsedSnapshots.length;

    if (snapshots.length === 0) {
      return buildUnavailableRevenueReportModel({
        filters,
        reportHref,
        isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
        warnings,
        loadError:
          "No monthly finance revenue snapshots are available yet. Run the finance sync and try again once the profit-and-loss dataset has landed.",
      });
    }

    if (skippedSnapshotCount > 0) {
      warnings.push(
        `${skippedSnapshotCount} stored revenue snapshot${skippedSnapshotCount === 1 ? "" : "s"} could not be parsed and ${skippedSnapshotCount === 1 ? "was" : "were"} ignored.`
      );
    }

    if (parsedSnapshots.length === 0) {
      return buildUnavailableRevenueReportModel({
        filters,
        reportHref,
        isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
        warnings,
        loadError:
          "Finance revenue snapshots are temporarily unavailable. Try again shortly after the next finance sync completes.",
      });
    }

    const latestSnapshot = parsedSnapshots[0];
    const totalRevenueCents = parsedSnapshots.reduce(
      (total, snapshot) => total + snapshot.totalRevenueCents,
      0
    );
    const averageRevenueCents = Math.round(
      totalRevenueCents / parsedSnapshots.length
    );
    const lineItemRows = buildRevenueLineItemRows(parsedSnapshots);

    return {
      generatedOn: formatDateTime(new Date().toISOString()),
      isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
      filters,
      reportHref,
      filterWarnings: warnings,
      coverageSummary: `Showing ${parsedSnapshots.length} monthly profit-and-loss snapshot${parsedSnapshots.length === 1 ? "" : "s"} from ${latestSnapshot.periodLabel} backwards.`,
      summaryCards: [
        {
          title: "Latest synced month",
          value: latestSnapshot.totalRevenue,
          description: `${latestSnapshot.periodLabel} income total from the latest stored profit-and-loss snapshot.`,
          footnote: `${latestSnapshot.sourceWindow}. Updated ${latestSnapshot.sourceUpdatedAtLabel}.`,
        },
        {
          title: "Selected periods total",
          value: formatFinanceAmount(totalRevenueCents),
          description: `Combined income across ${parsedSnapshots.length} stored monthly revenue snapshot${parsedSnapshots.length === 1 ? "" : "s"}.`,
        },
        {
          title: "Average monthly revenue",
          value: formatFinanceAmount(averageRevenueCents),
          description:
            "Average income across the selected stored monthly profit-and-loss periods.",
        },
        {
          title: "Revenue lines tracked",
          value: formatWholeNumber(lineItemRows.length),
          description:
            "Unique income line items found across the selected finance snapshots.",
          footnote: `${formatWholeNumber(parsedSnapshots.length)} period${parsedSnapshots.length === 1 ? "" : "s"} loaded from durable FinanceSnapshot storage.`,
        },
      ],
      monthlyRows: parsedSnapshots.map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        periodLabel: snapshot.periodLabel,
        sourceWindow: snapshot.sourceWindow,
        totalRevenue: snapshot.totalRevenue,
        lineItemCount: formatWholeNumber(snapshot.lineItemCount),
        asOfDateLabel: snapshot.asOfDateLabel,
        sourceUpdatedAtLabel: snapshot.sourceUpdatedAtLabel,
      })),
      lineItemRows,
      sourceNotes: buildRevenueSourceNotes(),
    };
  } catch (error) {
    console.error("Failed to load finance revenue report snapshots", error);

    return buildUnavailableRevenueReportModel({
      filters,
      reportHref,
      isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
      warnings,
      loadError:
        "Finance revenue snapshots are temporarily unavailable. Try again shortly or use manager diagnostics to confirm the latest finance sync status.",
    });
  }
}

function buildUnavailableRevenueReportModel(input: {
  filters: FinanceRevenueReportFilters;
  reportHref: string;
  isManager: boolean;
  warnings: string[];
  loadError: string;
}): FinanceRevenueReportPageModel {
  return {
    generatedOn: formatDateTime(new Date().toISOString()),
    isManager: input.isManager,
    filters: input.filters,
    reportHref: input.reportHref,
    filterWarnings: input.warnings,
    loadError: input.loadError,
    coverageSummary: "Revenue snapshots unavailable",
    summaryCards: [],
    monthlyRows: [],
    lineItemRows: [],
    sourceNotes: buildRevenueSourceNotes(),
  };
}

function buildRevenueSourceNotes() {
  return [
    {
      label: "Finance snapshot source",
      description:
        "Revenue on this page comes from stored `PROFIT_AND_LOSS_MONTHLY` FinanceSnapshot rows synced through the finance-only Xero boundary. It is not derived from TACBookings booking metrics.",
    },
    {
      label: "Durable read path",
      description:
        "The page reads durable monthly snapshots already stored in Postgres. It does not trigger a live Xero report call or a manual finance sync.",
    },
    {
      label: "Scope boundary",
      description:
        "This report is revenue-only. It does not include TACBookings booking occupancy, payment-derived cash, costs, balance-sheet figures, or manual sync controls.",
    },
  ];
}

function buildRevenueLineItemRows(
  snapshots: ParsedRevenueSnapshot[]
): FinanceRevenueReportLineItemRow[] {
  const latestSnapshot = snapshots[0];
  const lineItemsByLabel = new Map<
    string,
    { latestPeriodAmountCents: number | null; selectedPeriodsAmountCents: number; periodsPresent: number }
  >();

  for (const snapshot of snapshots) {
    for (const lineItem of snapshot.lineItems) {
      const existing = lineItemsByLabel.get(lineItem.label) ?? {
        latestPeriodAmountCents: null,
        selectedPeriodsAmountCents: 0,
        periodsPresent: 0,
      };

      existing.selectedPeriodsAmountCents += lineItem.amountCents;
      existing.periodsPresent += 1;

      if (snapshot.snapshotId === latestSnapshot.snapshotId) {
        existing.latestPeriodAmountCents = lineItem.amountCents;
      }

      lineItemsByLabel.set(lineItem.label, existing);
    }
  }

  return Array.from(lineItemsByLabel.entries())
    .sort(([, left], [, right]) => {
      if (right.selectedPeriodsAmountCents !== left.selectedPeriodsAmountCents) {
        return right.selectedPeriodsAmountCents - left.selectedPeriodsAmountCents;
      }

      return left.periodsPresent !== right.periodsPresent
        ? right.periodsPresent - left.periodsPresent
        : 0;
    })
    .map(([lineItem, summary]) => ({
      lineItem,
      latestPeriodAmount:
        summary.latestPeriodAmountCents === null
          ? "—"
          : formatFinanceAmount(summary.latestPeriodAmountCents),
      selectedPeriodsAmount: formatFinanceAmount(
        summary.selectedPeriodsAmountCents
      ),
      periodsPresent: formatWholeNumber(summary.periodsPresent),
    }));
}

function parseRevenueSnapshot(
  snapshot: FinanceSnapshotRecord
): ParsedRevenueSnapshot | null {
  const payload = readReportPayload(snapshot.payload);

  if (!payload) {
    return null;
  }

  const revenueSection = findRevenueSection(payload.rows);

  if (!revenueSection) {
    return null;
  }

  const lineItems = extractRevenueLineItems(revenueSection);
  const totalRevenueCents =
    extractRevenueSummaryCents(revenueSection) ?? sumRevenueLineItems(lineItems);

  if (totalRevenueCents === null) {
    return null;
  }

  const periodLabel =
    readPeriodLabel(payload) ??
    formatMonthYear(snapshot.periodEnd ?? snapshot.asOfDate);

  return {
    snapshotId: snapshot.id,
    periodLabel,
    sourceWindow: formatSnapshotWindow(snapshot.periodStart, snapshot.periodEnd),
    totalRevenueCents,
    totalRevenue: formatFinanceAmount(totalRevenueCents),
    lineItemCount: lineItems.length,
    asOfDateLabel: formatDisplayDate(snapshot.asOfDate),
    sourceUpdatedAtLabel: snapshot.sourceUpdatedAt
      ? formatDateTime(snapshot.sourceUpdatedAt.toISOString())
      : "Snapshot update time unavailable",
    lineItems,
  };
}

function readReportPayload(value: unknown): FinanceSnapshotReportPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    reportDate: readOptionalString(value.reportDate),
    reportTitles: Array.isArray(value.reportTitles)
      ? value.reportTitles
          .map((title) => readOptionalString(title))
          .filter((title): title is string => title !== null)
      : [],
    fields: readReportFields(value.fields),
    rows: readReportRows(value.rows),
  };
}

function readReportFields(value: unknown): FinanceSnapshotReportField[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((field) => {
    if (!isRecord(field)) {
      return [];
    }

    return [
      {
        fieldId: readOptionalString(field.fieldId),
        description: readOptionalString(field.description),
        value: readOptionalString(field.value),
      },
    ];
  });
}

function readReportRows(value: unknown): FinanceSnapshotReportRow[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((row) => {
    if (!isRecord(row)) {
      return [];
    }

    return [
      {
        rowType: readOptionalString(row.rowType),
        title: readOptionalString(row.title),
        cells: readReportCells(row.cells),
        rows: readReportRows(row.rows),
      },
    ];
  });
}

function readReportCells(value: unknown): FinanceSnapshotReportCell[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((cell) => {
    if (!isRecord(cell)) {
      return [];
    }

    return [
      {
        value: readOptionalString(cell.value),
      },
    ];
  });
}

function findRevenueSection(
  rows: FinanceSnapshotReportRow[]
): FinanceSnapshotReportRow | null {
  for (const row of rows) {
    const title = row.title?.toLowerCase();

    if (
      row.rowType?.toLowerCase() === "section" &&
      title &&
      (title.includes("income") || title.includes("revenue"))
    ) {
      return row;
    }

    const nestedMatch = findRevenueSection(row.rows);
    if (nestedMatch) {
      return nestedMatch;
    }
  }

  return null;
}

function extractRevenueLineItems(
  section: FinanceSnapshotReportRow
): ParsedRevenueLineItem[] {
  const lineItems = new Map<string, number>();

  const visit = (row: FinanceSnapshotReportRow) => {
    if (row.rowType?.toLowerCase() === "row") {
      const label = readRevenueLabel(row);
      const amountCents = readRowAmountCents(row);

      if (label && amountCents !== null) {
        lineItems.set(label, (lineItems.get(label) ?? 0) + amountCents);
      }
    }

    for (const nestedRow of row.rows) {
      visit(nestedRow);
    }
  };

  for (const row of section.rows) {
    visit(row);
  }

  return Array.from(lineItems.entries())
    .map(([label, amountCents]) => ({
      label,
      amountCents,
    }))
    .sort((left, right) => right.amountCents - left.amountCents);
}

function extractRevenueSummaryCents(
  section: FinanceSnapshotReportRow
): number | null {
  const summaryRows = flattenReportRows(section.rows).filter(
    (row) => row.rowType?.toLowerCase() === "summaryrow"
  );

  for (const row of summaryRows) {
    const label = readRevenueLabel(row)?.toLowerCase();
    const amountCents = readRowAmountCents(row);

    if (
      amountCents !== null &&
      label &&
      (label.includes("total income") || label.includes("total revenue"))
    ) {
      return amountCents;
    }
  }

  for (const row of summaryRows) {
    const amountCents = readRowAmountCents(row);

    if (amountCents !== null) {
      return amountCents;
    }
  }

  return null;
}

function flattenReportRows(rows: FinanceSnapshotReportRow[]) {
  const flattened: FinanceSnapshotReportRow[] = [];

  for (const row of rows) {
    flattened.push(row, ...flattenReportRows(row.rows));
  }

  return flattened;
}

function sumRevenueLineItems(lineItems: ParsedRevenueLineItem[]) {
  if (lineItems.length === 0) {
    return null;
  }

  return lineItems.reduce((total, lineItem) => total + lineItem.amountCents, 0);
}

function readPeriodLabel(payload: FinanceSnapshotReportPayload) {
  const periodField =
    payload.fields.find((field) =>
      [field.fieldId, field.description]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes("period"))
    )?.value ?? null;

  if (periodField) {
    return periodField;
  }

  const titledPeriod = [...payload.reportTitles].reverse().find((title) =>
    /\b\d{4}\b/.test(title)
  );

  return titledPeriod ?? payload.reportDate;
}

function readRevenueLabel(row: FinanceSnapshotReportRow) {
  return (
    row.cells
      .map((cell) => cell.value?.trim())
      .find((value): value is string => Boolean(value)) ?? row.title
  );
}

function readRowAmountCents(row: FinanceSnapshotReportRow) {
  for (const cell of [...row.cells].reverse()) {
    const amountCents = parseFinanceAmountToCents(cell.value);

    if (amountCents !== null) {
      return amountCents;
    }
  }

  return null;
}

function parseFinanceAmountToCents(value: string | null) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const isBracketNegative =
    trimmed.startsWith("(") && trimmed.endsWith(")") && trimmed.length > 2;
  const normalized = (isBracketNegative ? trimmed.slice(1, -1) : trimmed).replace(
    /,/g,
    ""
  );
  const parsed = Number.parseFloat(normalized);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.round((isBracketNegative ? parsed * -1 : parsed) * 100);
}

function formatFinanceAmount(amountCents: number) {
  return formatCents(amountCents);
}

function formatSnapshotWindow(
  periodStart: Date | null,
  periodEnd: Date | null
) {
  if (!periodStart && !periodEnd) {
    return "Snapshot period not recorded";
  }

  if (!periodStart) {
    return `Through ${formatDisplayDate(periodEnd!)}`;
  }

  if (!periodEnd) {
    return `From ${formatDisplayDate(periodStart)}`;
  }

  return `${formatDisplayDate(periodStart)} to ${formatDisplayDate(periodEnd)}`;
}

function formatMonthYear(date: Date) {
  return date.toLocaleDateString("en-NZ", {
    month: "long",
    year: "numeric",
    timeZone: FINANCE_TIMEZONE,
  });
}

function formatDisplayDate(date: Date) {
  return date.toLocaleDateString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: FINANCE_TIMEZONE,
  });
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: FINANCE_TIMEZONE,
  });
}

function formatWholeNumber(value: number) {
  return new Intl.NumberFormat("en-NZ", {
    maximumFractionDigits: 0,
  }).format(value);
}

function readSearchParam(
  searchParams: FinanceRevenueReportSearchParams | undefined,
  key: string
) {
  const value = searchParams?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
