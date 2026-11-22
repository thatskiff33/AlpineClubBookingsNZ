/**
 * The one rule for turning an admin-entered catalogue name (a membership type,
 * a subscription category) into its stable `key`, and for trimming its
 * optional text fields. Membership types and subscription categories both
 * call these, so the two catalogues cannot drift on key shape, length or
 * collision suffixing (INV-SSOT; #4496 review, shared helpers).
 */

const CATALOGUE_KEY_MAX_LENGTH = 80;

/** Trimmed text, or `null` for blank input. */
export function normalizeCatalogueText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** UPPER_SNAKE key from a display name; `CUSTOM` when nothing usable remains. */
export function normalizeCatalogueKey(name: string): string {
  const normalized = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, CATALOGUE_KEY_MAX_LENGTH);
  return normalized || "CUSTOM";
}

/**
 * The first free key for `name`: the normalised key, else `_2`, `_3`… with
 * the base trimmed so the result stays within the length cap.
 */
export async function buildUniqueCatalogueKey(
  name: string,
  isTaken: (key: string) => Promise<boolean>,
): Promise<string> {
  const base = normalizeCatalogueKey(name);
  let candidate = base;
  let suffix = 2;
  while (await isTaken(candidate)) {
    const suffixText = `_${suffix}`;
    candidate = `${base.slice(0, CATALOGUE_KEY_MAX_LENGTH - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  return candidate;
}
