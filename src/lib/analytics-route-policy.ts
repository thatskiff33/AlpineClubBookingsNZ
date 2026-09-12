import { isFixedNonceWebsitePath } from "@/lib/public-website-paths";

/**
 * WHERE Google Analytics may run, and WHAT it may be told about the URL (#2573,
 * owner decision section 7).
 *
 * The policy is FIXED and application-controlled. An administrator cannot select
 * tracked routes, cannot opt a route in, and cannot change what is sent — those
 * are all on section 2's not-configurable list. This module is the enforcement,
 * not a description of it: `analytics-route-policy.test.ts` pins both directions.
 *
 * Deliberately dependency-free apart from the route census: it runs in the browser
 * (the runtime component re-evaluates it on every client-side navigation) as well
 * as on the server, so it may not import Prisma, `server-only`, or anything from
 * `next/`.
 *
 * ## Two independent gates, and why one would not be enough
 *
 * 1. **{@link isFixedNonceWebsitePath} must say yes.** That predicate is derived
 *    from the real route tree (`src/lib/public-website-paths.ts`, kept exhaustive
 *    by `setup-gate.test.ts` walking `src/app`), and it answers "is this an address
 *    one of the five approved `(website)` routes serves". Every excluded class the
 *    owner listed falls out of it already: `/admin/*`, every authenticated member
 *    and dashboard route, and — because each is a `NON_WEBSITE_ROOT_SEGMENTS`
 *    entry — `/login`, `/register`, `/forgot-password`, `/reset-password`,
 *    `/change-password`, `/verify-email`, `/confirm-email-change`,
 *    `/family-invite/*`, `/membership-cancellation/*`, `/pay/*` and `/chores/*`.
 *    It also subtracts the eight `(website-dynamic)` routes via
 *    `PER_REQUEST_WEBSITE_ROUTES` — the PIN-bearing and token-bearing public pages
 *    (`/hut-leader-instructions`, `/join/[code]`, `/join/verify/[token]`) plus the
 *    booking-request and school-booking form pages and their token flows
 *    (`/booking-requests`, `/booking-requests/respond/[token]`,
 *    `/booking-requests/verify/[token]`, `/school-bookings`,
 *    `/school-bookings/confirm/[token]`, #2818 decision 2). A bare
 *    `/booking-requests` or `/school-bookings` is therefore NOT eligible: it is a
 *    per-request page, exactly where an anonymous visitor types the most personal
 *    information.
 *
 *    Using it means a route added to any of those groups later is excluded the day
 *    it is added, with no second list to remember. That is the failure mode a
 *    hand-written denylist has: it rots silently, in the dangerous direction.
 *
 *    **One accepted behaviour change (#2818).** `booking-requests` and
 *    `school-bookings` used to be `NON_WEBSITE_ROOT_SEGMENTS` entries, which
 *    excluded EVERY address under them. They are website roots now, and only the
 *    exact per-request routes above are subtracted — so a 2-segment miss that no
 *    route claims, such as `/booking-requests/respond` (the token route is
 *    `/booking-requests/respond/[token]`, three segments), passes gate 1, is an
 *    ordinary-looking slug for gate 2, and so its catch-all 404 is analytics-
 *    eligible. The owner accepts this: it is a harmless tracked 404 that carries
 *    no token or PIN, and pinned explicitly in `analytics-route-policy.test.ts`
 *    so the coverage is not silently tied to a shrinking exclusion set.
 *
 * 2. **The address must also LOOK like an ordinary public page.** Gate 1 admits
 *    everything the `[...slug]` CMS catch-all claims, which is every URL no other
 *    route matches — including addresses that carry an opaque identifier
 *    (`/reset/AbCdEf0123456789xyz`), a percent-encoded segment, or a
 *    credential-flavoured word. None of those is a real CMS page: an
 *    admin-authored slug matches {@link CMS_SEGMENT_PATTERN} (the same shape
 *    `isValidPageSlug` enforces on write). So gate 2 refuses anything that does
 *    not, plus a small set of credential-flavoured segment words, and the result
 *    is fail-CLOSED: an unrecognised shape is excluded rather than tracked.
 *
 * The cost of gate 2 is that a club which names a page exactly `verify`, `code`,
 * `session` or another whole-segment entry in {@link CREDENTIAL_SEGMENT_WORDS} gets
 * no analytics on it — and neither does one named `newsletter2026`, which condition
 * 3 below reads as an identifier. Measured, not assumed: matching is on WHOLE
 * segments, so `verify-your-booking`, `verification-of-membership` and
 * `pinnacle-ridge` are all still eligible, and `analytics-route-policy.test.ts`
 * pins both directions.
 *
 * That is the right trade — a missing page view is a reporting gap, a sent token is
 * a disclosure — and it is documented for the operator who hits it, as a
 * troubleshooting row in `docs/guides/integrations.md` ("Analytics reports no page
 * views for one page"). NOT in `docs/user-guide`, which is the member-facing set and
 * carries no analytics content at all: this is an operator's reporting question, not
 * something a club member ever needs to read.
 */

