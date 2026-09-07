import type { PlannedWarmupRoute } from "@/lib/deploy/warmup-route-policy";

/**
 * The warm-up itself (#2566): asks the target release for each discovered public
 * address and PROVES what happened, rather than counting 200s.
 *
 * ## Where the requests come from, and why that is the strongest available answer
 *
 * The owner's decision is explicit: "Send warm-up requests directly to the target
 * blue or green application service. Do not send the requests through the normal
 * production domain before cutover, as that may warm the currently live
 * application instead."
 *
 * This module runs INSIDE the target release, and the requests go to its own
 * loopback origin (`http://127.0.0.1:3000`). So "did we warm the right colour?" is
 * not a question about routing at all: the process that stores the page is the
 * process that answered. The deploy script reaches this code with
 * `docker compose exec` against the target service — the same mechanism it already
 * uses for the internal readiness check — so there is no path by which a warm-up
 * request could arrive at the live colour instead.
 *
 * Two consequences worth stating:
 *  • The store being populated is THIS container's in-memory LRU
 *    (`next.config.ts` — `isrFlushToDisk: false`), so warming one container says
 *    nothing about another. The deploy script therefore runs the gate once per web
 *    instance that can serve public traffic — the target colour and the cron-leader
 *    fallback — which is the owner's "warm every target instance separately".
 *  • The requests still pass through `src/proxy.ts`, so the policy, the nonce and
 *    the pre-setup gate all behave exactly as they will for a visitor.
 *
 * ## The production host reaches the release as `X-Forwarded-Host`
 *
 * A loopback request otherwise renders for `127.0.0.1:3000`, so the deployment's own
 * public host is sent with every request. WHICH header carries it is worth stating
 * exactly, because an earlier version of this comment asserted a mechanism that
 * measurably does not run:
 *
 *  • `x-forwarded-host` (with `x-forwarded-proto`) is what arrives, and it is the
 *    header this codebase reads. `src/app/api/issue-reports/route.ts` is the only
 *    place in the tree that resolves a request host at all, and it prefers the
 *    forwarded value over `Host`. Neither `src/proxy.ts` nor any `(website)` page
 *    reads either one: absolute URLs and `metadataBase` come from `NEXTAUTH_URL`
 *    (`src/lib/app-url.ts`, `src/app/layout.tsx`). So rendering, canonical URLs and
 *    redirects already match real production traffic.
 *  • `host` is set as well, and MEASURED not to reach the wire: an HTTP client writes
 *    `Host` from the URL authority, so a local Node server handed a request built
 *    exactly like the one below reported `host=127.0.0.1:3999` with
 *    `xfh=club.example.nz` (node v22.14; the runtime image is node:24.17-alpine —
 *    `Dockerfile`). It is kept rather than dropped because the intent is right and a
 *    client that stopped overwriting it would make the stronger form true for free.
 *
 * The consequence to hold on to: warming STORES what it renders, so the first
 * behaviour keyed on the RAW `Host` header — a canonical-host redirect, a host
 * allowlist — would need a wire `Host` that `fetch` cannot send, and would otherwise
 * either store a page rendered for the loopback authority or fail every route as an
 * `unexpected-redirect`. That assumption is enforced rather than recorded:
 * `src/lib/deploy/__tests__/warmup-host-header-contract.test.ts` fails if a public
 * render path starts reading the host header.
 *
 * `X-Forwarded-For` is deliberately NOT set: `getClientIp()` takes the RIGHTMOST
 * value as the trusted peer (`DEPLOYMENT.md` → "Public Rate Limits And Proxy
 * Headers"), so injecting one would be asking the app to trust a client address the
 * warm-up invented.
 *
 * ## Verification is a cache HIT — not a 200, and not a prerender header
 *
 * "Do not treat one successful HTTP 200 response as proof that a page is warm."
 * For a route the build declares stored, the first request renders and stores it and
 * a later request must come back `x-nextjs-cache: HIT` (or `STALE`). That header is
 * the supported indicator and it is MEASURED in this repository rather than assumed:
 * the module header of `src/lib/public-website-paths.ts` records a container run of
 * next@16.2.12 in which the ISR catch-all was the only route in either public group
 * answering with `x-nextjs-cache` / `x-nextjs-prerender`.
 *
 * The second of those two headers is NOT an equivalent indicator, and
 * {@link isStoredResponse} carries the framework source that says why: Next sets it
 * on a `MISS` as well.
 *
 * For a route the build declares per-request there is no store, so the gate proves
 * the opposite: a `render-only` response must NOT report a cache. One that starts
 * reporting one has begun storing a page rendered for one visitor — the #2352 hazard
 * inverted — and that is treated as systemic rather than tolerable. A `prebuilt`
 * route is the third case and is neither: its HTML was frozen at build time, so
 * there is no store for this gate to populate and a cache indicator on it is
 * expected rather than alarming.
 */

