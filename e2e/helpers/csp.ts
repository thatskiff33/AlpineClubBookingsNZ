/**
 * Every inline `<script>` open tag in `html` that carries no non-empty `nonce`.
 *
 * One home for the nonce sweep the CSP specs share (`INV-SSOT`): the asset-URL
 * spec (#2404) and the static CMS-page spec (#2352) each carried an identical
 * copy, and a scanner that exists twice is a scanner that can be tightened in
 * one place and left loose in the other. A `src=` script is external, so the
 * nonce rule does not apply to it; a JSON / JSON-LD script is data, not code,
 * and no browser executes it.
 */
export function unnoncedInlineScripts(html: string): string[] {
  const offenders: string[] = [];

  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attributes = match[1] ?? "";
    if (/\bsrc\s*=/i.test(attributes)) continue;
    if (/\btype\s*=\s*["']?application\/(?:ld\+)?json/i.test(attributes)) continue;
    if (/\bnonce\s*=\s*(?:"[^"]+"|'[^']+'|[^\s"'>]+)/i.test(attributes)) continue;
    offenders.push(match[0]);
  }

  return offenders;
}
