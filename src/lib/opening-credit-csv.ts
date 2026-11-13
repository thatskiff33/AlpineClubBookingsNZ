/**
 * The opening-credit CSV (#4988): the credit balances a club carries over from
 * its old system, one row per member. This module only READS the file — which
 * columns it has, and what each row asks for. Matching rows to members, the
 * preview's total and the posting all live in `opening-credit-batch.ts`.
 *
 * Columns, matched case- and punctuation-insensitively:
 *  - a member: `Member ID`, or `Email` (narrowed by `First Name` / `Last Name`
 *    when several members share the address);
 *  - an amount: `Amount` in dollars (`25`, `25.50`, `$1,200.00`) or
 *    `Amount Cents` in whole cents — one or the other, never both;
 *  - an optional `Description`, defaulting to `OPENING_CREDIT_DEFAULT_DESCRIPTION`.
 *
 * Browser-safe: no Prisma, no server imports.
 */

import { parseMemberImportCsv } from "@/lib/member-csv-import";
import { MAX_INTEGER_CENTS, parseDecimalDollarsToCents } from "@/lib/money-input";

/** One batch is one transaction holding one ledger lock per member, so it is bounded like the member import. */
export const OPENING_CREDIT_MAX_ROWS = 500;
export const OPENING_CREDIT_DESCRIPTION_MAX_LENGTH = 500;
/** The upload's size ceiling: far above 500 rows of any sensible width. */
export const OPENING_CREDIT_CSV_MAX_CHARS = 1_000_000;
export const OPENING_CREDIT_REVERSAL_REASON_MAX_LENGTH = 500;
export const OPENING_CREDIT_DEFAULT_DESCRIPTION = "Opening credit carried over from the previous system";

type OpeningCreditColumn =
  | "memberId"
  | "email"
  | "firstName"
  | "lastName"
  | "amountDollars"
  | "amountCents"
  | "description";

const OPENING_CREDIT_COLUMN_ALIASES: Record<OpeningCreditColumn, readonly string[]> = {
  memberId: ["memberid", "id"],
  email: ["email", "emailaddress", "memberemail"],
  firstName: ["firstname", "givenname"],
  lastName: ["lastname", "surname", "familyname"],
  amountDollars: ["amount", "credit", "creditamount", "balance", "creditbalance", "openingcredit", "openingbalance"],
  amountCents: ["amountcents", "cents", "creditcents", "balancecents"],
  description: ["description", "reason", "note", "notes", "memo"],
};

function normalizeHeader(header: string) {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type OpeningCreditCsvRow = {
  lineNumber: number;
  memberId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  /** Null when the row is in error or carries no amount. */
  amountCents: number | null;
  description: string;
  /** Why the row cannot be posted; empty for a usable row. */
  errors: string[];
};

export type OpeningCreditCsvParseResult =
  | { ok: true; rows: OpeningCreditCsvRow[]; skippedZeroRows: number }
  | { ok: false; error: string };

/** `$1,200.50` and `1200.5` are both 120050 cents; anything else is null. */
export function parseOpeningCreditDollars(value: string): number | null {
  const cleaned = value.trim().replace(/^\$/, "").replace(/,(?=\d{3}(?:\D|$))/g, "");
  return parseDecimalDollarsToCents(cleaned);
}

function parseWholeCents(value: string): number | null {
  const trimmed = value.trim();
  if (!/^(0|[1-9]\d*)$/.test(trimmed)) return null;
  const cents = Number(trimmed);
  return Number.isSafeInteger(cents) && cents <= MAX_INTEGER_CENTS ? cents : null;
}

export function parseOpeningCreditCsv(text: string): OpeningCreditCsvParseResult {
  const parsed = parseMemberImportCsv(text);
  if (!parsed.ok) {
    return { ok: false, error: parsed.lineNumber ? `Line ${parsed.lineNumber}: ${parsed.error}` : parsed.error };
  }

  const columns = new Map<OpeningCreditColumn, number>();
  for (const [index, header] of parsed.data.headers.entries()) {
    const normalized = normalizeHeader(header);
    for (const [column, aliases] of Object.entries(OPENING_CREDIT_COLUMN_ALIASES) as [OpeningCreditColumn, readonly string[]][]) {
      if (!aliases.includes(normalized)) continue;
      if (columns.has(column)) return { ok: false, error: `The CSV has more than one ${header} column` };
      columns.set(column, index);
    }
  }

  if (!columns.has("memberId") && !columns.has("email")) {
    return { ok: false, error: "The CSV needs a Member ID or an Email column" };
  }
  if (columns.has("amountDollars") === columns.has("amountCents")) {
    return { ok: false, error: "The CSV needs exactly one amount column: Amount (dollars) or Amount Cents" };
  }
  if (parsed.data.rows.length > OPENING_CREDIT_MAX_ROWS) {
    return { ok: false, error: `The CSV has ${parsed.data.rows.length} rows; one batch holds at most ${OPENING_CREDIT_MAX_ROWS}` };
  }

  const rows: OpeningCreditCsvRow[] = [];
  let skippedZeroRows = 0;
  for (const record of parsed.data.rows) {
    const cell = (column: OpeningCreditColumn) => {
      const index = columns.get(column);
      const value = index === undefined ? "" : (record.values[index] ?? "").trim();
      return value === "" ? null : value;
    };
    const errors: string[] = [];

    const rawAmount = columns.has("amountCents") ? cell("amountCents") : cell("amountDollars");
    let amountCents: number | null = null;
    if (rawAmount === null) {
      errors.push("has no amount");
    } else if (rawAmount.trim().startsWith("-")) {
      errors.push("has a negative amount; an opening credit only adds to a balance");
    } else {
      amountCents = columns.has("amountCents") ? parseWholeCents(rawAmount) : parseOpeningCreditDollars(rawAmount);
      if (amountCents === null) {
        errors.push(
          columns.has("amountCents")
            ? `"${rawAmount}" is not a whole number of cents`
            : `"${rawAmount}" is not an amount in dollars, such as 25 or 25.50`,
        );
      }
    }
    if (amountCents === 0) {
      skippedZeroRows += 1;
      continue;
    }

    const memberId = cell("memberId");
    const email = cell("email")?.toLowerCase() ?? null;
    if (!memberId && !email) errors.push("has no Member ID or Email");

    const description = cell("description") ?? OPENING_CREDIT_DEFAULT_DESCRIPTION;
    if (description.length > OPENING_CREDIT_DESCRIPTION_MAX_LENGTH) {
      errors.push(`has a description longer than ${OPENING_CREDIT_DESCRIPTION_MAX_LENGTH} characters`);
    }

    rows.push({
      lineNumber: record.lineNumber,
      memberId,
      email,
      firstName: cell("firstName"),
      lastName: cell("lastName"),
      amountCents: errors.length === 0 ? amountCents : null,
      description,
      errors,
    });
  }

  if (rows.length === 0) {
    return { ok: false, error: "The CSV has no rows with an amount above zero" };
  }
  return { ok: true, rows, skippedZeroRows };
}