/**
 * One segment of an admin-authored CMS slug, mirroring `PAGE_SLUG_PATTERN` in
 * `src/lib/page-content.ts` (lowercase alphanumerics in hyphen-joined words).
 *
 * Anything else — uppercase, underscores, dots, percent escapes, mixed-case
 * identifiers, long random strings — is not a slug an admin could have created,
 * so it is not an address analytics runs on.
 */
const CMS_SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A slug segment longer than this is an identifier, not a title. */
const MAX_CMS_SEGMENT_LENGTH = 60;

/**
 * An OPAQUE IDENTIFIER shaped like a slug — a token, cuid, UUID or numeric id that
 * {@link CMS_SEGMENT_PATTERN} would otherwise wave through.
 *
 * That pattern alone does not catch these, and it is a real gap rather than a
 * theoretical one: `/t/9f8e7d6c5b4a39281706`, `/cm5x9q2ab000108l3f4g5h6i`,
 * `/550e8400-e29b-41d4-a716-446655440000` and `/123456789012345678` are all valid
 * lowercase-alphanumeric hyphen-joined segments, so the pattern admits them — and if
 * a link of any of those shapes exists in the wild, the catch-all serves its 404 and
 * the address would have been reported to Google with the identifier intact.
 *
 * Four independent conditions, any one of which condemns a segment. Each is written
 * to refuse identifiers WITHOUT refusing the hyphen-joined words an admin actually
 * types (`annual-general-meeting`, `trips-2026`, `notice-2026-agm`):
 *
 *  1. **Canonical UUID shape** — 8-4-4-4-12 lowercase hex. Matched exactly rather
 *     than by randomness, because it is the single most common token format there
 *     is and no page title looks like it. The earlier version of this function
 *     exempted ANY segment containing a hyphen, which handed a pass to every UUID.
 *  2. **A long run of pure digits** — a page slug segment is a title, not a number;
 *     `2026` and `2026-agm` are well under the threshold, and `123456789012345678`
 *     carries no letter for condition 3 or 4 to notice.
 *  3. **An unbroken alphanumeric run** of at least
 *     {@link OPAQUE_IDENTIFIER_MIN_LENGTH} characters mixing letters and digits —
 *     the lowercase hex token, the cuid, the base32 code.
 *  4. **A hyphen-joined segment containing a RANDOM-LOOKING chunk** — see
 *     {@link chunkLooksRandom}. This is what catches the non-canonical hyphenated
 *     token (`9f8e7d6c-5b4a-3928-1706`) while leaving real titles alone.
 *
 * Two residues, both accepted and both in the same direction as the rest of this
 * module — a missing page view is a reporting gap, a sent token is a disclosure:
 *  • a page whose slug is one long unhyphenated word containing a digit
 *    (`newsletter2026`) loses its page views (condition 3);
 *  • a hyphenated token whose every chunk happens to be pure letters or pure digits
 *    (`abcd-1234-efab-5678`) is NOT caught, because nothing structural distinguishes
 *    it from `annual-2026-report-2025`. Telling those apart would need a dictionary,
 *    and gate 1 already excludes every token-bearing route this application actually
 *    serves; condition 4 is the belt for an address no route claims.
 */
