/**
 * Is `value` an absolute `http:` or `https:` URL?
 *
 * THE ONE DEFINITION (`INV-SSOT-001`, #50). Before this module the identical
 * seven-line function existed five times — the club config schema, the club
 * identity route, setup readiness, the runtime-config check and the other-lodges
 * registry — each written out by hand and each one a place the rule could drift.
 * They were byte-for-byte the same in behaviour: parse with `URL`, accept the two
 * schemes, treat anything unparseable as not a URL. Every caller now imports
 * this. `src/lib/app-url.ts` keeps its own `URL`-typed predicate, because it
 * already holds a parsed `URL` and parsing again would be the wrong shape.
 *
 * No imports and no `server-only`: it is called from a client component (the
 * Other lodges panel renders a site URL as a link only when this says so) as
 * well as from server validation, so it has to be reachable from both bundles.
 *
 * `undefined`, `null` and `""` are not URLs. `new URL("")` throws, so folding
 * them explicitly changes no caller's answer; it only widens the accepted input
 * type for callers holding an optional environment value.
 */
export function isHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
