/**
 * Static-asset URLs nothing serves are answered with an empty 404, not the
 * club's "page not found" document (#2404).
 *
 * **What was wrong.** `src/proxy.ts` mints the CSP nonce per request, and its
 * matcher skipped every path ending in an image extension, plus `_next/static`,
 * because running edge middleware on the dozens of chunk and image requests a
 * page load issues is the hottest path in the app. Correct for a file that
 * EXISTS. For one that does not, the request fell through to the
 * `(website)/[...slug]` CMS catch-all, which called `notFound()` and rendered the
 * whole 404 document anyway. Measured on the merged #2434 build: `GET /foo.png`
 * answered **404 with ~29KB of `text/html`, no `Content-Security-Policy` header
 * at all, and 19 inline `<script>` tags with no `nonce`** — all of them then
 * blocked by `Caddyfile`'s set-if-absent `default-src 'self'` fallback, which
 * carries no `'nonce-…'` source. Identical for `/favicon.ico`, `/logo.png`,
 * `/foo.svg`, `/wp-content/uploads/x.jpg`, `/_next/static/chunks/nope.js` and
 * `/branding/anything-missing.ico`.
 *
 * **Two layers, and they are not alternatives.**
 *
 * 1. `src/proxy.ts`'s matcher is the FLOOR. It no longer skips paths by
 *    extension, so the only namespaces without a nonce are `/api`,
 *    `_next/static/` and `_next/image` — each independently proven never to
 *    render a document. Anything else that renders is nonced, whatever shape its
 *    URL has. That is what makes the property total rather than a list of cases
 *    somebody remembered.
 * 2. These rewrites are the COST and CONTENT fix. A machine asked for an image
 *    or a script; handing it 29KB of club branding is waste on both sides, and
 *    every probe of `/wp-content/uploads/x.png` used to cost a full dynamic React
 *    render — bots probe those addresses continuously. An empty 404 costs
 *    nothing and says exactly as much.
 *
 * Because layer 1 is total, a gap in layer 2 is now a performance regression
 * rather than a security one. That ordering is deliberate: an extension list is
 * exactly the kind of thing that goes stale (`avif`, `heic`, `woff2`…), and it
 * must not be load-bearing for CSP.
 *
 * **Why `afterFiles`.** Next checks the filesystem — `public/`, `_next/static`,
 * and the non-dynamic routes — BEFORE it consults an `afterFiles` rewrite, so a
 * real asset is served exactly as it was and never touches these rules; only a
 * miss reaches them. `beforeFiles` would shadow every real asset; `fallback`
 * runs after the dynamic `(website)/[...slug]` catch-all has already claimed the
 * URL and turned it into a render.
 */

/**
 * Extensions treated as "a machine asked for a file". Used only to decide
 * whether a MISS is answered with an empty 404 or with the club's 404 page, so a
 * missing entry costs a wasted render, never a missing nonce — see layer 1
 * above.
 */
export const ASSET_URL_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
] as const;

/** Where a missing asset-shaped URL is rewritten to. */
export const ASSET_NOT_FOUND_PATH = "/asset-not-found";

/**
 * Misses under `_next/static`. A stale browser tab asking for a chunk a deploy
 * removed is the ordinary case, and it wants JavaScript.
 *
 * `:path*` rather than `:path+` so bare `/_next/static` is covered too, for the
 * same reason `src/app/api/[[...unmatched]]/route.ts` is an optional catch-all.
 */
export const NEXT_STATIC_MISS_SOURCE = "/_next/static/:path*";

/**
 * Any path ending in an asset extension, at any depth — EXCEPT anything under
 * `/api`.
 *
 * The `/api` carve-out is a security requirement, not tidiness (#2405 review).
 * A path under a module-gated prefix that no handler claims must answer the same
 * bytes AND the same headers whether that module is on or off, or one anonymous
 * request reads off which optional modules a club runs. With the module OFF,
 * `src/proxy.ts`'s gate answers `{"error":"Not found"}` as `application/json`
 * (the gate's matcher entries cover `/api/chores/:path*` and friends whatever
 * the URL's tail looks like). With it ON the request reaches
 * `src/app/api/[[...unmatched]]/route.ts`, which answers the same thing —
 * unless a rewrite intercepted it first and returned an empty body with no
 * `content-type`. Hence the lookahead.
 *
 * Note the carve-out is compiled case-INSENSITIVELY, like every Next rewrite, so
 * `/API/x.png` is excluded here too even though Next's router would never send
 * it to an `/api` handler. That mismatch used to be a hole; it is now merely a
 * wasted render, because `src/proxy.ts` runs on `/API/x.png` and nonces it.
 *
 * A raw regex rather than a plain segment pattern because it has to span
 * segments (`/wp-content/uploads/x.png`) and carry that lookahead. Next compiles
 * it with `getPathMatch()`, the same function the guard uses, so the guard tests
 * the rule Next actually applies rather than a restatement of it.
 */
export const ASSET_EXTENSION_MISS_SOURCE = `/:path((?!api(?:/|$)).*\\.(?:${ASSET_URL_EXTENSIONS.join("|")}))`;

/**
 * The `afterFiles` rewrites, in the shape `next.config.ts` hands to Next.
 *
 * `_next/image` is deliberately absent: it is a REAL handler (the image
 * optimiser), so a rewrite would break optimised images rather than catch a
 * miss. It answers a bad request with its own short plain-text 400 and never
 * renders a page.
 */
export const ASSET_NOT_FOUND_REWRITES = [
  { source: NEXT_STATIC_MISS_SOURCE, destination: ASSET_NOT_FOUND_PATH },
  { source: ASSET_EXTENSION_MISS_SOURCE, destination: ASSET_NOT_FOUND_PATH },
] as const;
