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
const DEFAULT_FINANCE_BALANCE_SHEET_PERIODS = 6;
const MAX_FINANCE_BALANCE_SHEET_PERIODS = 24;
const MIN_FINANCE_BALANCE_SHEET_PERIODS = 1;

type FinanceBalanceSheetReportSearchParams = Record<
  string,
  string | string[] | undefined
>;

export type FinanceBalanceSheetSnapshotRecord = Awaited<
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

interface ParsedBalanceSheetLineItem {
  sectionPath: string;
  lineItem: string;
  amountCents: number;
}

export interface ParsedBalanceSheetSnapshot {
  snapshotId: string;
  snapshotLabel: string;
  sourceWindow: string;
  totalAssetsCents: number;
  totalAssets: string;
  currentAssetsCents: number | null;
  currentAssets: string | null;
  totalLiabilitiesCents: number;
  totalLiabilities: string;
  currentLiabilitiesCents: number | null;
  currentLiabilities: string | null;
  netAssetsCents: number;
  netAssets: string;
  workingCapitalCents: number | null;
  workingCapital: string | null;
  currentRatio: number | null;
  lineItemCount: number;
  currentAssetLineItemCount: number;
  currentLiabilityLineItemCount: number;
  sourceUpdatedAtLabel: string;
  lineItems: ParsedBalanceSheetLineItem[];
}

export interface FinanceBalanceSheetReportFilters {
  periods: number;
}

export interface FinanceBalanceSheetReportSummaryCard {
  title: string;
  value: string;
  description: string;
  footnote?: string;
}

export interface FinanceBalanceSheetReportSnapshotRow {
  snapshotId: string;
  asOfDateLabel: string;
  sourceWindow: string;
  totalAssets: string;
  totalLiabilities: string;
  netAssets: string;
  lineItemCount: string;
  sourceUpdatedAtLabel: string;
}

export interface FinanceBalanceSheetReportLineItemRow {
  section: string;
  lineItem: string;
  latestAmount: string;
  selectedAverage: string;
  selectedRange: string;
  periodsPresent: string;
}

export interface FinanceBalanceSheetReportPageModel {
  generatedOn: string;
  isManager: boolean;
  filters: FinanceBalanceSheetReportFilters;
  reportHref: string;
  filterWarnings: string[];
  loadError?: string;
  coverageSummary: string;
  summaryCards: FinanceBalanceSheetReportSummaryCard[];
  snapshotRows: FinanceBalanceSheetReportSnapshotRow[];
  lineItemRows: FinanceBalanceSheetReportLineItemRow[];
  sourceNotes: Array<{
    label: string;
    description: string;
  }>;
}

export function buildDefaultFinanceBalanceSheetReportFilters() {
  return {
    periods: DEFAULT_FINANCE_BALANCE_SHEET_PERIODS,
  } satisfies FinanceBalanceSheetReportFilters;
}

export function buildFinanceBalanceSheetReportQueryString(
  filters: FinanceBalanceSheetReportFilters,
) {
  return new URLSearchParams({
    periods: String(filters.periods),
  }).toString();
}

export function buildFinanceBalanceSheetReportHref(
  filters: FinanceBalanceSheetReportFilters,
) {
  return `/finance/balance-sheet?${buildFinanceBalanceSheetReportQueryString(filters)}`;
}

export function resolveFinanceBalanceSheetReportFilters(input: {
  searchParams?: FinanceBalanceSheetReportSearchParams;
}) {
  const filters = buildDefaultFinanceBalanceSheetReportFilters();
  const warnings: string[] = [];
  const requestedPeriods = readSearchParam(input.searchParams, "periods");

  if (!requestedPeriods) {
    return { filters, warnings };
  }

  const normalizedPeriods = requestedPeriods.trim();

  if (!/^\d+$/.test(normalizedPeriods)) {
    warnings.push(
      `Balance-sheet periods must be a whole number between ${MIN_FINANCE_BALANCE_SHEET_PERIODS} and ${MAX_FINANCE_BALANCE_SHEET_PERIODS}. Showing the default ${DEFAULT_FINANCE_BALANCE_SHEET_PERIODS}-period window.`,
    );
    return { filters, warnings };
  }

  const parsedPeriods = Number(normalizedPeriods);

  if (
    !Number.isInteger(parsedPeriods) ||
    parsedPeriods < MIN_FINANCE_BALANCE_SHEET_PERIODS ||
    parsedPeriods > MAX_FINANCE_BALANCE_SHEET_PERIODS
  ) {
    warnings.push(
      `Balance-sheet periods must be a whole number between ${MIN_FINANCE_BALANCE_SHEET_PERIODS} and ${MAX_FINANCE_BALANCE_SHEET_PERIODS}. Showing the default ${DEFAULT_FINANCE_BALANCE_SHEET_PERIODS}-period window.`,
    );
    return { filters, warnings };
  }

  filters.periods = parsedPeriods;
  return { filters, warnings };
}