/** Why a route failed, in the categories the owner's decision distinguishes. */
export type WarmupFailureKind =
  /** No response at all: connection refused, reset, DNS, or a dropped socket. */
  | "unreachable"
  /** The per-request timeout expired on every attempt. */
  | "timeout"
  /** HTTP 5xx — the release could not render the page. */
  | "server-error"
  /** An unexpected 404 on an address the release should serve. */
  | "unexpected-404"
  /** Any other unexpected status. */
  | "unexpected-status"
  /** A redirect where the public route flow expects a page. */
  | "unexpected-redirect"
  /** A redirect to the login screen — a public page behind auth. */
  | "redirect-to-login"
  /** 200 with a body that is not a usable HTML document. */
  | "invalid-response"
  /** 200, repeatedly, but the release never reported the page as stored. */
  | "cache-not-stored"
  /** A per-request route reported a cache, so it is storing pages it must not. */
  | "unexpected-cache-header"
  /** The policy's nonce and the document's inline scripts disagree. */
  | "nonce-mismatch"
  /**
   * The overall warm-up deadline expired before the gate could ask: either before
   * this address was requested at all, or — after a successful render — before its
   * store could be verified. Either way nothing was proved, so it is a failure; what
   * this kind adds is that the release was never asked, so it is not at fault.
   */
  | "not-attempted";

export interface WarmupRouteResult {
  route: PlannedWarmupRoute;
  /** Did the release produce a usable page for this address? */
  rendered: boolean;
  /** Does a cache verification apply to this route at all? */
  cacheApplicable: boolean;
  /** Did a later request confirm the page was stored and reused? */
  cacheVerified: boolean;
  outcome: "warmed" | "unpublished-during-warmup" | "failed";
  failure?: { kind: WarmupFailureKind; detail: string };
  /** HTTP status of the last response received, or null if none was. */
  httpStatus: number | null;
  /** The cache indicator of the verification response, verbatim, or null. */
  cacheHeader: string | null;
  /** How many HTTP requests this route cost, retries included. */
  requests: number;
  durationMs: number;
}

