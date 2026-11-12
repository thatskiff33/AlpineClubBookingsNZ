/**
 * Lower-case ASCII slug of free text: accents are dropped from their letters
 * (Ō -> o), every other run of non-alphanumerics becomes one hyphen, and edge
 * hyphens are trimmed. Returns "" when nothing survives, so each caller names
 * its own fallback.
 */
export function slugifyText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