const OPAQUE_IDENTIFIER_MIN_LENGTH = 12;

/** 8-4-4-4-12 lowercase hex: `crypto.randomUUID()` and every other UUID v1-v8. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A pure-digit segment longer than six characters is an identifier, not a year or an
 * ordinal. `2026`, `1926` and `100` stay eligible; `123456789012345678` does not.
 */
const LONG_NUMERIC_SEGMENT_PATTERN = /^[0-9]{7,}$/;

/**
 * Does this hyphen-separated chunk look like a slice of an identifier rather than a
 * word?
 *
 * The signal is ALTERNATION between letters and digits, which is what random
 * base-N text does and what English does not. A word carrying a year or a version
 * (`newsletter2026`, `covid19`, `part2`, `mp3`) alternates once — letters then
 * digits, or digits then letters. A hex or base32 chunk alternates repeatedly
 * (`9f8e7d6c` alternates seven times; `550e8400` twice).
 *
 * Short chunks are exempt outright: `2b`, `v2`, `e2e` and `b2b` are qualifiers
 * people really write, and at three characters or fewer there is not enough shape
 * to judge. Pure letters and pure digits are exempt too — condition 2 of
 * {@link looksLikeOpaqueIdentifier} handles a long number, and a run of letters is
 * a word by any available measure.
 */
function chunkLooksRandom(chunk: string): boolean {
  if (chunk.length < 4) return false;
  if (!/[a-z]/.test(chunk) || !/[0-9]/.test(chunk)) return false;

  // Walking the string char-by-char, carrying the previous char's shape
  // forward, rather than indexing `index - 1` alongside `index`.
  let alternations = 0;
  let previousWasDigit: boolean | null = null;
  for (const char of chunk) {
    const isDigit = /[0-9]/.test(char);
    if (previousWasDigit !== null && previousWasDigit !== isDigit) {
      alternations += 1;
    }
    previousWasDigit = isDigit;
  }
  return alternations >= 2;
}

function looksLikeOpaqueIdentifier(segment: string): boolean {
  if (UUID_PATTERN.test(segment)) {
    return true;
  }
  if (LONG_NUMERIC_SEGMENT_PATTERN.test(segment)) {
    return true;
  }

  const chunks = segment.split("-");
  if (chunks.length === 1) {
    return (
      segment.length >= OPAQUE_IDENTIFIER_MIN_LENGTH &&
      /[a-z]/.test(segment) &&
      /[0-9]/.test(segment)
    );
  }

  // Hyphen-joined. Judged on the de-hyphenated length so `trips-2026` (9) stays a
  // title while `9f8e7d6c-5b4a-3928-1706` (20) is long enough to be a token.
  return (
    segment.replace(/-/g, "").length >= OPAQUE_IDENTIFIER_MIN_LENGTH &&
    chunks.some(chunkLooksRandom)
  );
}

/** More segments than this is not a page hierarchy an admin authored. */
const MAX_CMS_SEGMENTS = 4;

/**
 * Segment words that mark a credential, recovery or callback flow.
 *
 * Every one of these is ALREADY excluded by gate 1 at its real address; this list
 * is the belt to that braces, and it covers the addresses gate 1 admits because
 * nothing claims them — the catch-all's territory. `/verify/abc123` is not a route
 * today, so gate 1 says yes; a future release that adds one would be excluded by
 * gate 1 too, but until then a link of that shape in the wild must not be tracked.
 *
 * Matched case-insensitively against WHOLE segments only, so `overview`,
 * `verification-of-membership` and `pinnacle-ridge` are unaffected.
 */