export interface WarmupRunOptions {
  /** The target's own origin. Always loopback in production use. */
  origin: string;
  /** The production Host the release should render for. */
  hostHeader: string;
  /** `https` in production; overridable so a staging stack can be honest. */
  forwardedProto?: string;
  concurrency: number;
  requestTimeoutMs: number;
  totalTimeoutMs: number;
  /**
   * Extra attempts for a TRANSIENT failure only (no response, or a per-request
   * timeout). A 5xx, a 404 and a missing cache header are never retried: "Do not
   * hide a persistent rendering or cache failure through repeated retries."
   */
  transientRetries?: number;
  /** How long to wait before re-checking a store that reported MISS or STALE. */
  cacheRecheckDelayMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Re-reads whether a CMS path is still published, so the owner's "unpublished
   * after discovery" race is told apart from an unexpectedly missing page.
   */
  isStillPublished?: (path: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic milliseconds. Injected so the deadline is testable. */
  monotonicNow?: () => number;
}

export interface WarmupRunReport {
  results: readonly WarmupRouteResult[];
  /** True when the overall deadline expired with routes still unattempted. */
  deadlineExpired: boolean;
  durationMs: number;
  /** The highest number of requests in flight at once, as observed. */
  peakConcurrency: number;
}

const CACHE_HEADER = "x-nextjs-cache";
const PRERENDER_HEADER = "x-nextjs-prerender";

/**
 * Cache indicators that mean "this response came out of the store".
 *
 * `STALE` counts: the entry existed and was served from the store, which is the
 * property being verified. Whether it was fresh is the business of the 300-second
 * backstop, not of the warm-up.
 *
 * `MISS` and `REVALIDATED` deliberately do not count. `MISS` is the whole point of
 * the check. `REVALIDATED` means the response was regenerated because THAT REQUEST
 * asked for on-demand revalidation — something a warm-up request never does — so
 * accepting it would accept a fresh render as proof of a store.
 */
const STORED_CACHE_VALUES = new Set(["HIT", "STALE"]);

const DEFAULT_TRANSIENT_RETRIES = 1;
const DEFAULT_CACHE_RECHECK_DELAY_MS = 250;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * One named directive out of a Content-Security-Policy header.
 *
 * Matched directive-by-directive rather than against the whole header, for the
 * reason `e2e/static-cms-pages.spec.ts` records: a whole-header search conflates
 * `script-src` with `connect-src` and `frame-src`, which legitimately name other
 * origins.
 */
function cspDirective(policy: string | null, name: string): string | null {
  if (!policy) {
    return null;
  }

  return (
    policy
      .split(";")
      .map((part) => part.trim())
      .find((part) => part === name || part.startsWith(`${name} `)) ?? null
  );
}

/** Every inline `<script>` open tag in `html` carrying no non-empty nonce. */
function unnoncedInlineScripts(html: string): string[] {
  const offenders: string[] = [];

  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attributes = match[1];
    // Unreachable: capture group 1 has no `?` quantifier, so it is always
    // present (possibly empty) whenever the whole pattern matches.
    if (attributes === undefined) continue;
    if (/\bsrc\s*=/i.test(attributes)) continue;
    if (/\btype\s*=\s*["']?application\/(?:ld\+)?json/i.test(attributes))
      continue;
    if (/\bnonce\s*=\s*(?:"[^"]+"|'[^']+'|[^\s"'>]+)/i.test(attributes))
      continue;
    offenders.push(match[0]);
  }

  return offenders;
}

/**
 * Does the served document agree with the policy served alongside it?
 *
 * The owner's decision lists "CSP, nonce or hydration failure identified by the
 * verification tests" among the critical failures, and this is the shape that
 * failure takes here. A stored page carries ONE nonce frozen into its inline
 * scripts (`src/lib/release-nonce.ts`); if the policy on a later response names a
 * different one, every script on the page is refused and the page never hydrates —
 * a site that looks perfect to a status-code check and is inert in a browser.
 *
 * Silent when the policy names no nonce: that is the case for a response the proxy
 * did not touch, and inventing a failure there would block deploys on something
 * this gate has not established.
 */
export function nonceConsistencyProblem(
  policy: string | null,
  html: string,
): string | null {
  const scriptSrc = cspDirective(policy, "script-src");
  const nonce = scriptSrc?.match(/'nonce-([^']+)'/)?.[1] ?? null;

  if (!nonce) {
    return null;
  }

  const offenders = unnoncedInlineScripts(html);
  if (offenders.length > 0) {
    return `the document carries ${offenders.length} inline script(s) with no nonce while the policy allows only nonced scripts, so the page would not hydrate`;
  }

  if (!html.includes(`nonce="${nonce}"`)) {
    return "the nonce stamped into the document is not the one this response's policy allows, so every inline script on the page would be refused";
  }

  return null;
}

interface WarmupResponse {
  status: number | null;
  cacheHeader: string | null;
  prerenderHeader: string | null;
  contentType: string | null;
  location: string | null;
  policy: string | null;
  body: string | null;
  /** Set when no response arrived at all. */
  transportError: "unreachable" | "timeout" | null;
}

/**
 * One HTTP request to the target, with its own timeout.
 *
 * The path is passed to the URL constructor as data and never interpolated into a
 * command line of any kind — the owner's request-safety rules are satisfied
 * structurally rather than by escaping.
 */
async function requestOnce(
  path: string,
  options: WarmupRunOptions,
  timeoutMs: number,
): Promise<WarmupResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => {
      controller.abort();
    },
    Math.max(1, timeoutMs),
  );

