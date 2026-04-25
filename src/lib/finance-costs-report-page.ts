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
const DEFAULT_FINANCE_COSTS_PERIODS = 6;
const MAX_FINANCE_COSTS_PERIODS = 24;
const MIN_FINANCE_COSTS_PERIODS = 1;
const COST_SECTION_KEYWORDS = [
  "expense",
  "cost of sales",
  "cost of goods sold",
  "direct costs",
];
const COST_SUMMARY_KEYWORDS = [
  "total expense",
  "total expenses",
  "total operating expenses",
  "operating expenses",
  "total direct costs",
  "direct costs",
  "total cost of sales",
  "cost of sales",
  "cost of goods sold",
];

type FinanceCostsReportSearchParams = Record<
  string,
  string | string[] | undefined
>;

export type FinanceCostSnapshotRecord = Awaited<
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

export interface ParsedCostLineItem {
  section: string;
  lineItem: string;
  amountCents: number;
}

export interface ParsedCostsSnapshot {
  snapshotId: string;
  periodLabel: string;
  asOfDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  sourceWindow: string;
  totalCostsCents: number;
  totalCosts: string;
  lineItemCount: number;
  asOfDateLabel: string;
  sourceUpdatedAtLabel: string;
  lineItems: ParsedCostLineItem[];
}

export interface FinanceCostsReportFilters {
  periods: number;
}

export interface FinanceCostsReportSummaryCard {
  title: string;
  value: string;
  description: string;
  footnote?: string;
}

export interface FinanceCostsReportMonthlyRow {
  snapshotId: string;
  periodLabel: string;
  sourceWindow: string;
  totalCosts: string;
  lineItemCount: string;
  asOfDateLabel: string;
  sourceUpdatedAtLabel: string;
}

export interface FinanceCostsReportLineItemRow {
  section: string;
  lineItem: string;
  latestPeriodAmount: string;
  selectedPeriodsAmount: string;
  periodsPresent: string;
}

export interface FinanceCostsReportPageModel {
  generatedOn: string;
  isManager: boolean;
  filters: FinanceCostsReportFilters;
  reportHref: string;
  filterWarnings: string[];
  loadError?: string;
  coverageSummary: string;
  summaryCards: FinanceCostsReportSummaryCard[];
  monthlyRows: FinanceCostsReportMonthlyRow[];
  lineItemRows: FinanceCostsReportLineItemRow[];
  sourceNotes: Array<{
    label: string;
    description: string;
  }>;
}

export function buildDefaultFinanceCostsReportFilters() {
  return {
    periods: DEFAULT_FINANCE_COSTS_PERIODS,
  } satisfies FinanceCostsReportFilters;
}

export function buildFinanceCostsReportQueryString(
  filters: FinanceCostsReportFilters
) {
  return new URLSearchParams({
    periods: String(filters.periods),
  }).toString();
}

export function buildFinanceCostsReportHref(filters: FinanceCostsReportFilters) {
  return `/finance/costs?${buildFinanceCostsReportQueryString(filters)}`;
}

export function resolveFinanceCostsReportFilters(input: {
  searchParams?: FinanceCostsReportSearchParams;
}) {
  const filters = buildDefaultFinanceCostsReportFilters();
  const warnings: string[] = [];
  const requestedPeriods = readSearchParam(input.searchParams, "periods");

  if (!requestedPeriods) {
    return { filters, warnings };
  }

  const normalizedPeriods = requestedPeriods.trim();

  if (!/^\d+$/.test(normalizedPeriods)) {
    warnings.push(
      `Costs periods must be a whole number between ${MIN_FINANCE_COSTS_PERIODS} and ${MAX_FINANCE_COSTS_PERIODS}. Showing the default ${DEFAULT_FINANCE_COSTS_PERIODS}-period window.`
    );
    return { filters, warnings };
  }

  const parsedPeriods = Number(normalizedPeriods);

  if (
    !Number.isInteger(parsedPeriods) ||
    parsedPeriods < MIN_FINANCE_COSTS_PERIODS ||
    parsedPeriods > MAX_FINANCE_COSTS_PERIODS
  ) {
    warnings.push(
      `Costs periods must be a whole number between ${MIN_FINANCE_COSTS_PERIODS} and ${MAX_FINANCE_COSTS_PERIODS}. Showing the default ${DEFAULT_FINANCE_COSTS_PERIODS}-period window.`
    );
    return { filters, warnings };
  }

  filters.periods = parsedPeriods;
  return { filters, warnings };
}

