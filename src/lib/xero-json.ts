/**
 * Shared JSON-guard micro-helpers for the Xero integration modules.
 *
 * These small `unknown`-narrowing helpers were previously duplicated verbatim
 * across several xero-* modules (#1208). They live here so each module imports
 * one shared copy instead of re-declaring its own. Internal to the Xero
 * subsystem — not part of the `@/lib/xero` compatibility facade surface.
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * #3953 round 9: whether a Xero operation's stored response names an invoice
 * Xero made (any `InvoiceID`-like key holding an id, nested up to six deep) -
 * then the row is not unsent. #4494 reads it for a gap invoice too.
 */
export function responseNamesXeroInvoice(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => responseNamesXeroInvoice(entry, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    /^(xero)?invoice_?id$/i.test(key) ? typeof entry === "string" && entry.length > 0 : responseNamesXeroInvoice(entry, depth + 1),
  );
}
