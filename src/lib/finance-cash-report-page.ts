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
const DEFAULT_FINANCE_CASH_PERIODS = 7;
const MAX_FINANCE_CASH_PERIODS = 31;
const MIN_FINANCE_CASH_PERIODS = 1;

type FinanceCashReportSearchParams = Record<
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

interface ParsedCashAccount {
  label: string;
  balanceCents: number;
}

interface ParsedCashSnapshot {
  snapshotId: string;
  snapshotLabel: string;
  sourceWindow: string;
  totalBalanceCents: number;
  totalBalance: string;
  accountCount: number;
  sourceUpdatedAtLabel: string;
  accounts: ParsedCashAccount[];
}

export interface FinanceCashReportFilters {
  periods: number;
}

export interface FinanceCashReportSummaryCard {
  title: string;
  value: string;
  description: string;
  footnote?: string;
}

export interface FinanceCashReportSnapshotRow {
  snapshotId: string;
  asOfDateLabel: string;
  sourceWindow: string;
  totalBalance: string;
  accountCount: string;
  sourceUpdatedAtLabel: string;
}

export interface FinanceCashReportAccountRow {
  accountName: string;
  latestBalance: string;
  selectedAverage: string;
  selectedRange: string;
  periodsPresent: string;
}

export interface FinanceCashReportPageModel {
  generatedOn: string;
  isManager: boolean;
  filters: FinanceCashReportFilters;
  reportHref: string;
  filterWarnings: string[];
  loadError?: string;
  coverageSummary: string;
  summaryCards: FinanceCashReportSummaryCard[];
  snapshotRows: FinanceCashReportSnapshotRow[];
  accountRows: FinanceCashReportAccountRow[];
  sourceNotes: Array<{
    label: string;
    description: string;
  }>;
}

export function buildDefaultFinanceCashReportFilters() {
  return {
    periods: DEFAULT_FINANCE_CASH_PERIODS,
  } satisfies FinanceCashReportFilters;
}

export function buildFinanceCashReportQueryString(
  filters: FinanceCashReportFilters
) {
  return new URLSearchParams({
    periods: String(filters.periods),
  }).toString();
}

export function buildFinanceCashReportHref(filters: FinanceCashReportFilters) {
  return `/finance/cash?${buildFinanceCashReportQueryString(filters)}`;
}

export function resolveFinanceCashReportFilters(input: {
  searchParams?: FinanceCashReportSearchParams;
}) {
  const filters = buildDefaultFinanceCashReportFilters();
  const warnings: string[] = [];
  const requestedPeriods = readSearchParam(input.searchParams, "periods");

  if (!requestedPeriods) {
    return { filters, warnings };
  }

  const normalizedPeriods = requestedPeriods.trim();

  if (!/^\d+$/.test(normalizedPeriods)) {
    warnings.push(
      `Cash periods must be a whole number between ${MIN_FINANCE_CASH_PERIODS} and ${MAX_FINANCE_CASH_PERIODS}. Showing the default ${DEFAULT_FINANCE_CASH_PERIODS}-period window.`
    );
    return { filters, warnings };
  }

  const parsedPeriods = Number(normalizedPeriods);

  if (
    !Number.isInteger(parsedPeriods) ||
    parsedPeriods < MIN_FINANCE_CASH_PERIODS ||
    parsedPeriods > MAX_FINANCE_CASH_PERIODS
  ) {
    warnings.push(
      `Cash periods must be a whole number between ${MIN_FINANCE_CASH_PERIODS} and ${MAX_FINANCE_CASH_PERIODS}. Showing the default ${DEFAULT_FINANCE_CASH_PERIODS}-period window.`
    );
    return { filters, warnings };
  }

  filters.periods = parsedPeriods;
  return { filters, warnings };
}