export async function buildFinanceBalanceSheetReportPageModel(input: {
  member: FinanceAccessMember;
  searchParams?: FinanceBalanceSheetReportSearchParams;
}): Promise<FinanceBalanceSheetReportPageModel> {
  const { filters, warnings } = resolveFinanceBalanceSheetReportFilters({
    searchParams: input.searchParams,
  });
  const reportHref = buildFinanceBalanceSheetReportHref(filters);

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
      return buildUnavailableBalanceSheetReportModel({
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
      return buildUnavailableBalanceSheetReportModel({
        filters,
        reportHref,
        isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
        warnings,
        loadError:
          "Finance balance-sheet snapshots are temporarily unavailable. Try again shortly after the next finance sync completes.",
      });
    }

    const latestSnapshot = parsedSnapshots[0];
    const lineItemRows = buildBalanceSheetLineItemRows(parsedSnapshots);

    return {
      generatedOn: formatDateTime(new Date().toISOString()),
      isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
      filters,
      reportHref,
      filterWarnings: warnings,
      coverageSummary: `Showing ${parsedSnapshots.length} stored balance-sheet snapshot${parsedSnapshots.length === 1 ? "" : "s"} from ${latestSnapshot.snapshotLabel} backwards.`,
      summaryCards: [
        {
          title: "Latest total assets",
          value: latestSnapshot.totalAssets,
          description:
            "Assets total from the latest stored balance-sheet snapshot.",
          footnote: `${latestSnapshot.sourceWindow}. Updated ${latestSnapshot.sourceUpdatedAtLabel}.`,
        },
        {
          title: "Latest total liabilities",
          value: latestSnapshot.totalLiabilities,
          description:
            "Liabilities total from the latest stored balance-sheet snapshot.",
        },
        {
          title: "Latest net assets",
          value: latestSnapshot.netAssets,
          description:
            "Net assets / equity total from the latest stored balance-sheet snapshot.",
        },
        {
          title: "Balance-sheet lines tracked",
          value: formatWholeNumber(lineItemRows.length),
          description:
            "Unique balance-sheet line items found across the selected stored snapshots.",
          footnote:
            latestSnapshot.lineItemCount > 0
              ? `${formatWholeNumber(latestSnapshot.lineItemCount)} line item${latestSnapshot.lineItemCount === 1 ? "" : "s"} appeared in the latest stored snapshot.`
              : "No balance-sheet detail rows were available in the latest stored snapshot.",
        },
      ],
      snapshotRows: parsedSnapshots.map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        asOfDateLabel: snapshot.snapshotLabel,
        sourceWindow: snapshot.sourceWindow,
        totalAssets: snapshot.totalAssets,
        totalLiabilities: snapshot.totalLiabilities,
        netAssets: snapshot.netAssets,
        lineItemCount: formatWholeNumber(snapshot.lineItemCount),
        sourceUpdatedAtLabel: snapshot.sourceUpdatedAtLabel,
      })),
      lineItemRows,
      sourceNotes: buildBalanceSheetSourceNotes(),
    };
  } catch (error) {
    console.error(
      "Failed to load finance balance-sheet report snapshots",
      error,
    );

    return buildUnavailableBalanceSheetReportModel({
      filters,
      reportHref,
      isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
      warnings,
      loadError:
        "Finance balance-sheet snapshots are temporarily unavailable. Try again shortly or use manager diagnostics to confirm the latest finance sync status.",
    });
  }
}

