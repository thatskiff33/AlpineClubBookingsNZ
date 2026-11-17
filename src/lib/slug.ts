/**
 * Lower-case ASCII words joined by single hyphens, safe in a URL path or a file
 * name: accents are folded and everything else becomes a separator. Empty when
 * the text holds no letter or digit, so each caller chooses its own fallback.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