export async function buildFinanceCashReportPageModel(input: {
  member: FinanceAccessMember;
  searchParams?: FinanceCashReportSearchParams;
}): Promise<FinanceCashReportPageModel> {
  const { filters, warnings } = resolveFinanceCashReportFilters({
    searchParams: input.searchParams,
  });
  const reportHref = buildFinanceCashReportHref(filters);

  try {
    const snapshots = await listFinanceSnapshots({
      snapshotType: FinanceSnapshotType.BANK_BALANCES,
      scope: DEFAULT_FINANCE_SNAPSHOT_SCOPE,
      limit: filters.periods,
    });
    const parsedSnapshots = snapshots
      .map((snapshot) => parseCashSnapshot(snapshot))
      .filter((snapshot): snapshot is ParsedCashSnapshot => snapshot !== null);
    const skippedSnapshotCount = snapshots.length - parsedSnapshots.length;

    if (snapshots.length === 0) {
      return buildUnavailableCashReportModel({
        filters,
        reportHref,
        isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
        warnings,
        loadError:
          "No bank balance snapshots are available yet. Run the finance sync and try again once the bank summary dataset has landed.",
      });
    }

    if (skippedSnapshotCount > 0) {
      warnings.push(
        `${skippedSnapshotCount} stored cash snapshot${skippedSnapshotCount === 1 ? "" : "s"} could not be parsed and ${skippedSnapshotCount === 1 ? "was" : "were"} ignored.`
      );
    }

    if (parsedSnapshots.length === 0) {
      return buildUnavailableCashReportModel({
        filters,
        reportHref,
        isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
        warnings,
        loadError:
          "Finance cash snapshots are temporarily unavailable. Try again shortly after the next finance sync completes.",
      });
    }

    const latestSnapshot = parsedSnapshots[0];
    const highestSnapshot = parsedSnapshots.reduce((highest, snapshot) =>
      snapshot.totalBalanceCents > highest.totalBalanceCents ? snapshot : highest
    );
    const totalBalanceAcrossSnapshotsCents = parsedSnapshots.reduce(
      (total, snapshot) => total + snapshot.totalBalanceCents,
      0
    );
    const averageBalanceCents = Math.round(
      totalBalanceAcrossSnapshotsCents / parsedSnapshots.length
    );
    const accountRows = buildCashAccountRows(parsedSnapshots);

    return {
      generatedOn: formatDateTime(new Date().toISOString()),
      isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
      filters,
      reportHref,
      filterWarnings: warnings,
      coverageSummary: `Showing ${parsedSnapshots.length} stored bank-balance snapshot${parsedSnapshots.length === 1 ? "" : "s"} from ${latestSnapshot.snapshotLabel} backwards.`,
      summaryCards: [
        {
          title: "Latest stored cash position",
          value: latestSnapshot.totalBalance,
          description:
            "Closing bank balance total from the latest stored bank summary snapshot.",
          footnote: `${latestSnapshot.sourceWindow}. Updated ${latestSnapshot.sourceUpdatedAtLabel}.`,
        },
        {
          title: "Average stored cash position",
          value: formatFinanceAmount(averageBalanceCents),
          description: `Average closing bank balance across ${parsedSnapshots.length} selected snapshot${parsedSnapshots.length === 1 ? "" : "s"}.`,
        },
        {
          title: "Highest stored cash position",
          value: highestSnapshot.totalBalance,
          description:
            "Highest closing bank balance across the selected stored bank summary snapshots.",
          footnote: `As of ${highestSnapshot.snapshotLabel}.`,
        },
        {
          title: "Accounts tracked",
          value: formatWholeNumber(accountRows.length),
          description:
            "Unique bank accounts found across the selected stored bank balance snapshots.",
          footnote:
            latestSnapshot.accountCount > 0
              ? `${formatWholeNumber(latestSnapshot.accountCount)} account${latestSnapshot.accountCount === 1 ? "" : "s"} appeared in the latest stored snapshot.`
              : "No bank account detail rows were available in the latest stored snapshot.",
        },
      ],
      snapshotRows: parsedSnapshots.map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        asOfDateLabel: snapshot.snapshotLabel,
        sourceWindow: snapshot.sourceWindow,
        totalBalance: snapshot.totalBalance,
        accountCount: formatWholeNumber(snapshot.accountCount),
        sourceUpdatedAtLabel: snapshot.sourceUpdatedAtLabel,
      })),
      accountRows,
      sourceNotes: buildCashSourceNotes(),
    };
  } catch (error) {
    console.error("Failed to load finance cash report snapshots", error);

    return buildUnavailableCashReportModel({
      filters,
      reportHref,
      isManager: hasFinanceManagerAccess(input.member.financeAccessLevel),
      warnings,
      loadError:
        "Finance cash snapshots are temporarily unavailable. Try again shortly or use manager diagnostics to confirm the latest finance sync status.",
    });
  }
}