  try {
    const response = await fetchImpl(new URL(path, options.origin).toString(), {
      method: "GET",
      // Never follow a redirect: the decision requires each one to be VALIDATED
      // rather than chased, and a followed redirect would also warm an address
      // discovery never approved.
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        // `x-forwarded-host` is the header that reaches the release; `host` is set
        // for intent and is overwritten by the client with the URL authority. See
        // the module header — this is measured, not assumed.
        host: options.hostHeader,
        "x-forwarded-host": options.hostHeader,
        "x-forwarded-proto": options.forwardedProto ?? "https",
        "user-agent": "AlpineClubBookings-deploy-warmup/1",
        accept: "text/html,application/xhtml+xml",
      },
    });

    // The body is always read, even when it is not inspected: an unconsumed body
    // holds its socket open, and this loop makes hundreds of requests.
    const body = await response.text();

    return {
      status: response.status,
      cacheHeader: response.headers.get(CACHE_HEADER),
      prerenderHeader: response.headers.get(PRERENDER_HEADER),
      contentType: response.headers.get("content-type"),
      location: response.headers.get("location"),
      policy: response.headers.get("content-security-policy"),
      body,
      transportError: null,
    };
  } catch (error) {
    const aborted =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");

    return {
      status: null,
      cacheHeader: null,
      prerenderHeader: null,
      contentType: null,
      location: null,
      policy: null,
      body: null,
      transportError: aborted ? "timeout" : "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeHtmlDocument(response: WarmupResponse): boolean {
  const contentType = response.contentType ?? "";
  const body = response.body ?? "";

  return (
    contentType.toLowerCase().includes("text/html") &&
    body.length > 0 &&
    /<html[\s>]/i.test(body)
  );
}

/**
 * Did this response come OUT of the release's page store?
 *
 * Decided from `x-nextjs-cache` ALONE whenever that header is present, and the
 * "alone" is the correction this module's first cut needed. `x-nextjs-prerender: 1`
 * is NOT a store indicator: next@16.2.12 sets both headers in the SAME block for
 * every SSG/ISR app-page response, hit and miss alike
 * (`node_modules/next/dist/build/templates/app-page.js`):
 *
 *     if (isSSG && !isDynamicRSCRequest && (!didPostpone || isPrefetchRSCRequest)) {
 *       if (!isMinimalMode) {
 *         res.setHeader('x-nextjs-cache', isOnDemandRevalidate ? 'REVALIDATED'
 *           : cacheEntry.isMiss ? 'MISS'
 *           : cacheEntry.isStale ? 'STALE' : 'HIT');
 *       }
 *       res.setHeader(NEXT_IS_PRERENDER_HEADER, '1');
 *     }
 *
 * So the prerender header says which ROUTE replied — a prerender-capable one — and
 * never that a store was populated. `src/lib/public-website-paths.ts` records the
 * same conclusion from a container run, where even the catch-all's 404 answered with
 * the ISR headers. Treating it as equivalent made a release whose store never
 * populates report every page as "confirmed stored (MISS)" and pass the gate, which
 * is precisely the systemic failure the owner's decision requires to block.
 *
 * The header is kept for exactly one case: Next omits `x-nextjs-cache` in MINIMAL
 * mode, and there the prerender header is the only indicator that exists. This
 * deployment does not run minimal mode, so the branch is unreachable here; it is
 * present so that a hosting change degrades to "verified" rather than to a gate that
 * blocks every deploy for a reason no operator could act on.
 */
function isStoredResponse(response: WarmupResponse): boolean {
  const cacheHeader = response.cacheHeader?.trim().toUpperCase() ?? null;

  if (cacheHeader !== null) {
    return STORED_CACHE_VALUES.has(cacheHeader);
  }

  return response.prerenderHeader?.trim() === "1";
}

function reportsAnyCache(response: WarmupResponse): boolean {
  return response.cacheHeader !== null || response.prerenderHeader !== null;
}

/**
 * Is this planned address a Page Content row, whatever tier it was planned at?
 *
 * The distinction the tier cannot make: the club's configured Book Now target is a
 * published CMS page promoted to `critical`, so "is it a CMS page?" and "is it tier
 * cms?" are different questions, and the unpublished-mid-run race is a property of
 * the former.
 */
function isCmsPageRoute(route: PlannedWarmupRoute): boolean {
  return (
    route.source === "published-cms-page" || route.source === "book-now-target"
  );
}

function failed(
  route: PlannedWarmupRoute,
  kind: WarmupFailureKind,
  detail: string,
  partial: Partial<WarmupRouteResult> = {},
): WarmupRouteResult {
  return {
    route,
    rendered: false,
    cacheApplicable: route.cacheClass === "isr",
    cacheVerified: false,
    outcome: "failed",
    failure: { kind, detail },
    httpStatus: null,
    cacheHeader: null,
    requests: 0,
    durationMs: 0,
    ...partial,
  };
}

/**
 * Requests one address, retrying only a transient failure.
 *
 * Returns the last response, plus how many requests it cost, so the report can
 * show what the gate actually spent.
 */
async function requestWithTransientRetry(
  path: string,
  options: WarmupRunOptions,
  deadline: number,
): Promise<{ response: WarmupResponse; requests: number }> {
  const now = options.monotonicNow ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.transientRetries ?? DEFAULT_TRANSIENT_RETRIES;

  let requests = 0;
  let response: WarmupResponse = {
    status: null,
    cacheHeader: null,
    prerenderHeader: null,
    contentType: null,
    location: null,
    policy: null,
    body: null,
    transportError: "unreachable",
  };

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      return { response, requests };
    }

    requests += 1;
    response = await requestOnce(
      path,
      options,
      Math.min(options.requestTimeoutMs, remaining),
    );

    if (!response.transportError) {
      return { response, requests };
    }

    if (attempt < retries) {
      // A short, fixed pause. Long enough for a socket-level blip to clear, short
      // enough that it cannot mask a release that is simply not answering.
      await sleep(Math.min(200, Math.max(0, deadline - now())));
    }
  }

  return { response, requests };
}