function buildUnavailableBalanceSheetReportModel(input: {
  filters: FinanceBalanceSheetReportFilters;
  reportHref: string;
  isManager: boolean;
  warnings: string[];
  loadError: string;
}): FinanceBalanceSheetReportPageModel {
  return {
    generatedOn: formatDateTime(new Date().toISOString()),
    isManager: input.isManager,
    filters: input.filters,
    reportHref: input.reportHref,
    filterWarnings: input.warnings,
    loadError: input.loadError,
    coverageSummary: "Balance-sheet snapshots unavailable",
    summaryCards: [],
    snapshotRows: [],
    lineItemRows: [],
    sourceNotes: buildBalanceSheetSourceNotes(),
  };
}

function buildBalanceSheetSourceNotes() {
  return [
    {
      label: "Finance snapshot source",
      description:
        "Balance-sheet figures on this page come from stored `BALANCE_SHEET` FinanceSnapshot rows synced through the finance-only Xero boundary. They are not derived from Tokoroa Alpine Club booking or payment data.",
    },
    {
      label: "Stored positions only",
      description:
        "The report reflects stored assets, liabilities, and equity positions for the selected snapshots and keeps those figures distinct from Tokoroa Alpine Club operational booking metrics, payment-derived cash summaries, and the native cash report.",
    },
    {
      label: "Durable read path",
      description:
        "The page reads durable balance-sheet snapshots already stored in Postgres. It does not trigger a live Xero report call, manual sync mutation, costs rollup, or working-capital calculation.",
    },
  ];
}

function buildBalanceSheetLineItemRows(
  snapshots: ParsedBalanceSheetSnapshot[],
): FinanceBalanceSheetReportLineItemRow[] {
  const latestSnapshot = snapshots[0];
  const lineItemSummaries = new Map<
    string,
    {
      section: string;
      lineItem: string;
      latestAmountCents: number | null;
      selectedTotalAmountCents: number;
      lowestAmountCents: number | null;
      highestAmountCents: number | null;
      periodsPresent: number;
    }
  >();

  for (const snapshot of snapshots) {
    for (const lineItem of snapshot.lineItems) {
      const key = `${lineItem.sectionPath}::${lineItem.lineItem}`;
      const existing = lineItemSummaries.get(key) ?? {
        section: lineItem.sectionPath,
        lineItem: lineItem.lineItem,
        latestAmountCents: null,
        selectedTotalAmountCents: 0,
        lowestAmountCents: null,
        highestAmountCents: null,
        periodsPresent: 0,
      };

      existing.selectedTotalAmountCents += lineItem.amountCents;
      existing.periodsPresent += 1;
      existing.lowestAmountCents =
        existing.lowestAmountCents === null
          ? lineItem.amountCents
          : Math.min(existing.lowestAmountCents, lineItem.amountCents);
      existing.highestAmountCents =
        existing.highestAmountCents === null
          ? lineItem.amountCents
          : Math.max(existing.highestAmountCents, lineItem.amountCents);

      if (snapshot.snapshotId === latestSnapshot.snapshotId) {
        existing.latestAmountCents = lineItem.amountCents;
      }

      lineItemSummaries.set(key, existing);
    }
  }

  return Array.from(lineItemSummaries.values())
    .sort((left, right) => {
      const sectionOrderDifference =
        getBalanceSheetSectionOrder(left.section) -
        getBalanceSheetSectionOrder(right.section);

      if (sectionOrderDifference !== 0) {
        return sectionOrderDifference;
      }

      if (left.section !== right.section) {
        return left.section.localeCompare(right.section);
      }

      const leftLatest = left.latestAmountCents ?? Number.NEGATIVE_INFINITY;
      const rightLatest = right.latestAmountCents ?? Number.NEGATIVE_INFINITY;

      if (rightLatest !== leftLatest) {
        return rightLatest - leftLatest;
      }

      if (right.selectedTotalAmountCents !== left.selectedTotalAmountCents) {
        return right.selectedTotalAmountCents - left.selectedTotalAmountCents;
      }

      return left.lineItem.localeCompare(right.lineItem);
    })
    .map((summary) => ({
      section: summary.section,
      lineItem: summary.lineItem,
      latestAmount:
        summary.latestAmountCents === null
          ? "—"
          : formatFinanceAmount(summary.latestAmountCents),
      selectedAverage: formatFinanceAmount(
        Math.round(summary.selectedTotalAmountCents / summary.periodsPresent),
      ),
      selectedRange: formatFinanceAmountRange(
        summary.lowestAmountCents ?? 0,
        summary.highestAmountCents ?? 0,
      ),
      periodsPresent: formatWholeNumber(summary.periodsPresent),
    }));
}