function buildUnavailableCashReportModel(input: {
  filters: FinanceCashReportFilters;
  reportHref: string;
  isManager: boolean;
  warnings: string[];
  loadError: string;
}): FinanceCashReportPageModel {
  return {
    generatedOn: formatDateTime(new Date().toISOString()),
    isManager: input.isManager,
    filters: input.filters,
    reportHref: input.reportHref,
    filterWarnings: input.warnings,
    loadError: input.loadError,
    coverageSummary: "Cash snapshots unavailable",
    summaryCards: [],
    snapshotRows: [],
    accountRows: [],
    sourceNotes: buildCashSourceNotes(),
  };
}

function buildCashSourceNotes() {
  return [
    {
      label: "Finance snapshot source",
      description:
        "Cash balances on this page come from stored `BANK_BALANCES` FinanceSnapshot rows synced through the finance-only Xero boundary. They are not derived from TACBookings booking or payment data.",
    },
    {
      label: "Stored bank positions only",
      description:
        "The report reflects stored bank summary positions for the selected snapshots and keeps those figures distinct from TACBookings payment-derived cash collections.",
    },
    {
      label: "Durable read path",
      description:
        "The page reads durable bank balance snapshots already stored in Postgres. It does not trigger a live Xero report call, manual sync mutation, or working-capital rollup.",
    },
  ];
}

function buildCashAccountRows(
  snapshots: ParsedCashSnapshot[]
): FinanceCashReportAccountRow[] {
  const latestSnapshot = snapshots[0];
  const accountSummaries = new Map<
    string,
    {
      latestBalanceCents: number | null;
      selectedTotalBalanceCents: number;
      lowestBalanceCents: number | null;
      highestBalanceCents: number | null;
      periodsPresent: number;
    }
  >();

  for (const snapshot of snapshots) {
    for (const account of snapshot.accounts) {
      const existing = accountSummaries.get(account.label) ?? {
        latestBalanceCents: null,
        selectedTotalBalanceCents: 0,
        lowestBalanceCents: null,
        highestBalanceCents: null,
        periodsPresent: 0,
      };

      existing.selectedTotalBalanceCents += account.balanceCents;
      existing.periodsPresent += 1;
      existing.lowestBalanceCents =
        existing.lowestBalanceCents === null
          ? account.balanceCents
          : Math.min(existing.lowestBalanceCents, account.balanceCents);
      existing.highestBalanceCents =
        existing.highestBalanceCents === null
          ? account.balanceCents
          : Math.max(existing.highestBalanceCents, account.balanceCents);

      if (snapshot.snapshotId === latestSnapshot.snapshotId) {
        existing.latestBalanceCents = account.balanceCents;
      }

      accountSummaries.set(account.label, existing);
    }
  }

  return Array.from(accountSummaries.entries())
    .sort(([leftLabel, left], [rightLabel, right]) => {
      const leftLatest = left.latestBalanceCents ?? Number.NEGATIVE_INFINITY;
      const rightLatest = right.latestBalanceCents ?? Number.NEGATIVE_INFINITY;

      if (rightLatest !== leftLatest) {
        return rightLatest - leftLatest;
      }

      if (right.selectedTotalBalanceCents !== left.selectedTotalBalanceCents) {
        return right.selectedTotalBalanceCents - left.selectedTotalBalanceCents;
      }

      return leftLabel.localeCompare(rightLabel);
    })
    .map(([accountName, summary]) => ({
      accountName,
      latestBalance:
        summary.latestBalanceCents === null
          ? "—"
          : formatFinanceAmount(summary.latestBalanceCents),
      selectedAverage: formatFinanceAmount(
        Math.round(summary.selectedTotalBalanceCents / summary.periodsPresent)
      ),
      selectedRange: formatFinanceAmountRange(
        summary.lowestBalanceCents ?? 0,
        summary.highestBalanceCents ?? 0
      ),
      periodsPresent: formatWholeNumber(summary.periodsPresent),
    }));
}

