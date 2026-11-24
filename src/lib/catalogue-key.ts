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

/** `key` without the underscores it ends in. */
function trimTrailingUnderscores(key: string): string {
  return key.replace(/_+$/, "");
}

/**
 * UPPER_SNAKE key from a display name; `CUSTOM` when nothing usable remains.
 * Trailing underscores are trimmed AFTER the length cut: a name can be up to
 * 120 characters, and a cut that lands on a separator must not leave a key
 * ending in `_`, which {@link isCatalogueKey} (and so config import) refuses.
 */
function normalizeCatalogueKey(name: string): string {
  const normalized = trimTrailingUnderscores(
    name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+/, "")
      .slice(0, CATALOGUE_KEY_MAX_LENGTH),
  );
  return normalized || "CUSTOM";
}

/**
 * True when `key` has the shape the admin pages mint: exactly what
 * {@link normalizeCatalogueKey} leaves unchanged (UPPER_SNAKE, at most 80
 * characters, no leading or trailing underscore). Config import uses this so a
 * bundle cannot create a key the admin page could never have created.
 */
export function isCatalogueKey(key: string): boolean {
  return key.length > 0 && normalizeCatalogueKey(key) === key;
}

/**
 * The first free key for `name`: the normalised key, else `_2`, `_3`… with
 * the base cut so the result stays within the length cap, and any underscore
 * the cut leaves at its end dropped so the suffix never makes a `__`.
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
    candidate = `${trimTrailingUnderscores(base.slice(0, CATALOGUE_KEY_MAX_LENGTH - suffixText.length))}${suffixText}`;
    suffix += 1;
  }
  return candidate;
}
