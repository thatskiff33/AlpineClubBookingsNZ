import { describe, expect, it } from "vitest";
import {
  buildMemberImportPreview,
  createDefaultMemberImportDateFormatMapping,
  inferMemberImportColumnMapping,
  MEMBER_IMPORT_CANCELLED_DATE_FLAG_HINT,
  MEMBER_IMPORT_MAX_ROWS,
  normalizeMemberImportDateValue,
  parseCsv,
  parseMemberImportCsv,
} from "@/lib/member-csv-import";

/**
 * The club's today, supplied rather than read (#3123). `buildMemberImportPreview`
 * runs in the browser as well as on the server, so it takes the day as data;
 * these cases do not exercise the cancelled-date-in-future boundary, so any
 * fixed club day serves. `member-csv-import-club-time-authority.test.ts` is where
 * the boundary itself is pinned against a persisted zone.
 */
const CLUB_TODAY = "2026-07-01";

describe("member CSV import parser", () => {
  it("parses quoted fields with commas and escaped quotes", () => {
    const parsed = parseMemberImportCsv(
      'First Name,Last Name,Email\n"Alice, A","O""Brien",alice@example.com',
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
      "\nFirst Name,Last Name,Email\n\nAlice,Anderson,alice@example.com\n\nBob,Brown,bob@example.com\n",
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.blankLineCount).toBe(3);
    expect(parsed.data.rows).toHaveLength(2);
    expect(parsed.data.rows.map((row) => row.lineNumber)).toEqual([4, 6]);
  });

  it("supports multiline quoted field values", () => {
    const parsed = parseMemberImportCsv(
      'First Name,Last Name,Email,Phone\n"Alice\nA.",Anderson,alice@example.com,"021\n555"',
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
    const parsed = parseCsv(
      'First Name,Last Name,Email\n"Alice,Anderson,alice@example.com',
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe("Unterminated quoted field");
    expect(parsed.lineNumber).toBe(2);
  });

  it("reports malformed characters after a closing quote", () => {
    const parsed = parseCsv(
      'First Name,Last Name,Email\n"Alice"x,Anderson,alice@example.com',
    );

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
      ["First Name,Last Name,Email", ...dataRows].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const mapping = inferMemberImportColumnMapping(parsed.data.headers);
    const preview = buildMemberImportPreview(parsed.data, mapping, CLUB_TODAY);

    expect(preview.hasErrors).toBe(false);
    expect(preview.rows).toHaveLength(12);
    expect(preview.importRows).toHaveLength(12);
    expect(preview.importRows[11]).toMatchObject({
      firstName: "First12",
      lastName: "Last12",
      email: "member12@example.com",
      role: "USER",
    });
  });

  it("maps full name, joined date, and selected date formats", () => {
    const parsed = parseMemberImportCsv(
      [
        "Name,Email,DOB,Membership Start,Phone Number",
        "Alice Anderson,alice@example.com,15/01/1990,5 Jan 2024,021555123",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = buildMemberImportPreview(
      parsed.data,
      inferMemberImportColumnMapping(parsed.data.headers),
      CLUB_TODAY,
      {
        dateOfBirth: "dd/MM/yyyy",
        joinedDate: "d MMM yyyy",
      },
    );

    expect(preview.hasErrors).toBe(false);
    expect(preview.rows[0].values).toMatchObject({
      fullName: "Alice Anderson",
      firstName: "Alice",
      lastName: "Anderson",
      dateOfBirth: "15/01/1990",
      joinedDate: "5 Jan 2024",
      phoneNumber: "021555123",
    });
    expect(preview.rows[0].normalizedDateValues).toEqual({
      dateOfBirth: "1990-01-15",
      joinedDate: "2024-01-05",
    });
  });

  it("maps legacy Member role imports to USER", () => {
    const parsed = parseMemberImportCsv(
      [
        "First Name,Last Name,Email,Role",
        "Alice,Member,alice@example.com,Member",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = buildMemberImportPreview(
      parsed.data,
      inferMemberImportColumnMapping(parsed.data.headers),
      CLUB_TODAY,
    );

    expect(preview.hasErrors).toBe(false);
    expect(preview.importRows.map((row) => row.role)).toEqual(["USER"]);
  });

  it("rejects membership type categories in the CSV role column", () => {
    const parsed = parseMemberImportCsv(
      [
        "First Name,Last Name,Email,Role",
        "Alice,Associate,alice@example.com,Associate Member",
        "Lena,Life,lena@example.com,LIFE",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = buildMemberImportPreview(
      parsed.data,
      inferMemberImportColumnMapping(parsed.data.headers),
      CLUB_TODAY,
    );

    expect(preview.hasErrors).toBe(true);
    expect(preview.importRows).toEqual([]);
    expect(preview.rows.map((row) => row.errors)).toEqual([
      ["Role must be one of USER, ADMIN"],
      ["Role must be one of USER, ADMIN"],
    ]);
  });

  it("reports invalid mapped dates with line and column context", () => {
    const parsed = parseMemberImportCsv(
      "First Name,Last Name,Email,DOB\nAlice,Anderson,alice@example.com,31/02/1990",
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = buildMemberImportPreview(
      parsed.data,
      inferMemberImportColumnMapping(parsed.data.headers),
      CLUB_TODAY,
      {
        ...createDefaultMemberImportDateFormatMapping(),
        dateOfBirth: "dd/MM/yyyy",
      },
    );

    expect(preview.hasErrors).toBe(true);
    expect(preview.rows[0].lineNumber).toBe(2);
    expect(preview.rows[0].errors[0]).toContain("Date of Birth (column DOB)");
    expect(preview.rows[0].errors[0]).toContain("valid calendar date");
  });

  it("does not prepare commit rows when preview validation fails", () => {
    const parsed = parseMemberImportCsv(
      "First Name,Last Name,Email,DOB\nAlice,Anderson,alice@example.com,31/02/1990",
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = buildMemberImportPreview(
      parsed.data,
      inferMemberImportColumnMapping(parsed.data.headers),
      CLUB_TODAY,
      {
        ...createDefaultMemberImportDateFormatMapping(),
        dateOfBirth: "dd/MM/yyyy",
      },
    );

    expect(preview.hasErrors).toBe(true);
    expect(preview.importRows).toEqual([]);
  });

  it("normalizes every supported date format to date-only storage format", () => {
    expect(normalizeMemberImportDateValue("1990-01-15", "yyyy-MM-dd")).toEqual({
      ok: true,
      value: "1990-01-15",
    });
    expect(normalizeMemberImportDateValue("15/01/1990", "dd/MM/yyyy")).toEqual({
      ok: true,
      value: "1990-01-15",
    });
    expect(normalizeMemberImportDateValue("5/1/1990", "d/M/yyyy")).toEqual({
      ok: true,
      value: "1990-01-05",
    });
    expect(normalizeMemberImportDateValue("01/15/1990", "MM/dd/yyyy")).toEqual({
      ok: true,
      value: "1990-01-15",
    });
    expect(normalizeMemberImportDateValue("15-01-1990", "dd-MM-yyyy")).toEqual({
      ok: true,
      value: "1990-01-15",
    });
    expect(normalizeMemberImportDateValue("5 Jan 1990", "d MMM yyyy")).toEqual({
      ok: true,
      value: "1990-01-05",
    });
    expect(normalizeMemberImportDateValue("Jan 5 1990", "MMM d yyyy")).toEqual({
      ok: true,
      value: "1990-01-05",
    });
  });

  it("accepts exact month names but rejects month-name prefix matches", () => {
    expect(
      normalizeMemberImportDateValue("5 January 1990", "d MMM yyyy"),
    ).toEqual({
      ok: true,
      value: "1990-01-05",
    });
    expect(
      normalizeMemberImportDateValue("January 5 1990", "MMM d yyyy"),
    ).toEqual({
      ok: true,
      value: "1990-01-05",
    });

    expect(
      normalizeMemberImportDateValue("5 Januaryx 1990", "d MMM yyyy"),
    ).toEqual({
      ok: false,
      error: "contains an unknown month for d MMM yyyy",
    });
    expect(
      normalizeMemberImportDateValue("Januaryx 5 1990", "MMM d yyyy"),
    ).toEqual({
      ok: false,
      error: "contains an unknown month for MMM d yyyy",
    });
  });

  it("enforces the API import ceiling in validation preview", () => {
    const dataRows = Array.from(
      { length: MEMBER_IMPORT_MAX_ROWS + 1 },
      (_, index) => {
        const number = index + 1;
        return `First${number},Last${number},member${number}@example.com`;
      },
    );
    const parsed = parseMemberImportCsv(
      ["First Name,Last Name,Email", ...dataRows].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = buildMemberImportPreview(
      parsed.data,
      inferMemberImportColumnMapping(parsed.data.headers),
      CLUB_TODAY,
    );

    expect(preview.hasErrors).toBe(true);
    expect(preview.fileErrors).toContain(
      `Maximum ${MEMBER_IMPORT_MAX_ROWS} rows per import`,
    );
  });

  it("maps structured street address, life member date, occupation, and comments", () => {
    const parsed = parseMemberImportCsv(
      [
        "First Name,Last Name,Email,Street Address Line 1,Street Address Line 2,City,Region,Country,Postal Code,Life Member Date,Occupation,Comments",
        "Alice,Anderson,alice@example.com,12 Hill Rd,Unit 2,Wellington,Wellington,New Zealand,6011,2024-05-01,Mountain Guide,Prefers email",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const mapping = inferMemberImportColumnMapping(parsed.data.headers);
    const preview = buildMemberImportPreview(parsed.data, mapping, CLUB_TODAY);

    expect(preview.hasErrors).toBe(false);
    expect(preview.rows[0].values).toMatchObject({
      streetAddressLine1: "12 Hill Rd",
      streetAddressLine2: "Unit 2",
      streetCity: "Wellington",
      streetRegion: "Wellington",
      streetCountry: "New Zealand",
      streetPostalCode: "6011",
      lifeMemberDate: "2024-05-01",
      occupation: "Mountain Guide",
      comments: "Prefers email",
    });
    expect(preview.rows[0].normalizedDateValues).toMatchObject({
      lifeMemberDate: "2024-05-01",
    });
  });

  it("flags an occupation longer than 100 characters", () => {
    const parsed = parseMemberImportCsv(
      [
        "First Name,Last Name,Email,Occupation",
        `Alice,Anderson,alice@example.com,${"a".repeat(101)}`,
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = buildMemberImportPreview(
      parsed.data,
      inferMemberImportColumnMapping(parsed.data.headers),
      CLUB_TODAY,
    );

    expect(preview.hasErrors).toBe(true);
    expect(
      preview.rows[0].errors.some((error) => error.includes("Occupation")),
    ).toBe(true);
  });

  it("maps title and gender from display labels", () => {
    const parsed = parseMemberImportCsv(
      [
        "Title,First Name,Last Name,Gender,Email",
        "Mrs,Alice,Anderson,Female,alice@example.com",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = buildMemberImportPreview(
      parsed.data,
      inferMemberImportColumnMapping(parsed.data.headers),
      CLUB_TODAY,
    );

    expect(preview.hasErrors).toBe(false);
    expect(preview.rows[0].values).toMatchObject({
      title: "Mrs",
      gender: "Female",
    });
  });

  it("flags an unrecognised gender value", () => {
    const parsed = parseMemberImportCsv(
      [
        "First Name,Last Name,Gender,Email",
        "Alice,Anderson,unknown,alice@example.com",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = buildMemberImportPreview(
      parsed.data,
      inferMemberImportColumnMapping(parsed.data.headers),
      CLUB_TODAY,
    );

    expect(preview.hasErrors).toBe(true);
    expect(
      preview.rows[0].errors.some((error) => error.includes("Gender")),
    ).toBe(true);
  });

  it("allows different-name rows to share an email in preview", () => {
    const parsed = parseMemberImportCsv(
      [
        "First Name,Last Name,Email,DOB",
        "Alice,Smith,shared@example.com,1990-01-01",
        "Bob,Smith,shared@example.com,1990-01-01",
        "Charlie,Smith,shared@example.com,",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = buildMemberImportPreview(
      parsed.data,
      inferMemberImportColumnMapping(parsed.data.headers),
      CLUB_TODAY,
    );

    expect(preview.hasErrors).toBe(false);
    expect(preview.importRows).toHaveLength(3);
  });

  it("maps a cancelled date column and normalizes it (issue #1946)", () => {
    const parsed = parseMemberImportCsv(
      [
        "First Name,Last Name,Email,Cancelled Date",
        "Alice,Anderson,alice@example.com,15/01/2020",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const mapping = inferMemberImportColumnMapping(parsed.data.headers);
    expect(mapping.cancelledDate).not.toBeNull();

    const preview = buildMemberImportPreview(parsed.data, mapping, CLUB_TODAY, {
      cancelledDate: "dd/MM/yyyy",
    });

    expect(preview.hasErrors).toBe(false);
    expect(preview.rows[0].values.cancelledDate).toBe("15/01/2020");
    expect(preview.rows[0].normalizedDateValues.cancelledDate).toBe(
      "2020-01-15",
    );
  });

  it("rejects a cancelled date in the future (issue #1946)", () => {
    const parsed = parseMemberImportCsv(
      [
        "First Name,Last Name,Email,Cancelled Date",
        "Alice,Anderson,alice@example.com,2999-01-01",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = buildMemberImportPreview(
      parsed.data,
      inferMemberImportColumnMapping(parsed.data.headers),
      CLUB_TODAY,
    );

    expect(preview.hasErrors).toBe(true);
    expect(preview.importRows).toEqual([]);
    expect(
      preview.rows[0].errors.some((error) =>
        error.includes("Cancelled Date"),
      ),
    ).toBe(true);
    expect(
      preview.rows[0].errors.some((error) =>
        error.toLowerCase().includes("future"),
      ),
    ).toBe(true);
  });

  // FIX-2: a bare "Cancelled"/"Resigned" header is usually a Y/N flag, not a
  // date, so it must no longer auto-map onto the cancelled-date field.
  it("does not auto-map a bare Cancelled Y/N flag column to the cancelled date", () => {
    const parsed = parseMemberImportCsv(
      [
        "First Name,Last Name,Email,Cancelled",
        "Alice,Anderson,alice@example.com,Yes",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const mapping = inferMemberImportColumnMapping(parsed.data.headers);
    expect(mapping.cancelledDate).toBeNull();

    // With the flag column left unmapped, the row imports cleanly.
    const preview = buildMemberImportPreview(parsed.data, mapping, CLUB_TODAY);
    expect(preview.hasErrors).toBe(false);
    expect(preview.rows[0].normalizedDateValues.cancelledDate).toBeUndefined();
  });

  it("does not auto-map a bare Resigned Y/N flag column to the cancelled date", () => {
    const parsed = parseMemberImportCsv(
      [
        "First Name,Last Name,Email,Resigned",
        "Alice,Anderson,alice@example.com,No",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const mapping = inferMemberImportColumnMapping(parsed.data.headers);
    expect(mapping.cancelledDate).toBeNull();
  });

  // FIX-2: when a column IS mapped to the cancelled date but holds a Yes/No
  // flag value, the parse error must hint that the column should be unmapped.
  it("hints to unmap a Yes/No flag when a mapped cancelled-date value fails to parse", () => {
    const parsed = parseMemberImportCsv(
      [
        "First Name,Last Name,Email,Cancelled Date",
        "Alice,Anderson,alice@example.com,Yes",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const mapping = inferMemberImportColumnMapping(parsed.data.headers);
    expect(mapping.cancelledDate).not.toBeNull();

    const preview = buildMemberImportPreview(parsed.data, mapping, CLUB_TODAY);
    expect(preview.hasErrors).toBe(true);
    const cancelledError = preview.rows[0].errors.find((error) =>
      error.includes("Cancelled Date"),
    );
    expect(cancelledError).toBeDefined();
    expect(cancelledError).toContain(MEMBER_IMPORT_CANCELLED_DATE_FLAG_HINT);
  });

  it("does not append the flag hint to a non-cancelled date field error", () => {
    const parsed = parseMemberImportCsv(
      [
        "First Name,Last Name,Email,DOB",
        "Alice,Anderson,alice@example.com,Yes",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = buildMemberImportPreview(
      parsed.data,
      inferMemberImportColumnMapping(parsed.data.headers),
      CLUB_TODAY,
    );
    expect(preview.hasErrors).toBe(true);
    const dobError = preview.rows[0].errors.find((error) =>
      error.includes("Date of Birth"),
    );
    expect(dobError).toBeDefined();
    expect(dobError).not.toContain(MEMBER_IMPORT_CANCELLED_DATE_FLAG_HINT);
  });

  it("accepts a past cancelled date and reports no error (issue #1946)", () => {
    const parsed = parseMemberImportCsv(
      [
        "First Name,Last Name,Email,Cancelled Date",
        "Alice,Anderson,alice@example.com,2020-06-30",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = buildMemberImportPreview(
      parsed.data,
      inferMemberImportColumnMapping(parsed.data.headers),
      CLUB_TODAY,
    );

    expect(preview.hasErrors).toBe(false);
    expect(preview.rows[0].normalizedDateValues.cancelledDate).toBe(
      "2020-06-30",
    );
  });

  it("flags duplicate same-email same-name identities in preview even when DOB differs or is blank", () => {
    const parsed = parseMemberImportCsv(
      [
        "First Name,Last Name,Email,DOB",
        "Alice,Smith,shared@example.com,1990-01-01",
        "Alice,Smith,shared@example.com,2005-05-05",
        " Alice ,Smith,shared@example.com,",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const preview = buildMemberImportPreview(
      parsed.data,
      inferMemberImportColumnMapping(parsed.data.headers),
      CLUB_TODAY,
    );

    expect(preview.hasErrors).toBe(true);
    expect(preview.rows[1].errors).toEqual([
      "Duplicate member identity in file (same email and name as line 2)",
    ]);
    expect(preview.rows[2].errors).toEqual([
      "Duplicate member identity in file (same email and name as line 2)",
    ]);
  });
});