/** Warms and verifies one address. */
async function warmOneRoute(
  route: PlannedWarmupRoute,
  options: WarmupRunOptions,
  deadline: number,
): Promise<WarmupRouteResult> {
  const now = options.monotonicNow ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  let requests = 0;

  const finish = (result: WarmupRouteResult): WarmupRouteResult => ({
    ...result,
    requests,
    durationMs: now() - startedAt,
  });

  const first = await requestWithTransientRetry(route.path, options, deadline);
  requests += first.requests;
  const firstResponse = first.response;

  if (firstResponse.transportError) {
    // Requests of zero means the overall deadline had already expired when this
    // route came up, so nothing was ever asked. Saying "the release did not answer"
    // there would send an operator hunting a fault that does not exist.
    if (requests === 0) {
      return finish(
        failed(
          route,
          "not-attempted",
          `the overall warm-up deadline of ${options.totalTimeoutMs}ms expired before this address was requested`,
        ),
      );
    }

    return finish(
      failed(
        route,
        firstResponse.transportError === "timeout" ? "timeout" : "unreachable",
        firstResponse.transportError === "timeout"
          ? `no response within ${options.requestTimeoutMs}ms`
          : "the target release did not answer at all",
      ),
    );
  }

  const status = firstResponse.status ?? 0;

  if (status >= 300 && status < 400) {
    const location = firstResponse.location ?? "(no Location header)";
    const toLogin = /(^|\/)login(\?|\/|$)/i.test(location);
    return finish(
      failed(
        route,
        toLogin ? "redirect-to-login" : "unexpected-redirect",
        toLogin
          ? `redirected to the login screen (${location}); a public page must not be behind authentication`
          : `redirected to ${location}, which is not part of the public route flow`,
        { httpStatus: status },
      ),
    );
  }

  if (status === 404) {
    // Keyed on the SOURCE, not the tier. The configured Book Now target is a
    // published CMS page that `buildWarmupPlan` promotes to tier `critical`, so a
    // tier test made it the one CMS page in the plan that never got this re-check —
    // and an admin unpublishing it mid-run would have blocked the cutover with an
    // `unexpected-404` on a page that was answering correctly.
    if (isCmsPageRoute(route) && options.isStillPublished) {
      const stillPublished = await options
        .isStillPublished(route.path)
        .catch(() => true);

      if (!stillPublished) {
        // The owner's CMS-consistency case: an admin hid the page between
        // discovery and this request, so 404 is the CORRECT answer. Reported, not
        // counted against the tolerance — and deliberately not blocking, because a
        // production cutover must not hinge on an admin's timing.
        return finish({
          route,
          rendered: false,
          cacheApplicable: false,
          cacheVerified: false,
          outcome: "unpublished-during-warmup",
          httpStatus: status,
          cacheHeader: firstResponse.cacheHeader,
          requests,
          durationMs: 0,
        });
      }
    }

    return finish(
      failed(
        route,
        "unexpected-404",
        "the release answered 404 for an address it is expected to serve",
        { httpStatus: status },
      ),
    );
  }

  if (status >= 500) {
    return finish(
      failed(route, "server-error", `the release answered HTTP ${status}`, {
        httpStatus: status,
      }),
    );
  }

  if (status !== 200) {
    return finish(
      failed(
        route,
        "unexpected-status",
        `the release answered HTTP ${status}`,
        {
          httpStatus: status,
        },
      ),
    );
  }

  if (!looksLikeHtmlDocument(firstResponse)) {
    return finish(
      failed(
        route,
        "invalid-response",
        `HTTP 200 with no usable HTML document (content-type ${firstResponse.contentType ?? "absent"}, ${firstResponse.body?.length ?? 0} bytes)`,
        { httpStatus: status },
      ),
    );
  }

  if (route.cacheClass !== "isr") {
    // Two classes reach here, and only ONE of them must report no cache.
    //
    //  • `render-only` is `force-dynamic`, which emits neither header, so a cache
    //    indicator means the release has quietly begun storing a per-request page.
    //  • `prebuilt` is build-time HTML that never revalidates, and next@16.2.12 sets
    //    BOTH headers on it because it is `isSSG` — typically `x-nextjs-cache: HIT`.
    //    Requiring their absence would fail every such route as a release-wide fault
    //    the moment one existed (#2352 slice 3 makes that likely), contradicting this
    //    class's own policy note in `warmup-route-policy.ts`: there is no store to
    //    populate, so a cache-hit header is not required. Not required, and — since
    //    the build already produced the HTML — not alarming either.
    if (route.cacheClass === "render-only" && reportsAnyCache(firstResponse)) {
      return finish(
        failed(
          route,
          "unexpected-cache-header",
          `a per-request route reported a cache (${CACHE_HEADER}: ${firstResponse.cacheHeader ?? "absent"}, ${PRERENDER_HEADER}: ${firstResponse.prerenderHeader ?? "absent"}), so this release is storing a page rendered for one visitor`,
          { httpStatus: status, cacheHeader: firstResponse.cacheHeader },
        ),
      );
    }

    const nonceProblem = nonceConsistencyProblem(
      firstResponse.policy,
      firstResponse.body ?? "",
    );
    if (nonceProblem) {
      return finish(
        failed(route, "nonce-mismatch", nonceProblem, { httpStatus: status }),
      );
    }

    return finish({
      route,
      rendered: true,
      cacheApplicable: false,
      cacheVerified: false,
      outcome: "warmed",
      httpStatus: status,
      // Recorded for `prebuilt` because it is real and worth reading; null for
      // `render-only`, where the absence is the thing that was just proved.
      cacheHeader:
        route.cacheClass === "prebuilt" ? firstResponse.cacheHeader : null,
      requests,
      durationMs: 0,
    });
  }

  // A stored route: prove the store. One verification request, and one re-check
  // after a short pause if the first says the entry was being (re)generated.
  let verification = firstResponse;
  let verified = false;

  for (let round = 0; round < 2 && !verified; round += 1) {
    if (round > 0) {
      await sleep(
        Math.min(
          options.cacheRecheckDelayMs ?? DEFAULT_CACHE_RECHECK_DELAY_MS,
          Math.max(0, deadline - now()),
        ),
      );
    }

    const next = await requestWithTransientRetry(route.path, options, deadline);
    requests += next.requests;

    // Zero requests means the OVERALL deadline had already expired, so the
    // verification request was never made — the same case the first-request path
    // guards above, and the same misattribution if it is not guarded here. Without
    // this, `requestWithTransientRetry`'s zero-request stub arrives carrying its
    // default `transportError: "unreachable"`, the branch below reports "the release
    // stopped answering while the store was being verified" about a release that was
    // never asked, and — because the recorded kind is `unreachable` rather than
    // `not-attempted` — `runWarmup` reports `deadlineExpired: false`, so the run
    // summary denies the deadline that caused it. Still a FAILURE: the store was not
    // proved, which for a critical address is a blocked cutover.
    if (next.requests === 0) {
      return finish(
        failed(
          route,
          "not-attempted",
          `the overall warm-up deadline of ${options.totalTimeoutMs}ms expired before the store on this address could be verified`,
          {
            rendered: true,
            // The last response actually received: the render, or the previous
            // round's MISS. Read before `verification` is reassigned below.
            httpStatus: verification.status,
            cacheHeader: verification.cacheHeader,
          },
        ),
      );
    }

    verification = next.response;

    if (verification.transportError) {
      return finish(
        failed(
          route,
          verification.transportError === "timeout" ? "timeout" : "unreachable",
          "the release stopped answering while the store was being verified",
          { rendered: true, httpStatus: null },
        ),
      );
    }

    if (verification.status !== 200) {
      return finish(
        failed(
          route,
          verification.status === 404 ? "unexpected-404" : "unexpected-status",
          `the release answered HTTP ${verification.status} on the verification request after a successful first render`,
          { rendered: true, httpStatus: verification.status },
        ),
      );
    }

    verified = isStoredResponse(verification);
  }

  if (!verified) {
    return finish(
      failed(
        route,
        "cache-not-stored",
        `repeated requests returned HTTP 200 but never reported the page as stored (${CACHE_HEADER}: ${verification.cacheHeader ?? "absent"})`,
        {
          rendered: true,
          httpStatus: verification.status,
          cacheHeader: verification.cacheHeader,
        },
      ),
    );
  }

  const nonceProblem = nonceConsistencyProblem(
    verification.policy,
    verification.body ?? "",
  );
  if (nonceProblem) {
    return finish(
      failed(route, "nonce-mismatch", nonceProblem, {
        rendered: true,
        httpStatus: verification.status,
        cacheHeader: verification.cacheHeader,
      }),
    );
  }

  return finish({
    route,
    rendered: true,
    cacheApplicable: true,
    cacheVerified: true,
    outcome: "warmed",
    httpStatus: verification.status,
    cacheHeader: verification.cacheHeader,
    requests,
    durationMs: 0,
  });
}

