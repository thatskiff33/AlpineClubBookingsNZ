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

/**
 * The STRICTER rule for an address shown to other people as a link (#55): an
 * Other lodge's booking page, which the Alpine Central Server hands to every
 * club. A copy (another repository) of the central server's `isSafeHttpUrl`
 * in AlpineClubServerNZ `src/lib/other-lodges.ts`, which refuses anything else
 * in an upload: change the two together. The URL parser alone is too forgiving: it reads
 * `http:\\evil.com` and `https:/\t/evil.com` as `https://evil.com`, and
 * accepts `https://club.nz@evil.com`, whose "club.nz" is a user name a reader
 * takes for the site. So the text AS TYPED is checked:
 *
 *  - it starts with `http://` or `https://` (any case);
 *  - it carries no whitespace, control character or backslash;
 *  - parsed, it has no user name or password.
 *
 * `isHttpUrl` above is unchanged for every other caller.
 */
export function isSafeHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  if (!/^https?:\/\//i.test(value)) return false;
  if (/[\s\u0000-\u001F\u007F\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

/** What an administrator is told when a booking page address breaks `isSafeHttpUrl`. */
export const SAFE_HTTP_URL_MESSAGE =
  "The non-member booking page URL must start with http:// or https://, with no spaces, no backslashes, and no @ before the site's name (such as https://club.nz@other.site).";
