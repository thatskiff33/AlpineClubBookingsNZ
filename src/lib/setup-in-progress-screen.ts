/**
 * The "Site setup in progress" holding screen, in one place (#2420).
 *
 * Two surfaces render this screen and they must not drift:
 *
 *  1. `src/proxy.ts` — the authoritative one. Until `ClubTheme.completedAt` is
 *     set, the proxy answers EVERY public-website address with `503 Service
 *     Unavailable` and this screen as the body. A response written by the proxy
 *     cannot reach the app's compiled stylesheet (its URL carries a build hash
 *     the proxy has no way to know), so `buildSetupInProgressDocument()` ships a
 *     complete, self-contained document: the club's own theme variables inlined
 *     plus a short inline stylesheet, no external CSS, no images, no scripts.
 *     That is deliberate — the holding screen must render on an install whose
 *     static assets a visitor has never fetched, and it means the "don't 503 the
 *     assets the holding screen needs" constraint is satisfied by needing none.
 *  2. `src/components/website/website-chrome.tsx` — the fallback, shared by both
 *     public route groups (it was `(website)/layout.tsx` until the #2352 D1
 *     narrowing extracted it). The gate answers only for a
 *     path `isPublicWebsitePath()` CLAIMS, and asset-extension paths are refused
 *     on purpose — this screen is a document, and a document must never be the
 *     answer to a request for an image — so such a URL that no route serves
 *     reaches the chrome directly; the chrome keeps its own pre-setup branch so
 *     those cannot see the real site. It renders as normal JSX against the app
 *     stylesheet, so
 *     it looks slightly richer than the proxy's inline-styled copy. Only the
 *     WORDS are shared, via `SETUP_IN_PROGRESS_COPY` below, and
 *     `setup-gate.test.ts` pins that both surfaces carry the same words.
 *
 * Nothing here touches the database or `next/server`, so the layout can import
 * the copy without pulling the proxy's request machinery into a page render.
 */

/**
 * The words on the screen. Single source of truth for both surfaces above —
 * change the copy here, not in the layout or the document builder.
 */
export const SETUP_IN_PROGRESS_COPY = {
  eyebrow: "Site setup in progress",
  heading: (clubName: string) => `${clubName} is getting ready.`,
  body: "The public website will open after an administrator completes the site style setup.",
  contactPrefix: "Contact",
} as const;

/**
 * How long a client is told to wait before retrying, in seconds (the
 * `Retry-After` header on every gated 503).
 *
 * The header is set rather than omitted, and the value is deliberate. A bare
 * 503 tells a crawler nothing: Google's documented behaviour is to treat a 503
 * WITH `Retry-After` as a temporary outage and hold the club's URLs, and a
 * long-running bare 503 as a signal to start dropping them. An uptime monitor
 * gets the same benefit — "not ready yet, ask again shortly" rather than "down".
 *
 * Two minutes because setup completion is a human action on the site-style
 * wizard that flips the state in one save, and because the proxy's own cache of
 * the setup state picks up that save within 15 seconds plus one request (an
 * expired answer is served while it refreshes; see `SETUP_STATE_TTL_MS`). A longer value would leave a crawler waiting on a site
 * that is already live; a much shorter one just invites needless retries.
 */
export const SETUP_IN_PROGRESS_RETRY_AFTER_SECONDS = 120;

/**
 * Minimal HTML escaper for the two admin-editable values interpolated into the
 * document (club name, contact email).
 *
 * Local rather than `escapeHtml` from `@/lib/email-templates/escape`: this
 * module is bundled into the proxy, and even a leaf import is one more edge
 * into the email layer from a module whose whole point is to have none. The
 * two escapers stay separate deliberately.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Inline stylesheet for the standalone document.
 *
 * Every colour reads a `--brand-*` custom property that `buildClubThemeCss()`
 * emits, with a literal fallback so the screen is still legible if the theme row
 * is missing or the database is unreachable. Fonts stay on a system stack on
 * purpose: the club's font variables resolve to `next/font` variables that only
 * exist once the app's stylesheet has loaded, and a `var()` that resolves to an
 * undefined variable invalidates the whole declaration rather than falling
 * through to the next family in the list.
 */
const DOCUMENT_STYLES = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:4rem 1rem;
  background:var(--brand-snow,#f8fafc);
  color:var(--brand-deep,#1f2937);
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  line-height:1.6;
  -webkit-font-smoothing:antialiased;
}
main{max-width:42rem;text-align:center}
.eyebrow{
  display:inline-flex;
  align-items:center;
  border-radius:9999px;
  background:var(--brand-charcoal,#262626);
  color:var(--brand-snow,#f8fafc);
  padding:0.25rem 0.75rem;
  margin:0 0 1rem;
  font-size:0.7rem;
  font-weight:600;
  text-transform:uppercase;
  letter-spacing:0.24em;
}
h1{
  margin:0;
  font-size:2.25rem;
  line-height:1.15;
  font-weight:700;
  color:var(--brand-charcoal,#262626);
}
.lede{margin:1.25rem auto 0;max-width:36rem;font-size:1rem}
.contact{margin:1.5rem 0 0;font-size:0.875rem;color:var(--brand-ridge,#4b5563)}
.contact a{
  font-weight:500;
  color:var(--brand-charcoal,#262626);
  text-decoration:underline;
  text-decoration-color:var(--brand-gold,#c8a227);
  text-decoration-thickness:2px;
  text-underline-offset:4px;
}
@media (min-width:640px){h1{font-size:3rem}.lede{font-size:1.125rem}}
`;

export interface SetupInProgressDocumentInput {
  /** Club display name, from the same source the layout's screen uses. */
  clubName: string;
  /** Contact address, from the same source the layout's screen uses. */
  contactEmail: string;
  /** `buildClubThemeCss()` output, so the screen carries the club's colours. */
  themeCss: string;
}

/**
 * A complete, self-contained HTML document for the holding screen.
 *
 * The club theme CSS is inlined exactly as the shared public chrome
 * (`src/components/website/website-chrome.tsx`) inlines it —
 * same builder, same admin-authored `rawCss` trust level — so the two screens
 * share a palette. `<html class="website-theme">` because the theme sheet scopes
 * half its variables to that class.
 */
export function buildSetupInProgressDocument({
  clubName,
  contactEmail,
  themeCss,
}: SetupInProgressDocumentInput): string {
  const safeContactEmail = escapeHtml(contactEmail);

  return `<!doctype html>
<html lang="en" class="website-theme">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(SETUP_IN_PROGRESS_COPY.eyebrow)}</title>
<style data-site-style="club-theme">${themeCss}</style>
<style>${DOCUMENT_STYLES}</style>
</head>
<body>
<main>
<p class="eyebrow">${escapeHtml(SETUP_IN_PROGRESS_COPY.eyebrow)}</p>
<h1>${escapeHtml(SETUP_IN_PROGRESS_COPY.heading(clubName))}</h1>
<p class="lede">${escapeHtml(SETUP_IN_PROGRESS_COPY.body)}</p>
<p class="contact">${escapeHtml(SETUP_IN_PROGRESS_COPY.contactPrefix)} <a href="mailto:${safeContactEmail}">${safeContactEmail}</a></p>
</main>
</body>
</html>
`;
}
