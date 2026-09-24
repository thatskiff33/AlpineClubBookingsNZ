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

/** Matches `Member.dietaryRequirements @db.VarChar(500)`. */
export const DIETARY_REQUIREMENTS_MAX_LENGTH = 500;

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
 * The request-body schema every JSON writer shares. `undefined` means "not
 * sent" and leaves the stored value alone; `null` or a blank string clears it.
 */
export const dietaryRequirementsInputSchema = z
  .string()
  .nullable()
  .optional()
  .refine(isDietaryRequirementsWithinLimit, {
    message: DIETARY_REQUIREMENTS_TOO_LONG_MESSAGE,
  });
