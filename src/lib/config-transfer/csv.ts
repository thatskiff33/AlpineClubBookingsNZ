// Minimal, tolerant CSV codec for config-transfer bundles. Hand-rolled (like
// src/lib/member-csv-import.ts) rather than a dependency: RFC-4180 quoting,
// LF/CRLF tolerant on read, LF on write. Values are strings on the wire; typed
// coercion is the caller's job (per the entity's field allowlist).

import { must } from "@/lib/indexed-access";

export type CsvRow = Record<string, string>;

function encodeField(value: unknown): string {
  const s =
    value === null || value === undefined
      ? ""
      : typeof value === "boolean"
        ? value
          ? "true"
          : "false"
        : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Serialise rows to CSV with a fixed header order. Missing keys → empty. */
export function serialiseCsv(
  headers: string[],
  rows: Array<Record<string, unknown>>,
): string {
  const lines = [headers.map(encodeField).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => encodeField(row[h])).join(","));
  }
  return lines.join("\n") + "\n";
}

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

/**
 * Parse CSV into records keyed by header. Unknown/missing columns are normally
 * tolerated; destructive replace-set callers can require exact row widths.
 */
export function parseCsv(
  text: string,
  options: { strictColumnCount?: boolean } = {},
): { headers: string[]; rows: CsvRow[] } {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let sawAny = false;
  let line = 1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\n") line += 1;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      // RFC-4180: a quote may only open a QUOTED field (i.e. at field start).
      // A quote mid-way through an unquoted field would silently absorb the
      // following separators (merging fields/rows) — hard-error with the line
      // instead, so a stray inch-mark in a hand-edited cell is caught, not
      // silently corrupted. Fix: quote the whole field and double the quote.
      if (field !== "") {
        throw new CsvParseError(
          `Line ${line}: unexpected '"' inside an unquoted field — quote the ` +
            `whole field and escape embedded quotes as ""`,
        );
      }
      inQuotes = true;
      sawAny = true;
      continue;
    }
    if (ch === ",") {
      record.push(field);
      field = "";
      sawAny = true;
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      record.push(field);
      records.push(record);
      field = "";
      record = [];
      sawAny = false;
      continue;
    }
    field += ch;
    sawAny = true;
  }
  // Trailing field/record with no final newline.
  if (sawAny || field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  if (inQuotes) {
    throw new CsvParseError("CSV ended inside a quoted field");
  }

  if (records.length === 0) {
    return { headers: [], rows: [] };
  }
  const headers = must(records[0], "parseCsv: records is non-empty but has no element 0");
  const rows: CsvRow[] = [];
  for (let r = 1; r < records.length; r += 1) {
    const cols = must(records[r], `parseCsv: no record at index ${r} within records.length`);
    // Skip a blank trailing line (single empty field).
    if (cols.length === 1 && cols[0] === "") continue;
    if (options.strictColumnCount && cols.length !== headers.length) {
      throw new CsvParseError(
        `Row ${r + 1}: expected ${headers.length} columns but found ${cols.length}`,
      );
    }
    const row: CsvRow = {};
    for (let c = 0; c < headers.length; c += 1) {
      const header = must(headers[c], `parseCsv: no header at index ${c} within headers.length`);
      row[header] = cols[c] ?? "";
    }
    rows.push(row);
  }
  return { headers, rows };
}
