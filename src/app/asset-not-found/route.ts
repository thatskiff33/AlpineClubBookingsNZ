import { NextResponse } from "next/server";
import { CSP_HEADER, setSecurityHeaders } from "@/lib/csp";

/**
 * Terminal, document-free 404 for a static-asset URL nothing serves (#2404).
 *
 * Reached only through the `afterFiles` rewrites in `next.config.ts` — see
 * `src/lib/asset-url-404.ts` for why those shapes exist and why `afterFiles` is
 * the right stage. Without it a request for a missing image or a deleted
 * `_next/static` chunk fell through to the `(website)/[...slug]` CMS catch-all
 * and was answered with the club's whole "page not found" DOCUMENT — measured at
 * ~29KB of `text/html` carrying 19 inline `<script>` tags with no `nonce`, on a
 * response with no `Content-Security-Policy` header at all, because the proxy
 * that mints the nonce does not run on those paths.
 *
 * The body is EMPTY on purpose, and that is the security property: with no
 * document there is nothing for a policy to have to permit, so the missing nonce
 * stops being a problem instead of being worked around. It also removes a render
 * amplifier — every probe of `/wp-content/uploads/x.png` used to cost a full
 * dynamic React render, and bots probe those addresses continuously.
 *
 * No `content-type` is set, for the same reason: there is no content. `nosniff`
 * below (and at the edge) keeps a browser from inventing one.
 *
 * The headers are set HERE rather than left to `Caddyfile`, so the property holds
 * in dev, in the E2E stack, and in any deployment that does not front the app
 * with our reverse proxy. `default-src 'none'` is the honest policy for an empty
 * response — strictly tighter than the edge's set-if-absent `default-src 'self'`
 * fallback, and it needs no nonce, so nothing about it can rot the way the
 * page-render path did.
 *
 * `/asset-not-found` is itself a reachable URL and answers exactly this: a 404
 * with no body. That is deliberate — it has no extension, so it cannot be
 * rewritten into itself, and a URL that does not exist answering 404 is the
 * correct outcome whoever asks for it. It reveals nothing: the club's own 404
 * screen still answers every page-shaped miss.
 *
 * Verb handling mirrors `src/app/api/[[...unmatched]]/route.ts` and for the same
 * reason. HEAD is NOT exported — Next auto-implements it from GET
 * (`route-modules/app-route/helpers/auto-implement-methods.js`) and strips the
 * body downstream, so its headers cannot drift from GET's. The six remaining
 * standard verbs are listed because Next only answers the verbs a route exports,
 * and an unlisted one would answer 405 where its neighbour answers 404. A
 * non-standard verb (`PROPFIND` and the rest of the scanner vocabulary) never
 * reaches this module at all: Next's app-route module rejects those with a bare
 * 400 before it resolves a handler.
 */

export const dynamic = "force-dynamic";

function assetNotFound() {
  const response = new NextResponse(null, { status: 404 });

  setSecurityHeaders(response.headers);
  response.headers.set(
    CSP_HEADER,
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );

  return response;
}

export function GET() {
  return assetNotFound();
}

export function POST() {
  return assetNotFound();
}

export function PUT() {
  return assetNotFound();
}

export function PATCH() {
  return assetNotFound();
}

export function DELETE() {
  return assetNotFound();
}

export function OPTIONS() {
  return assetNotFound();
}