export async function buildFinanceCostsReportPageModel(input: {
  member: FinanceAccessMember;
  searchParams?: FinanceCostsReportSearchParams;
}): Promise<FinanceCostsReportPageModel> {
  const { filters, warnings } = resolveFinanceCostsReportFilters({
    searchParams: input.searchParams,
  });
  const reportHref = buildFinanceCostsReportHref(filters);

  try {
    const snapshots = await listFinanceSnapshots({
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
      scope: DEFAULT_FINANCE_SNAPSHOT_SCOPE,
      limit: filters.periods,
    });
    const parsedSnapshots = snapshots
      .map((snapshot) => parseCostsSnapshot(snapshot))
      .filter((snapshot): snapshot is ParsedCostsSnapshot => snapshot !== null);
    const skippedSnapshotCount = snapshots.length - parsedSnapshots.length;

    if (snapshots.length === 0) {
      return buildUnavailableCostsReportModel({
        filters,
        reportHref,
        isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
        warnings,
        loadError:
          "No monthly finance costs snapshots are available yet. Run the finance sync and try again once the profit-and-loss dataset has landed.",
      });
    }

    if (skippedSnapshotCount > 0) {
      warnings.push(
        `${skippedSnapshotCount} stored costs snapshot${skippedSnapshotCount === 1 ? "" : "s"} could not be parsed and ${skippedSnapshotCount === 1 ? "was" : "were"} ignored.`
      );
    }

    if (parsedSnapshots.length === 0) {
      return buildUnavailableCostsReportModel({
        filters,
        reportHref,
        isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
        warnings,
        loadError:
          "Finance costs snapshots are temporarily unavailable. Try again shortly after the next finance sync completes.",
      });
    }

    const latestSnapshot = parsedSnapshots[0];
    const totalCostsCents = parsedSnapshots.reduce(
      (total, snapshot) => total + snapshot.totalCostsCents,
      0
    );
    const averageCostsCents = Math.round(
      totalCostsCents / parsedSnapshots.length
    );
    const lineItemRows = buildCostsLineItemRows(parsedSnapshots);

    return {
      generatedOn: formatDateTime(new Date().toISOString()),
      isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
      filters,
      reportHref,
      filterWarnings: warnings,
      coverageSummary: `Showing ${parsedSnapshots.length} monthly profit-and-loss snapshot${parsedSnapshots.length === 1 ? "" : "s"} with cost detail from ${latestSnapshot.periodLabel} backwards.`,
      summaryCards: [
        {
          title: "Latest synced month",
          value: latestSnapshot.totalCosts,
          description: `${latestSnapshot.periodLabel} expense total from the latest stored profit-and-loss snapshot.`,
          footnote: `${latestSnapshot.sourceWindow}. Updated ${latestSnapshot.sourceUpdatedAtLabel}.`,
        },
        {
          title: "Selected periods total",
          value: formatFinanceAmount(totalCostsCents),
          description: `Combined costs across ${parsedSnapshots.length} stored monthly finance snapshot${parsedSnapshots.length === 1 ? "" : "s"}.`,
        },
        {
          title: "Average monthly costs",
          value: formatFinanceAmount(averageCostsCents),
          description:
            "Average expense total across the selected stored monthly profit-and-loss periods.",
        },
        {
          title: "Cost lines tracked",
          value: formatWholeNumber(lineItemRows.length),
          description:
            "Unique cost line items found across the selected finance snapshots.",
          footnote: `${formatWholeNumber(parsedSnapshots.length)} period${parsedSnapshots.length === 1 ? "" : "s"} loaded from durable FinanceSnapshot storage.`,
        },
      ],
      monthlyRows: parsedSnapshots.map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        periodLabel: snapshot.periodLabel,
        sourceWindow: snapshot.sourceWindow,
        totalCosts: snapshot.totalCosts,
        lineItemCount: formatWholeNumber(snapshot.lineItemCount),
        asOfDateLabel: snapshot.asOfDateLabel,
        sourceUpdatedAtLabel: snapshot.sourceUpdatedAtLabel,
      })),
      lineItemRows,
      sourceNotes: buildCostsSourceNotes(),
    };
  } catch (error) {
    console.error("Failed to load finance costs report snapshots", error);

    return buildUnavailableCostsReportModel({
      filters,
      reportHref,
      isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
      warnings,
      loadError:
        "Finance costs snapshots are temporarily unavailable. Try again shortly or use manager diagnostics to confirm the latest finance sync status.",
    });
  }
}

