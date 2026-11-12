/**
 * New Zealand bank account numbers (fork #115): `BB-bbbb-AAAAAAA-SSS` — a
 * 2-digit bank, 4-digit branch, 7-digit account and 2- or 3-digit suffix, so 15
 * or 16 digits. The lodge's invoice bank details store one in this hyphenated
 * form. The one rule for the four-part input, the edit forms' save check and
 * the PATCH route (INV-SSOT-001). Client-safe: no server imports.
 *
 * Only the shape is checked, not the banks' check-digit (modulus) rules.
 */

export const NZ_BANK_ACCOUNT_PARTS = [
  { key: "bank", label: "Bank", minLength: 2, maxLength: 2 },
  { key: "branch", label: "Branch", minLength: 4, maxLength: 4 },
  { key: "account", label: "Account", minLength: 7, maxLength: 7 },
  { key: "suffix", label: "Suffix", minLength: 2, maxLength: 3 },
] as const;

export type NzBankAccountParts = [string, string, string, string];

export const NZ_BANK_ACCOUNT_NUMBER_PATTERN = /^\d{2}-\d{4}-\d{7}-\d{2,3}$/;

export const NZ_BANK_ACCOUNT_INVALID_MESSAGE =
  "Enter the bank account number in full: 2-digit bank, 4-digit branch, 7-digit account and a 2- or 3-digit suffix (BB-bbbb-AAAAAAA-SSS).";

const EMPTY_PARTS: NzBankAccountParts = ["", "", "", ""];

/**
 * The four parts of a stored or in-progress value. The input reports its
 * parts joined by hyphens, so a partly typed number round-trips; a value
 * without exactly three hyphens is read as digits (a pasted `12 3456 7890123
 * 00` or `1234567890123000`). Anything else is `null`: not an account number.
 */
export function splitNzBankAccountNumber(value: string | null | undefined): NzBankAccountParts | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return EMPTY_PARTS;
  const hyphenated = trimmed.split("-");
  if (hyphenated.length === 4 && hyphenated.every((part) => /^\d*$/.test(part))) {
    return hyphenated as NzBankAccountParts;
  }
  const groups = trimmed.split(/[\s-]+/);
  if (groups.length === 4 && groups.every((part) => /^\d+$/.test(part))) {
    return groups as NzBankAccountParts;
  }
  const digits = trimmed.replace(/[\s-]/g, "");
  if (/^\d{15,16}$/.test(digits)) {
    return [digits.slice(0, 2), digits.slice(2, 6), digits.slice(6, 13), digits.slice(13)];
  }
  return null;
}

/** The value the input reports for its parts: empty when all are empty. */
export function joinNzBankAccountParts(parts: NzBankAccountParts): string {
  return parts.every((part) => part === "") ? "" : parts.join("-");
}

/**
 * What a form saves for the field: `null` for blank, the hyphenated number
 * when complete, else `INVALID`.
 */
export function nzBankAccountNumberForSave(
  value: string | null | undefined,
): { kind: "VALID"; value: string | null } | { kind: "INVALID" } {
  const parts = splitNzBankAccountNumber(value);
  if (!parts) return { kind: "INVALID" };
  if (parts.every((part) => part === "")) return { kind: "VALID", value: null };
  const joined = parts.join("-");
  return NZ_BANK_ACCOUNT_NUMBER_PATTERN.test(joined)
    ? { kind: "VALID", value: joined }
    : { kind: "INVALID" };
}
