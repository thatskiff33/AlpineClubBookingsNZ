import { describe, expect, it } from "vitest";
import {
  joinNzBankAccountParts,
  NZ_BANK_ACCOUNT_NUMBER_PATTERN,
  nzBankAccountNumberForSave,
  splitNzBankAccountNumber,
} from "@/lib/nz-bank-account";
import { lodgeInvoiceDetailsSchemaShape } from "@/lib/lodges";

describe("NZ bank account numbers (fork #115)", () => {
  it("accepts the 15- and 16-digit forms, BB-bbbb-AAAAAAA-SS(S)", () => {
    expect(NZ_BANK_ACCOUNT_NUMBER_PATTERN.test("12-3456-7890123-00")).toBe(true);
    expect(NZ_BANK_ACCOUNT_NUMBER_PATTERN.test("12-3456-7890123-000")).toBe(true);
    for (const wrong of ["12-3456-789012-00", "1-3456-7890123-00", "12-3456-7890123-0", "12-3456-7890123-0000", "12 3456 7890123 00"]) {
      expect(NZ_BANK_ACCOUNT_NUMBER_PATTERN.test(wrong)).toBe(false);
    }
  });

  it("splits stored, partly typed, spaced and run-together numbers into four parts", () => {
    expect(splitNzBankAccountNumber("12-3456-7890123-000")).toEqual(["12", "3456", "7890123", "000"]);
    expect(splitNzBankAccountNumber("12-34--")).toEqual(["12", "34", "", ""]);
    expect(splitNzBankAccountNumber("12 3456 7890123 00")).toEqual(["12", "3456", "7890123", "00"]);
    expect(splitNzBankAccountNumber("1234567890123000")).toEqual(["12", "3456", "7890123", "000"]);
    expect(splitNzBankAccountNumber(null)).toEqual(["", "", "", ""]);
    expect(splitNzBankAccountNumber("Westpac, see the office")).toBeNull();
  });

  it("joins parts so a partly typed number round-trips, and all-empty is empty", () => {
    expect(joinNzBankAccountParts(["12", "34", "", ""])).toBe("12-34--");
    expect(splitNzBankAccountNumber(joinNzBankAccountParts(["12", "34", "", ""]))).toEqual(["12", "34", "", ""]);
    expect(joinNzBankAccountParts(["", "", "", ""])).toBe("");
  });

  it("saves blank as null, a complete number hyphenated, and refuses anything else", () => {
    expect(nzBankAccountNumberForSave("")).toEqual({ kind: "VALID", value: null });
    expect(nzBankAccountNumberForSave("---")).toEqual({ kind: "VALID", value: null });
    expect(nzBankAccountNumberForSave("12 3456 7890123 00")).toEqual({ kind: "VALID", value: "12-3456-7890123-00" });
    expect(nzBankAccountNumberForSave("12-3456-789-00")).toEqual({ kind: "INVALID" });
    expect(nzBankAccountNumberForSave("free text")).toEqual({ kind: "INVALID" });
  });

  it("is the PATCH route's rule too: blank or a hyphenated number only", () => {
    const rule = lodgeInvoiceDetailsSchemaShape.bankAccountDetails;
    expect(rule.safeParse("12-3456-7890123-00").success).toBe(true);
    expect(rule.safeParse("  ").success).toBe(true);
    expect(rule.safeParse(null).success).toBe(true);
    expect(rule.safeParse("12-3456-789-00").success).toBe(false);
    expect(rule.safeParse("Account 123, ask the treasurer").success).toBe(false);
  });
});