/**
 * Warms every planned route with BOUNDED concurrency and an overall deadline.
 *
 * Bounded because the owner's decision is explicit about it — "Avoid creating a
 * large CPU spike immediately before cutover" — and because a cold render costs
 * seconds of engine work that parallelises across cores
 * (`DEPLOYMENT.md` → "App CPU sizing"). Firing every route at once would put the
 * container under its heaviest load of the day moments before it takes traffic.
 *
 * The deadline FAILS CLOSED: a route the deadline prevented us from attempting — or
 * from verifying the store on, after it rendered — is recorded as `not-attempted`,
 * which is a failure like any other. A critical route among them blocks cutover, and
 * enough CMS routes among them exceed the tolerance and block it too. Nothing is
 * quietly treated as passing because time ran out.
 */
export async function runWarmup(
  routes: readonly PlannedWarmupRoute[],
  options: WarmupRunOptions,
): Promise<WarmupRunReport> {
  const now = options.monotonicNow ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + options.totalTimeoutMs;
  const results: WarmupRouteResult[] = new Array(routes.length);

  let cursor = 0;
  let inFlight = 0;
  let peakConcurrency = 0;
  let deadlineExpired = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= routes.length) {
        return;
      }

      const route = routes[index];
      if (!route) {
        // Unreachable: `index >= routes.length` already returned above.
        return;
      }

      if (now() >= deadline) {
        deadlineExpired = true;
        results[index] = failed(
          route,
          "not-attempted",
          `the overall warm-up deadline of ${options.totalTimeoutMs}ms expired before this address was requested`,
        );
        continue;
      }

      inFlight += 1;
      peakConcurrency = Math.max(peakConcurrency, inFlight);
      try {
        results[index] = await warmOneRoute(route, options, deadline);
      } finally {
        inFlight -= 1;
      }
    }
  };

  const workerCount = Math.max(
    1,
    Math.min(Math.floor(options.concurrency) || 1, routes.length || 1),
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    results,
    // Derived from the results as well as from the loop's own pre-check: a route
    // whose first request found no time left is recorded as `not-attempted` inside
    // `warmOneRoute`, and the report must still say the deadline bit.
    deadlineExpired:
      deadlineExpired ||
      results.some((result) => result?.failure?.kind === "not-attempted"),
    durationMs: now() - startedAt,
    peakConcurrency,
  };
}
