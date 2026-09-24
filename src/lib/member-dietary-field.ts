/**
 * Client-safe shape of the member dietary/allergy field (#2941, `INV-PRIV-022`).
 *
 * The ONE home for the field's limit, label and normalisation, so the profile
 * form, the onboarding wizard, the admin editor, every server writer and the
 * member CSV parser cannot drift apart. It holds no data access: reading or
 * selecting the stored value is `src/lib/member-dietary.ts`'s job alone, and
 * that module is server-only.
 */
import { z } from "zod";
import { unescapeCsvFormulaGuard } from "@/lib/csv";

/** Matches `Member.dietaryRequirements @db.VarChar(500)`. */
export const DIETARY_REQUIREMENTS_MAX_LENGTH = 500;

/**
 * The key fragments that mark a dietary/allergy value in a log payload or in
 * audit metadata (#2941, `INV-PRIV-022`). The ONE spelling: the log/Sentry
 * redactor and the audit sanitizer both import it, so neither can learn a
 * spelling the other does not. Matched against a key lower-cased with every
 * non-alphanumeric removed, so `dietaryRequirements`, `guest_dietary`,
 * `allergies` and `allergyNotes` are all caught.
 */
export const DIETARY_KEY_FRAGMENTS = ["dietary", "allerg"] as const;

/** Does this object key name dietary/allergy information? */
export function isDietaryKeyName(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return DIETARY_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/** The one user-facing label, shared by every screen and the CSV header. */
export const DIETARY_REQUIREMENTS_LABEL = "Dietary/allergy information";

/**
 * Trim, fold CRLF/CR to LF, and store a blank as null. The owner decision of
 * 20 Sep 2026 on #2941: blank becomes null.
 */
export function normalizeDietaryRequirements(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * The length rule, judged on the NORMALISED value so surrounding whitespace a
 * browser or spreadsheet adds cannot push an otherwise valid entry over the
 * limit. JavaScript counts UTF-16 code units, which is never fewer than the
 * characters PostgreSQL counts for VARCHAR(500), so a value this accepts always
 * fits the column.
 */
export function isDietaryRequirementsWithinLimit(
  value: string | null | undefined,
): boolean {
  const normalized = normalizeDietaryRequirements(value);
  return (normalized?.length ?? 0) <= DIETARY_REQUIREMENTS_MAX_LENGTH;
}

export const DIETARY_REQUIREMENTS_TOO_LONG_MESSAGE = `${DIETARY_REQUIREMENTS_LABEL} must be ${DIETARY_REQUIREMENTS_MAX_LENGTH} characters or fewer`;

/**
 * The value's SHAPE: a string, null, or absent. `undefined` means "not sent" and
 * leaves the stored value alone; `null` or a blank string clears it. The member
 * CSV import uses the shape alone and applies the length rule only when it is
 * actually taking the column, so a legacy column it discards cannot block a
 * whole import.
 */
export const dietaryRequirementsValueSchema = z.string().nullable().optional();

/** The request-body schema every JSON writer shares: the shape plus the limit. */
export const dietaryRequirementsInputSchema = dietaryRequirementsValueSchema.refine(
  isDietaryRequirementsWithinLimit,
  { message: DIETARY_REQUIREMENTS_TOO_LONG_MESSAGE },
);

/**
 * A value read from a member CSV: the export's formula guard is undone first
 * (`'- no nuts` comes back as `- no nuts`, so a 500-character value does not
 * return as 501), then the ordinary normalisation.
 */
export function normalizeImportedDietaryRequirements(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  return normalizeDietaryRequirements(unescapeCsvFormulaGuard(value.trim()));
}
