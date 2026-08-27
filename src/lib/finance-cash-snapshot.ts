import {
  calendarDateOfDateOnlyInstant,
  formatClubDate,
  parseInstant,
  requireStoredCalendarDay,
  type BoundClubTime,
} from "@/lib/club-time";
import { formatCents } from "@/lib/utils";
import { parseProviderReportAmountToCents } from "@/lib/money-provider-amount";

/**
 * Parser for stored BANK_BALANCES finance snapshots. The dashboard's
 * "Latest bank balance" KPI reads the most recent snapshot through this;
 * month-granular cash history comes from the monthly fact table instead
 * (see finance-monthly-balance.ts).
 *
 * ## Two kinds of date live in one record, and they take opposite answers (#3123)
 *
 * `asOfDate`, `periodStart` and `periodEnd` are `@db.Date` CALENDAR DAYS: they
 * round-trip as UTC midnight and name the same day in every zone on earth, so
 * they take NO zone at all. `sourceUpdatedAt` is a real INSTANT — the moment the
 * provider last refreshed the figures — which has no civil date until a zone is
 * chosen, and the only right chooser is the club's persisted one
 * (`INV-CONFIG-002`).
 *
 * Before #3123 all six went through `formatNZDate`/`formatNZDateTime` and so
 * through `APP_TIME_ZONE`. For a club west of Greenwich that dated the bank
 * balance a day early — on the KPI a finance manager reads a cash figure off.
 * Sweeping all six onto the club's zone would have fixed the one and broken the
 * five, which is why the split below is written out rather than assumed.
 */

export interface FinanceCashSnapshotRecord {
  id: string;
  asOfDate: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
  sourceUpdatedAt: Date | null;
  payload: unknown;
}

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

export interface ParsedCashSnapshot {
  snapshotId: string;
  snapshotLabel: string;
  sourceWindow: string;
  totalBalanceCents: number;
  totalBalance: string;
  accountCount: number;
  sourceUpdatedAtLabel: string;
  accounts: ParsedCashAccount[];
}

export function parseCashSnapshot(
  club: BoundClubTime,
  snapshot: FinanceCashSnapshotRecord
): ParsedCashSnapshot | null {
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
    snapshotLabel: storedSnapshotDay(snapshot.asOfDate),
    sourceWindow: formatSnapshotWindow(snapshot.periodStart, snapshot.periodEnd),
    totalBalanceCents,
    totalBalance: formatCents(totalBalanceCents),
    accountCount: accounts.length,
    sourceUpdatedAtLabel: formatSourceUpdatedAt(club, snapshot.sourceUpdatedAt),
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

function extractCashAccounts(
  rows: FinanceSnapshotReportRow[]
): ParsedCashAccount[] {
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
    const amountCents = parseProviderReportAmountToCents(cell.value);

    if (amountCents !== null) {
      return amountCents;
    }
  }

  return null;
}

function formatSnapshotWindow(periodStart: Date | null, periodEnd: Date | null) {
  if (!periodStart && !periodEnd) {
    return "Snapshot period not recorded";
  }

  if (!periodStart) {
    return `Through ${storedSnapshotDay(periodEnd!)}`;
  }

  if (!periodEnd) {
    return `From ${storedSnapshotDay(periodStart)}`;
  }

  return `${storedSnapshotDay(periodStart)} to ${storedSnapshotDay(periodEnd)}`;
}

/**
 * One of the record's three `@db.Date` columns, rendered with NO zone.
 *
 * Composed rather than wrapped in a shorter name, per `docs/CLUB_TIME_KERNEL.md`:
 * `date-only-encoding-guard.test.ts` audits encodings by the encoder's own name
 * at the call site. `requireStoredCalendarDay` proves the value really carries a
 * date-only encoding first, so a `sourceUpdatedAt` mis-wired into a bare-day slot
 * throws instead of quietly answering with its UTC day — which would be right
 * for a club east of Greenwich and wrong for one west of it.
 */
function storedSnapshotDay(value: Date): string {
  return formatClubDate(
    calendarDateOfDateOnlyInstant(
      requireStoredCalendarDay(value, {
        subject: "A cash snapshot's as-of or period date",
        instead:
          "A real timestamp rendered as a bare day is a projection, and " +
          "FinanceSnapshot.asOfDate, .periodStart and .periodEnd are all @db.Date columns.",
      }),
    ),
  );
}

/**
 * When the provider last refreshed these figures — a real INSTANT, read in the
 * club's persisted zone.
 *
 * The one value in this record that genuinely needs a zone, and the one the
 * binding is threaded here for. `FinanceSnapshot.sourceUpdatedAt` carries no
 * `@db.Date`, so it holds a time of day and has no civil date of its own.
 */
function formatSourceUpdatedAt(
  club: BoundClubTime,
  sourceUpdatedAt: Date | null
): string {
  if (!sourceUpdatedAt) return "Snapshot update time unavailable";
  const instant = parseInstant(sourceUpdatedAt);
  return instant === null
    ? "Snapshot update time unavailable"
    : club.instantDateTime(instant);
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
