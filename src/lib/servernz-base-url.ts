/**
 * The ONE spelling of an Alpine Central Server base URL (#4470, `INV-SSOT`):
 * trimmed, no trailing slash, `null` when blank. The settings writer stores
 * through it, the key save compares the address its page showed through it,
 * and the setup page (a client module) uses it to tell whether the address in
 * its field is the saved one. No `server-only` import for that reason.
 */
export function normalizeBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}
