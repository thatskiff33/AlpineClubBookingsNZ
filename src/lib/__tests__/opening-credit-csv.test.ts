// #4988: reading the opening-credit CSV. The parser only reads the file;
// matching and posting are `opening-credit-batch.ts`'s.
import { describe, expect, it } from "vitest";

import {
  OPENING_CREDIT_DEFAULT_DESCRIPTION,
  OPENING_CREDIT_MAX_ROWS,
  parseOpeningCreditCsv,
  parseOpeningCreditDollars,
} from "@/lib/opening-credit-csv";

function parsed(text: string) {
  const result = parseOpeningCreditCsv(text);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("parseOpeningCreditDollars", () => {
  it("reads dollars with a sign, thousands separators and cents", () => {
    expect(parseOpeningCreditDollars("25")).toBe(2500);
    expect(parseOpeningCreditDollars("25.5")).toBe(2550);
    expect(parseOpeningCreditDollars("$1,200.00")).toBe(120000);
    expect(parseOpeningCreditDollars("12.345")).toBeNull();
    expect(parseOpeningCreditDollars("ten")).toBeNull();
  });
});

describe("parseOpeningCreditCsv (#4988)", () => {
  it("reads email, names, dollars and description under their aliases", () => {
    const { rows, skippedZeroRows } = parsed(
      "Email Address,Given Name,Surname,Opening Balance,Notes\nAda@Example.com,Ada,Lovelace,$1,Carried over\n",
    );
    expect(skippedZeroRows).toBe(0);
    expect(rows).toEqual([
      {
        lineNumber: 2,
        memberId: null,
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        amountCents: 100,
        description: "Carried over",
        errors: [],
      },
    ]);
  });

  it("reads whole cents from an Amount Cents column and defaults the description", () => {
    const { rows } = parsed("Member ID,Amount Cents\nm1,2550\n");
    expect(rows[0]).toMatchObject({ memberId: "m1", amountCents: 2550, description: OPENING_CREDIT_DEFAULT_DESCRIPTION });
  });

  it("refuses a file with both amount columns, or neither", () => {
    expect(parseOpeningCreditCsv("Email,Amount,Amount Cents\na@b.nz,1,100\n")).toMatchObject({ ok: false });
    expect(parseOpeningCreditCsv("Email,Description\na@b.nz,x\n")).toMatchObject({ ok: false });
  });

  it("refuses a file with no member column", () => {
    expect(parseOpeningCreditCsv("Name,Amount\nAda,1\n")).toEqual({
      ok: false,
      error: "The CSV needs a Member ID or an Email column",
    });
  });

  it("marks a negative, malformed or missing amount as an error row, never a posted amount", () => {
    const { rows } = parsed("Email,Amount\na@b.nz,-5\nc@d.nz,abc\ne@f.nz,\ng@h.nz,7\n");
    expect(rows.map((row) => row.amountCents)).toEqual([null, null, null, 700]);
    expect(rows[0]?.errors[0]).toMatch(/negative/);
    expect(rows[1]?.errors[0]).toMatch(/not an amount in dollars/);
    expect(rows[2]?.errors).toEqual(["has no amount"]);
    expect(rows[3]?.errors).toEqual([]);
  });

  it("rejects fractional cents in an Amount Cents column", () => {
    const { rows } = parsed("Email,Amount Cents\na@b.nz,12.5\n");
    expect(rows[0]).toMatchObject({ amountCents: null });
    expect(rows[0]?.errors[0]).toMatch(/whole number of cents/);
  });

  it("skips zero rows and counts them, and refuses a file of only zeros", () => {
    const result = parsed("Email,Amount\na@b.nz,0\nc@d.nz,0.00\ne@f.nz,3\n");
    expect(result.skippedZeroRows).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(parseOpeningCreditCsv("Email,Amount\na@b.nz,0\n")).toMatchObject({ ok: false });
  });

  it("refuses more than one batch's rows", () => {
    const body = Array.from({ length: OPENING_CREDIT_MAX_ROWS + 1 }, (_, i) => `m${i}@example.com,1`).join("\n");
    expect(parseOpeningCreditCsv(`Email,Amount\n${body}\n`)).toMatchObject({ ok: false });
  });

  it("refuses a duplicated column", () => {
    expect(parseOpeningCreditCsv("Email,E-mail,Amount\na@b.nz,a@b.nz,1\n")).toMatchObject({ ok: false });
  });
});
