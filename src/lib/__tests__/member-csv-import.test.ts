import { describe, expect, it } from "vitest";
import {
  buildMemberImportPreview,
  inferMemberImportColumnMapping,
  MEMBER_IMPORT_MAX_ROWS,
  parseCsv,
  parseMemberImportCsv,
} from "@/lib/member-csv-import";

describe("member CSV import parser", () => {
  it("parses quoted fields with commas and escaped quotes", () => {
    const parsed = parseMemberImportCsv(
      'First Name,Last Name,Email\n"Alice, A","O""Brien",alice@example.com'
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.headers).toEqual(["First Name", "Last Name", "Email"]);
    expect(parsed.data.rows[0].values).toEqual([
      "Alice, A",
      'O"Brien',
      "alice@example.com",
    ]);
  });

  it("skips blank lines while preserving data line numbers", () => {
    const parsed = parseMemberImportCsv(
      "\nFirst Name,Last Name,Email\n\nAlice,Anderson,alice@example.com\n\nBob,Brown,bob@example.com\n"
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.blankLineCount).toBe(3);
    expect(parsed.data.rows).toHaveLength(2);
    expect(parsed.data.rows.map((row) => row.lineNumber)).toEqual([4, 6]);
  });

  it("supports multiline quoted field values", () => {
    const parsed = parseMemberImportCsv(
      'First Name,Last Name,Email,Phone\n"Alice\nA.",Anderson,alice@example.com,"021\n555"'
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.rows[0].values).toEqual([
      "Alice\nA.",
      "Anderson",
      "alice@example.com",
      "021\n555",
    ]);
  });

  it("reports malformed unterminated quoted fields", () => {
    const parsed = parseCsv('First Name,Last Name,Email\n"Alice,Anderson,alice@example.com');

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe("Unterminated quoted field");
    expect(parsed.lineNumber).toBe(2);
  });

  it("reports malformed characters after a closing quote", () => {
    const parsed = parseCsv('First Name,Last Name,Email\n"Alice"x,Anderson,alice@example.com');

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe("Unexpected character after closing quote");
    expect(parsed.lineNumber).toBe(2);
  });

  it("previews and maps more than nine data rows", () => {
    const dataRows = Array.from({ length: 12 }, (_, index) => {
      const number = index + 1;
      return `First${number},Last${number},member${number}@example.com`;
    });
    const parsed = parseMemberImportCsv(
      ["First Name,Last Name,Email", ...dataRows].join("\n")
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const mapping = inferMemberImportColumnMapping(parsed.data.headers);
    const preview = buildMemberImportPreview(parsed.data, mapping);

    expect(preview.hasErrors).toBe(false);
    expect(preview.rows).toHaveLength(12);
    expect(preview.importRows).toHaveLength(12);
    expect(preview.importRows[11]).toMatchObject({
      firstName: "First12",
      lastName: "Last12",
      email: "member12@example.com",
      role: "MEMBER",
    });
  });

  it("enforces the API import ceiling in validation preview", () => {
    const dataRows = Array.from({ length: MEMBER_IMPORT_MAX_ROWS + 1 }, (_, index) => {
      const number = index + 1;
      return `First${number},Last${number},member${number}@example.com`;
    });
    const parsed = parseMemberImportCsv(
      ["First Name,Last Name,Email", ...dataRows].join("\n")
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = buildMemberImportPreview(
      parsed.data,
      inferMemberImportColumnMapping(parsed.data.headers)
    );

    expect(preview.hasErrors).toBe(true);
    expect(preview.fileErrors).toContain(`Maximum ${MEMBER_IMPORT_MAX_ROWS} rows per import`);
  });
});