const CREDENTIAL_SEGMENT_WORDS: ReadonlySet<string> = new Set([
  "activate",
  "auth",
  "callback",
  "callbacks",
  "code",
  "codes",
  "confirm",
  "invitation",
  "invitations",
  "invite",
  "invites",
  "magic",
  "oauth",
  "otp",
  "pin",
  "pins",
  "recover",
  "recovery",
  "reset",
  "return",
  "secret",
  "session",
  "token",
  "tokens",
  "verification",
  "verify",
]);

/** One trailing slash off. Matches how the route census normalises. */
function normalisePathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

/**
 * May Google Analytics load, and may a page view be sent, for this pathname?
 *
 * Takes a PATHNAME only — never a full URL, never a search string. The caller
 * passes `usePathname()` (which is already query-free and fragment-free), and a
 * value that does carry `?` or `#` is refused rather than parsed, because a caller
 * handing this a full URL is a caller that would also have handed it to Google.
 */
export function isAnalyticsEligiblePath(pathname: string): boolean {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) {
    return false;
  }
  // A pathname carrying either of these is not a pathname. Fail closed rather
  // than stripping: the stripped remainder might be eligible and the caller's bug
  // would go unnoticed.
  if (pathname.includes("?") || pathname.includes("#")) {
    return false;
  }

  const path = normalisePathname(pathname);

  // Gate 1: the address must be served by one of the five approved public routes.
  if (!isFixedNonceWebsitePath(path)) {
    return false;
  }

  if (path === "/") {
    return true;
  }

  // Gate 2: and it must look like an ordinary public page.
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.length > MAX_CMS_SEGMENTS) {
    return false;
  }

  return segments.every(
    (segment) =>
      segment.length <= MAX_CMS_SEGMENT_LENGTH &&
      CMS_SEGMENT_PATTERN.test(segment) &&
      !CREDENTIAL_SEGMENT_WORDS.has(segment.toLowerCase()) &&
      !looksLikeOpaqueIdentifier(segment),
  );
}

/**
 * The ONLY page-location value that may be sent to Google: `origin` + `pathname`.
 *
 * No query string, no fragment, no credentials, no identifiers — section 7's list
 * is enforced by construction here rather than by filtering, because a filter has
 * to anticipate the parameter names and this does not. Returns `null` for an
 * ineligible path, so a caller that forgets to check eligibility separately still
 * cannot send one.
 *
 * `origin` is passed in rather than read from `window` so this is testable and so
 * the server can compute the same answer.
 */
export function buildAnalyticsPageLocation(
  origin: string,
  pathname: string,
): string | null {
  if (!isAnalyticsEligiblePath(pathname)) {
    return null;
  }
  return `${origin.replace(/\/+$/, "")}${normalisePathname(pathname)}`;
}

/**
 * Sanitise a document referrer before Google is allowed to see it.
 *
 * gtag sends `document.referrer` automatically, and leaving it alone is a real
 * leak rather than a theoretical one: a visitor who lands on `/pay/<token>` and
 * then clicks through to the public site would have handed Google the payment
 * token in the referrer of the FIRST eligible page view. Overriding
 * `page_referrer` with this value is what closes it.
 *
 * The rules, tightest-first:
 *  • no referrer, or an unparseable one — send nothing (`null`), which makes gtag
 *    omit the field rather than fall back to the raw value;
 *  • SAME-ORIGIN referrer whose path is analytics-eligible — origin + pathname,
 *    the same sanitisation the page location gets;
 *  • SAME-ORIGIN referrer whose path is NOT eligible (an admin page, a token
 *    page, a member dashboard) — the ORIGIN only. That the visitor came from
 *    somewhere on this site is not sensitive; which excluded page is;
 *  • CROSS-ORIGIN referrer — the origin only. A search engine's or partner's URL
 *    can carry identifiers of its own, and the referring site is all the analytics
 *    value there is.
 */
export function sanitiseAnalyticsReferrer(
  referrer: string | null | undefined,
  currentOrigin: string,
): string | null {
  if (!referrer) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return null;
  }

  if (url.origin !== currentOrigin) {
    return url.origin;
  }

  return buildAnalyticsPageLocation(url.origin, url.pathname) ?? url.origin;
}
