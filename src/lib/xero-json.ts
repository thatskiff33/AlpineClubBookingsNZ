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
