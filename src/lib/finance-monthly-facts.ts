/**
 * Extraction of monthly per-account finance facts from multi-period Xero
 * reports.
 *
 * The finance sync pulls profit-and-loss and balance-sheet reports with
 * `periods=11, timeframe="MONTH"`, so a single stored report payload carries
 * twelve monthly columns of per-account amounts. This module turns such a
 * payload into flat rows — one per (month, account code) — ready for
 * FinanceAccountMonthlyBalance. It is pure: report payloads and the
 * chart-of-accounts context come in, fact rows come out.
 *
 * Column-to-month mapping is derived from the report's header row date cells
 * (Xero returns columns newest-first; nothing here assumes an order). Account
 * identity comes from the leaf-row "account" cell attribute (a Xero AccountID)
 * resolved through the chart-of-accounts snapshot, the same mechanism revenue
 * reconciliation uses. Amounts are stored as Xero reports them (P&L revenue
 * and expenses both positive in their sections); any netting is a reader
 * concern.
 */

import { parseProviderReportAmountToCents } from "@/lib/money-provider-amount";
import {
  readPnlReportPayload,
  readRowAccountId,
  readRowLabel,
  type PnlReportRow,
} from "@/lib/finance-pnl-snapshot";
import { must } from "@/lib/indexed-access";

interface FinanceChartAccountInfo {
  accountId: string;
  code: string | null;
  name: string | null;
  type: string | null;
  class: string | null;
}

export interface FinanceMonthlyChartContext {
  accountsById: Map<string, FinanceChartAccountInfo>;
}

export interface FinanceMonthlyFactRowInput {
  /** Month key, "YYYY-MM". */
  month: string;
  /** Normalized upper-case Xero GL code. */
  accountCode: string;
  accountId: string | null;
  accountName: string | null;
  accountType: string | null;
  accountClass: string | null;
  amountCents: number;
  isProvisional: boolean;
}

export interface ExtractMonthlyFactsResult {
  /** Month keys ("YYYY-MM") covered by the report columns, oldest first. */
  months: string[];
  rows: FinanceMonthlyFactRowInput[];
  /**
   * Labels of leaf rows carrying a non-zero amount that could not be resolved
   * to a GL code (missing account attribute or absent from the chart-of-
   * accounts snapshot). The raw report snapshot retains them; they are
   * surfaced so sync diagnostics can flag mapping gaps.
   */
  unresolvedRowLabels: string[];
  /**
   * Number of period columns the report header exposes (its non-label data
   * cells). When fewer months parse than this, some date cells were in a format
   * the parser did not recognise, so those months would silently drop out of
   * both the extracted rows and the replace window — callers compare
   * `months.length` against this to fail loudly instead.
   */
  periodColumnCount: number;
}

const MONTH_KEY_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

const MONTH_NUMBER_BY_NAME = new Map<string, number>([
  ["jan", 1],
  ["feb", 2],
  ["mar", 3],
  ["apr", 4],
  ["may", 5],
  ["jun", 6],
  ["jul", 7],
  ["aug", 8],
  ["sep", 9],
  ["oct", 10],
  ["nov", 11],
  ["dec", 12],
]);

export function isMonthKey(value: string): boolean {
  return MONTH_KEY_REGEX.test(value);
}

/** Shift a "YYYY-MM" month key by a number of months (negative = earlier). */
export function shiftMonthKey(monthKey: string, deltaMonths: number): string {
  if (!isMonthKey(monthKey)) {
    throw new Error(`shiftMonthKey requires a YYYY-MM month key, got "${monthKey}"`);
  }

  // `isMonthKey` above pinned the "YYYY-MM" shape, so the split always has
  // both parts.
  const parts = monthKey.split("-");
  const year = Number(must(parts[0], `shiftMonthKey: malformed month key "${monthKey}"`));
  const month = Number(must(parts[1], `shiftMonthKey: malformed month key "${monthKey}"`));
  const zeroBased = year * 12 + (month - 1) + deltaMonths;
  const shiftedYear = Math.floor(zeroBased / 12);
  const shiftedMonth = (((zeroBased % 12) + 12) % 12) + 1;

  return `${shiftedYear}-${String(shiftedMonth).padStart(2, "0")}`;
}