function parseCashSnapshot(snapshot: FinanceSnapshotRecord): ParsedCashSnapshot | null {
  const payload = readReportPayload(snapshot.payload);

  if (!payload) {
    return null;
  }

  const accounts = extractCashAccounts(payload.rows);
  const totalBalanceCents =
    extractCashSummaryCents(payload.rows) ?? sumCashAccounts(accounts);

  if (totalBalanceCents === null) {
    return null;
  }

  return {
    snapshotId: snapshot.id,
    snapshotLabel: formatDisplayDate(snapshot.asOfDate),
    sourceWindow: formatSnapshotWindow(snapshot.periodStart, snapshot.periodEnd),
    totalBalanceCents,
    totalBalance: formatFinanceAmount(totalBalanceCents),
    accountCount: accounts.length,
    sourceUpdatedAtLabel: snapshot.sourceUpdatedAt
      ? formatDateTime(snapshot.sourceUpdatedAt.toISOString())
      : "Snapshot update time unavailable",
    accounts,
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

function extractCashAccounts(rows: FinanceSnapshotReportRow[]): ParsedCashAccount[] {
  const balances = new Map<string, number>();

  for (const row of flattenReportRows(rows)) {
    if (row.rowType?.toLowerCase() !== "row") {
      continue;
    }

    const label = readRowLabel(row);
    const balanceCents = readRowAmountCents(row);

    if (!label || balanceCents === null) {
      continue;
    }

    if (label.toLowerCase().includes("total")) {
      continue;
    }

    balances.set(label, (balances.get(label) ?? 0) + balanceCents);
  }

  return Array.from(balances.entries())
    .map(([label, balanceCents]) => ({
      label,
      balanceCents,
    }))
    .sort((left, right) => right.balanceCents - left.balanceCents);
}

function extractCashSummaryCents(rows: FinanceSnapshotReportRow[]) {
  const summaryRows = flattenReportRows(rows).filter(
    (row) => row.rowType?.toLowerCase() === "summaryrow"
  );

  for (const row of summaryRows) {
    const label = readRowLabel(row)?.toLowerCase();
    const amountCents = readRowAmountCents(row);

    if (amountCents !== null && label && label.includes("total")) {
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

function sumCashAccounts(accounts: ParsedCashAccount[]) {
  if (accounts.length === 0) {
    return null;
  }

  return accounts.reduce((total, account) => total + account.balanceCents, 0);
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

function formatFinanceAmountRange(minAmountCents: number, maxAmountCents: number) {
  if (minAmountCents === maxAmountCents) {
    return formatFinanceAmount(minAmountCents);
  }

  return `${formatFinanceAmount(minAmountCents)} to ${formatFinanceAmount(maxAmountCents)}`;
}

function formatSnapshotWindow(periodStart: Date | null, periodEnd: Date | null) {
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
  searchParams: FinanceCashReportSearchParams | undefined,
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