function buildUnavailableCostsReportModel(input: {
  filters: FinanceCostsReportFilters;
  reportHref: string;
  isManager: boolean;
  warnings: string[];
  loadError: string;
}): FinanceCostsReportPageModel {
  return {
    generatedOn: formatDateTime(new Date().toISOString()),
    isManager: input.isManager,
    filters: input.filters,
    reportHref: input.reportHref,
    filterWarnings: input.warnings,
    loadError: input.loadError,
    coverageSummary: "Costs snapshots unavailable",
    summaryCards: [],
    monthlyRows: [],
    lineItemRows: [],
    sourceNotes: buildCostsSourceNotes(),
  };
}

function buildCostsSourceNotes() {
  return [
    {
      label: "Finance snapshot source",
      description:
        "Costs on this page come from stored `PROFIT_AND_LOSS_MONTHLY` FinanceSnapshot rows synced through the finance-only Xero boundary. They are not derived from Tokoroa Alpine Club booking or payment data.",
    },
    {
      label: "Durable read path",
      description:
        "The page reads durable monthly snapshots already stored in Postgres. It does not trigger a live Xero report call or a manual finance sync.",
    },
    {
      label: "Scope boundary",
      description:
        "This report is cost-only. It keeps finance snapshot-backed expense figures distinct from Tokoroa Alpine Club booking revenue, payment-derived cash, balance-sheet positions, and pricing-sensitivity analysis.",
    },
  ];
}

