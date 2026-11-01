import { NextResponse } from "next/server";

/**
 * The document a disabled module's PAGE path answers with (#4466).
 *
 * The module gate in `src/proxy.ts` (`getFeatureFlagBlockResponse`) used to
 * answer a page path with an empty 404, and a browser shows an empty 404 as a
 * blank page with no title and no language — which is what a member who follows
 * an old link to a switched-off feature landed on (WCAG 2.4.2 and 3.1.1). This is
 * a complete, self-contained document in the shape of
 * `buildSetupInProgressDocument()`: no scripts, no styles, nothing the CSP has to
 * allow. Its words are fixed and name neither the club nor the module, so the
 * body discloses nothing the 404 status did not already; `lang="en"` matches the
 * app's root layout.
 */
const MODULE_DISABLED_PAGE_DOCUMENT = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found</title>
</head>
<body>
<main>
<h1>Page not found</h1>
<p>This page does not exist.</p>
<p><a href="/">Go to the home page</a></p>
</main>
</body>
</html>
`;

/**
 * The 404 for a non-`/api` path a disabled module hides.
 *
 * Only a page-shaped `GET` or `HEAD` gets the document. An asset-shaped path
 * under a gated prefix (`/lodge/x.png`) keeps the empty 404 it shares with the
 * module-ON asset terminal (`asset-url-404.test.ts`), because a document must
 * never be the answer to a request for an image, and every other verb keeps the
 * empty 404 too. `pageShaped` is the proxy's own `isPageShapedPath()` verdict.
 */
export function moduleDisabledPageResponse(
  method: string,
  pageShaped: boolean,
): NextResponse {
  if (pageShaped && (method === "GET" || method === "HEAD")) {
    return new NextResponse(MODULE_DISABLED_PAGE_DOCUMENT, {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new NextResponse(null, { status: 404 });
}
