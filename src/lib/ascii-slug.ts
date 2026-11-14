/**
 * Lowercase ASCII words joined by single dashes, or `fallback` when nothing of
 * `text` survives. Accents are folded first ("Tūroa" becomes "turoa"), then
 * every run of anything else becomes one dash, trimmed from both ends.
 *
 * A dependency-free leaf so a browser component and a server route compute the
 * same slug from one rule: lodge slugs (`slugifyLodgeName`) and the club's
 * download-filename prefix (`clubDownloadPrefix`) both read it.
 */
export function asciiSlug(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}
