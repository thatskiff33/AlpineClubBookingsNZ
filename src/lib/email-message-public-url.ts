/**
 * The club's public address as emails link to it: http or https only, with no
 * trailing slash. Pure, so the email settings route's schema
 * (`admin-support-api/messages.ts`), which the AI app catalogue loads, and
 * the settings reader (`email-message-settings.ts`) share it (`INV-SSOT`).
 */
export function normalizeEmailMessagePublicUrl(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }

  return trimmed.replace(/\/+$/, "");
}