function normalizeYear(value: number): number {
  return value < 100 ? 2000 + value : value;
}

function buildMonthKey(year: number, month: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    return null;
  }
  if (year < 1900 || year > 2200 || month < 1 || month > 12) {
    return null;
  }

  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Parse a report header date cell into a month key. Xero renders period
 * columns in formats like "30 Jun 26", "30 June 2026", "Jun-26" or an ISO
 * date, depending on report and organisation settings.
 */
export function parseReportColumnMonth(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (isoMatch) {
    return buildMonthKey(Number(isoMatch[1]), Number(isoMatch[2]));
  }

  const nameMatch = trimmed.match(
    /^(?:(\d{1,2})\s+)?([A-Za-z]{3,9})[\s-]+(\d{2}|\d{4})$/
  );
  if (nameMatch) {
    // The 2nd and 3rd groups are mandatory (no trailing `?`), so a successful
    // match always captures them.
    const monthName = must(nameMatch[2], "parseReportColumnMonth: matched date has no month-name capture group");
    const yearText = must(nameMatch[3], "parseReportColumnMonth: matched date has no year capture group");
    const month = MONTH_NUMBER_BY_NAME.get(monthName.slice(0, 3).toLowerCase());
    if (month === undefined) {
      return null;
    }

    return buildMonthKey(normalizeYear(Number(yearText)), month);
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeFactAccountCode(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

/**
 * Parse a stored chart-of-accounts snapshot payload (see
 * buildFinanceChartOfAccountsSnapshot) into an AccountID lookup carrying the
 * full metadata the fact table stores: code, name, type and class.
 */
export function parseFinanceChartOfAccountsContext(
  payload: unknown
): FinanceMonthlyChartContext {
  const accountsById = new Map<string, FinanceChartAccountInfo>();

  const accounts = isRecord(payload) ? payload.accounts : null;
  if (!Array.isArray(accounts)) {
    return { accountsById };
  }

  for (const entry of accounts) {
    if (!isRecord(entry)) {
      continue;
    }

    const accountId = readOptionalString(entry.accountId);
    if (!accountId) {
      continue;
    }

    accountsById.set(accountId, {
      accountId,
      code: normalizeFactAccountCode(readOptionalString(entry.code)),
      name: readOptionalString(entry.name),
      type: readOptionalString(entry.type),
      class: readOptionalString(entry.class),
    });
  }

  return { accountsById };
}

interface HeaderColumnMonth {
  cellIndex: number;
  month: string;
}

interface HeaderColumns {
  columns: HeaderColumnMonth[];
  /**
   * Non-blank data cells in the chosen header row (every cell after the leading
   * row-label column). Each is a period column the report exposes; a shortfall
   * against `columns.length` means a date cell failed to parse.
   */
  periodColumnCount: number;
}

function findHeaderColumnMonths(rows: PnlReportRow[]): HeaderColumns {
  const visit = (candidates: PnlReportRow[]): HeaderColumns | null => {
    for (const row of candidates) {
      if (row.rowType?.toLowerCase() === "header") {
        const columns = row.cells.flatMap((cell, cellIndex) => {
          const month = parseReportColumnMonth(cell.value);
          return month ? [{ cellIndex, month }] : [];
        });

        if (columns.length > 0) {
          const periodColumnCount = row.cells.filter(
            (cell, cellIndex) => cellIndex > 0 && Boolean(cell.value?.trim())
          ).length;
          return { columns, periodColumnCount };
        }
      }

      const nested = visit(row.rows);
      if (nested) {
        return nested;
      }
    }

    return null;
  };

  return visit(rows) ?? { columns: [], periodColumnCount: 0 };
}

function collectLeafRows(rows: PnlReportRow[]): PnlReportRow[] {
  const leaves: PnlReportRow[] = [];

  const visit = (row: PnlReportRow) => {
    if (row.rowType?.toLowerCase() === "row") {
      leaves.push(row);
    }
    for (const nested of row.rows) {
      visit(nested);
    }
  };

  for (const row of rows) {
    visit(row);
  }

  return leaves;
}

function rowHasNonZeroAmount(row: PnlReportRow): boolean {
  return row.cells.some((cell) => {
    const amountCents = parseProviderReportAmountToCents(cell.value);
    return amountCents !== null && amountCents !== 0;
  });
}

/**
 * Extract monthly per-account fact rows from a stored multi-period report
 * payload (profit-and-loss or balance-sheet; the row structure is identical).
 *
 * Only leaf rows carrying an "account" cell attribute are read — summary and
 * total rows never do, so totals are structurally excluded rather than
 * filtered by label. Months at or after `provisionalFromMonth` (the month
 * still in progress when the report was pulled) are flagged provisional.
 */
/**
 * Xero emits the balance-sheet "Current Year Earnings" line with this fixed
 * sentinel AccountID for every organisation. It is a derived equity figure (the
 * year's net profit rolled into equity), not a user GL account: getAccounts
 * never returns it and it carries no account code, so it cannot become a
 * per-account fact and is excluded like the other computed totals.
 */
export const XERO_CURRENT_YEAR_EARNINGS_ACCOUNT_ID =
  "abababab-abab-abab-abab-abababababab";

export function extractMonthlyFactsFromReport(input: {
  payload: unknown;
  chart: FinanceMonthlyChartContext;
  provisionalFromMonth?: string | null;
}): ExtractMonthlyFactsResult {
  const report = readPnlReportPayload(input.payload);
  if (!report) {
    return { months: [], rows: [], unresolvedRowLabels: [], periodColumnCount: 0 };
  }

  const { columns, periodColumnCount } = findHeaderColumnMonths(report.rows);
  const provisionalFromMonth =
    input.provisionalFromMonth && isMonthKey(input.provisionalFromMonth)
      ? input.provisionalFromMonth
      : null;

  const months = Array.from(new Set(columns.map((column) => column.month))).sort();
  const rowsByKey = new Map<string, FinanceMonthlyFactRowInput>();
  const unresolvedRowLabels = new Set<string>();

  for (const row of collectLeafRows(report.rows)) {
    const accountId = readRowAccountId(row);

    if (!accountId || accountId === XERO_CURRENT_YEAR_EARNINGS_ACCOUNT_ID) {
      // Derived / synthetic report line, not a GL account, so correctly absent
      // from the per-account facts:
      //  - no account attribute at all → cross-section totals such as Gross
      //    Profit, Net Profit, and Net Assets;
      //  - Xero's fixed Current Year Earnings sentinel account id → the
      //    balance-sheet equity roll-up of the year's profit, derived from the
      //    account rows and not returned by getAccounts (so it has no code).
      // Skip these (rather than flag unresolved): this matches the documented
      // "totals are structurally excluded" intent and keeps the unresolved
      // guard meaningful for rows that name a real account we could not map.
      continue;
    }

    const account = input.chart.accountsById.get(accountId);

    if (!account?.code) {
      if (rowHasNonZeroAmount(row)) {
        const label = readRowLabel(row);
        if (label) {
          unresolvedRowLabels.add(label);
        }
      }
      continue;
    }

    const accountCode = account.code;

    for (const column of columns) {
      const amountCents = parseProviderReportAmountToCents(
        row.cells[column.cellIndex]?.value ?? null
      );
      if (amountCents === null) {
        continue;
      }

      const key = `${column.month}|${accountCode}`;
      const existing = rowsByKey.get(key);
      if (existing) {
        existing.amountCents += amountCents;
        continue;
      }

      rowsByKey.set(key, {
        month: column.month,
        accountCode,
        accountId,
        accountName: account.name ?? readRowLabel(row),
        accountType: account.type,
        accountClass: account.class,
        amountCents,
        isProvisional:
          provisionalFromMonth !== null && column.month >= provisionalFromMonth,
      });
    }
  }

  return {
    months,
    rows: Array.from(rowsByKey.values()).sort(
      (left, right) =>
        left.month.localeCompare(right.month) ||
        left.accountCode.localeCompare(right.accountCode)
    ),
    unresolvedRowLabels: Array.from(unresolvedRowLabels).sort(),
    periodColumnCount,
  };
}