export function parseBalanceSheetSnapshot(
  snapshot: FinanceBalanceSheetSnapshotRecord,
): ParsedBalanceSheetSnapshot | null {
  const payload = readReportPayload(snapshot.payload);

  if (!payload) {
    return null;
  }

  const assetsSection = findBalanceSheetSection(payload.rows, ["asset"]);
  const liabilitiesSection = findBalanceSheetSection(payload.rows, [
    "liabilit",
  ]);

  if (!assetsSection || !liabilitiesSection) {
    return null;
  }

  const totalAssetsCents =
    extractSectionTotalCents(assetsSection, ["total assets"]) ??
    sumLineItemsInSection(assetsSection);
  const totalLiabilitiesCents =
    extractSectionTotalCents(liabilitiesSection, ["total liabilities"]) ??
    sumLineItemsInSection(liabilitiesSection);

  if (totalAssetsCents === null || totalLiabilitiesCents === null) {
    return null;
  }

  const currentAssetsSection = findBalanceSheetSection(assetsSection.rows, [
    "current asset",
  ]);
  const currentLiabilitiesSection = findBalanceSheetSection(
    liabilitiesSection.rows,
    ["current liabilit"],
  );
  const currentAssetsCents = currentAssetsSection
    ? (extractSectionTotalCents(currentAssetsSection, [
        "total current assets",
        "current assets",
      ]) ?? sumLineItemsInSection(currentAssetsSection))
    : null;
  const currentLiabilitiesCents = currentLiabilitiesSection
    ? (extractSectionTotalCents(currentLiabilitiesSection, [
        "total current liabilities",
        "current liabilities",
      ]) ?? sumLineItemsInSection(currentLiabilitiesSection))
    : null;

  const equitySection = findBalanceSheetSection(payload.rows, [
    "equity",
    "net asset",
  ]);
  const netAssetsCents =
    (equitySection
      ? (extractSectionTotalCents(equitySection, [
          "total equity",
          "equity",
          "total net assets",
          "net assets",
        ]) ?? sumLineItemsInSection(equitySection))
      : null) ?? totalAssetsCents - totalLiabilitiesCents;
  const lineItems = extractBalanceSheetLineItems(payload.rows);
  const workingCapitalCents =
    currentAssetsCents !== null && currentLiabilitiesCents !== null
      ? currentAssetsCents - currentLiabilitiesCents
      : null;
  const currentRatio =
    currentAssetsCents !== null &&
    currentLiabilitiesCents !== null &&
    currentLiabilitiesCents !== 0
      ? currentAssetsCents / currentLiabilitiesCents
      : null;
  const currentAssetLineItemCount = currentAssetsSection
    ? extractBalanceSheetLineItems(currentAssetsSection.rows).length
    : 0;
  const currentLiabilityLineItemCount = currentLiabilitiesSection
    ? extractBalanceSheetLineItems(currentLiabilitiesSection.rows).length
    : 0;

  return {
    snapshotId: snapshot.id,
    snapshotLabel: formatDisplayDate(snapshot.asOfDate),
    sourceWindow: formatSnapshotWindow(
      snapshot.periodStart,
      snapshot.periodEnd,
    ),
    totalAssetsCents,
    totalAssets: formatFinanceAmount(totalAssetsCents),
    currentAssetsCents,
    currentAssets:
      currentAssetsCents === null
        ? null
        : formatFinanceAmount(currentAssetsCents),
    totalLiabilitiesCents,
    totalLiabilities: formatFinanceAmount(totalLiabilitiesCents),
    currentLiabilitiesCents,
    currentLiabilities:
      currentLiabilitiesCents === null
        ? null
        : formatFinanceAmount(currentLiabilitiesCents),
    netAssetsCents,
    netAssets: formatFinanceAmount(netAssetsCents),
    workingCapitalCents,
    workingCapital:
      workingCapitalCents === null
        ? null
        : formatFinanceAmount(workingCapitalCents),
    currentRatio,
    lineItemCount: lineItems.length,
    currentAssetLineItemCount,
    currentLiabilityLineItemCount,
    sourceUpdatedAtLabel: snapshot.sourceUpdatedAt
      ? formatDateTime(snapshot.sourceUpdatedAt.toISOString())
      : "Snapshot update time unavailable",
    lineItems,
  };
}