function buildCostsLineItemRows(
  snapshots: ParsedCostsSnapshot[]
): FinanceCostsReportLineItemRow[] {
  const latestSnapshot = snapshots[0];
  const lineItemsByKey = new Map<
    string,
    {
      section: string;
      lineItem: string;
      latestPeriodAmountCents: number | null;
      selectedPeriodsAmountCents: number;
      periodsPresent: number;
    }
  >();

  for (const snapshot of snapshots) {
    for (const lineItem of snapshot.lineItems) {
      const key = `${lineItem.section}::${lineItem.lineItem}`;
      const existing = lineItemsByKey.get(key) ?? {
        section: lineItem.section,
        lineItem: lineItem.lineItem,
        latestPeriodAmountCents: null,
        selectedPeriodsAmountCents: 0,
        periodsPresent: 0,
      };

      existing.selectedPeriodsAmountCents += lineItem.amountCents;
      existing.periodsPresent += 1;

      if (snapshot.snapshotId === latestSnapshot.snapshotId) {
        existing.latestPeriodAmountCents = lineItem.amountCents;
      }

      lineItemsByKey.set(key, existing);
    }
  }

  return Array.from(lineItemsByKey.values())
    .sort((left, right) => {
      if (left.section !== right.section) {
        return left.section.localeCompare(right.section);
      }

      if (right.selectedPeriodsAmountCents !== left.selectedPeriodsAmountCents) {
        return right.selectedPeriodsAmountCents - left.selectedPeriodsAmountCents;
      }

      return left.lineItem.localeCompare(right.lineItem);
    })
    .map((summary) => ({
      section: summary.section,
      lineItem: summary.lineItem,
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

export function parseCostsSnapshot(
  snapshot: FinanceCostSnapshotRecord
): ParsedCostsSnapshot | null {
  const payload = readReportPayload(snapshot.payload);

  if (!payload) {
    return null;
  }

  const costSections = findCostSections(payload.rows);

  if (costSections.length === 0) {
    return null;
  }

  const lineItems = extractCostLineItems(costSections);
  const totalCostsCents =
    extractCostsSummaryCents(costSections) ?? sumCostLineItems(lineItems);

  if (totalCostsCents === null) {
    return null;
  }

  const periodLabel =
    readPeriodLabel(payload) ??
    formatMonthYear(snapshot.periodEnd ?? snapshot.asOfDate);

  return {
    snapshotId: snapshot.id,
    periodLabel,
    asOfDate: snapshot.asOfDate.toISOString().slice(0, 10),
    periodStart: snapshot.periodStart
      ? snapshot.periodStart.toISOString().slice(0, 10)
      : null,
    periodEnd: snapshot.periodEnd
      ? snapshot.periodEnd.toISOString().slice(0, 10)
      : null,
    sourceWindow: formatSnapshotWindow(snapshot.periodStart, snapshot.periodEnd),
    totalCostsCents,
    totalCosts: formatFinanceAmount(totalCostsCents),
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

function findCostSections(rows: FinanceSnapshotReportRow[]) {
  const sections: FinanceSnapshotReportRow[] = [];

  const visit = (row: FinanceSnapshotReportRow) => {
    const title = row.title?.toLowerCase();

    if (
      row.rowType?.toLowerCase() === "section" &&
      title &&
      COST_SECTION_KEYWORDS.some((keyword) => title.includes(keyword))
    ) {
      sections.push(row);
      return;
    }

    for (const nestedRow of row.rows) {
      visit(nestedRow);
    }
  };

  for (const row of rows) {
    visit(row);
  }

  return sections;
}

function extractCostLineItems(sections: FinanceSnapshotReportRow[]) {
  const lineItems = new Map<string, ParsedCostLineItem>();

  const visit = (row: FinanceSnapshotReportRow, sectionPath: string[]) => {
    const nextSectionPath =
      row.rowType?.toLowerCase() === "section" && row.title
        ? [...sectionPath, row.title]
        : sectionPath;

    if (row.rowType?.toLowerCase() === "row") {
      const lineItem = readRowLabel(row);
      const amountCents = readRowAmountCents(row);

      if (
        lineItem &&
        amountCents !== null &&
        !lineItem.toLowerCase().includes("total")
      ) {
        const section =
          nextSectionPath.length > 0
            ? nextSectionPath.join(" / ")
            : "Uncategorised";
        const key = `${section}::${lineItem}`;
        const existing = lineItems.get(key);

        if (existing) {
          existing.amountCents += amountCents;
        } else {
          lineItems.set(key, {
            section,
            lineItem,
            amountCents,
          });
        }
      }
    }

    for (const nestedRow of row.rows) {
      visit(nestedRow, nextSectionPath);
    }
  };

  for (const section of sections) {
    const initialSectionPath = section.title ? [section.title] : [];

    for (const row of section.rows) {
      visit(row, initialSectionPath);
    }
  }

  return Array.from(lineItems.values());
}

function extractCostsSummaryCents(sections: FinanceSnapshotReportRow[]) {
  const sectionTotals = sections
    .map((section) => extractCostSectionSummaryCents(section))
    .filter((amount): amount is number => amount !== null);

  if (sectionTotals.length > 0) {
    return sectionTotals.reduce((total, amount) => total + amount, 0);
  }

  return null;
}

function extractCostSectionSummaryCents(section: FinanceSnapshotReportRow) {
  const summaryRows = flattenReportRows(section.rows).filter(
    (row) => row.rowType?.toLowerCase() === "summaryrow"
  );

  for (const row of summaryRows) {
    const label = readRowLabel(row)?.toLowerCase();
    const amountCents = readRowAmountCents(row);

    if (
      amountCents !== null &&
      label &&
      COST_SUMMARY_KEYWORDS.some((keyword) => label.includes(keyword))
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

  return sumCostLineItems(extractCostLineItems([section]));
}

function flattenReportRows(rows: FinanceSnapshotReportRow[]) {
  const flattened: FinanceSnapshotReportRow[] = [];

  for (const row of rows) {
    flattened.push(row, ...flattenReportRows(row.rows));
  }

  return flattened;
}

function sumCostLineItems(lineItems: ParsedCostLineItem[]) {
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

function readRowLabel(row: FinanceSnapshotReportRow) {
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
  searchParams: FinanceCostsReportSearchParams | undefined,
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