function readReportPayload(
  value: unknown,
): FinanceSnapshotReportPayload | null {
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

function findBalanceSheetSection(
  rows: FinanceSnapshotReportRow[],
  keywords: string[],
): FinanceSnapshotReportRow | null {
  for (const row of rows) {
    const title = row.title?.toLowerCase();

    if (
      row.rowType?.toLowerCase() === "section" &&
      title &&
      keywords.some((keyword) => title.includes(keyword))
    ) {
      return row;
    }

    const nestedMatch = findBalanceSheetSection(row.rows, keywords);
    if (nestedMatch) {
      return nestedMatch;
    }
  }

  return null;
}

function extractBalanceSheetLineItems(rows: FinanceSnapshotReportRow[]) {
  const lineItems = new Map<string, ParsedBalanceSheetLineItem>();

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
        const normalizedSectionPath =
          nextSectionPath.length > 0
            ? nextSectionPath.join(" / ")
            : "Uncategorised";
        const key = `${normalizedSectionPath}::${lineItem}`;
        const existing = lineItems.get(key);

        if (existing) {
          existing.amountCents += amountCents;
        } else {
          lineItems.set(key, {
            sectionPath: normalizedSectionPath,
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

  for (const row of rows) {
    visit(row, []);
  }

  return Array.from(lineItems.values());
}

function extractSectionTotalCents(
  section: FinanceSnapshotReportRow,
  summaryKeywords: string[],
) {
  const summaryRows = flattenReportRows(section.rows).filter(
    (row) => row.rowType?.toLowerCase() === "summaryrow",
  );

  for (const row of summaryRows) {
    const label = readRowLabel(row)?.toLowerCase();
    const amountCents = readRowAmountCents(row);

    if (
      amountCents !== null &&
      label &&
      summaryKeywords.some((keyword) => label.includes(keyword))
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

function sumLineItemsInSection(section: FinanceSnapshotReportRow) {
  const lineItems = extractBalanceSheetLineItems(section.rows);

  if (lineItems.length === 0) {
    return null;
  }

  return lineItems.reduce((total, lineItem) => total + lineItem.amountCents, 0);
}

function flattenReportRows(rows: FinanceSnapshotReportRow[]) {
  const flattened: FinanceSnapshotReportRow[] = [];

  for (const row of rows) {
    flattened.push(row, ...flattenReportRows(row.rows));
  }

  return flattened;
}

function getBalanceSheetSectionOrder(section: string) {
  const normalized = section.toLowerCase();

  if (normalized.includes("asset")) {
    return 0;
  }

  if (normalized.includes("liabilit")) {
    return 1;
  }

  if (normalized.includes("equity") || normalized.includes("net asset")) {
    return 2;
  }

  return 3;
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
  const normalized = (
    isBracketNegative ? trimmed.slice(1, -1) : trimmed
  ).replace(/,/g, "");
  const parsed = Number.parseFloat(normalized);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.round((isBracketNegative ? parsed * -1 : parsed) * 100);
}

function formatFinanceAmount(amountCents: number) {
  return formatCents(amountCents);
}

function formatFinanceAmountRange(
  minAmountCents: number,
  maxAmountCents: number,
) {
  if (minAmountCents === maxAmountCents) {
    return formatFinanceAmount(minAmountCents);
  }

  return `${formatFinanceAmount(minAmountCents)} to ${formatFinanceAmount(maxAmountCents)}`;
}

function formatSnapshotWindow(
  periodStart: Date | null,
  periodEnd: Date | null,
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
  searchParams: FinanceBalanceSheetReportSearchParams | undefined,
  key: string,
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
