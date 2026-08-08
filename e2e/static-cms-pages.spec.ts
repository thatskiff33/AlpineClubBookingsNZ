import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "../prisma/e2e-fixtures";

/**
 * The admin-authored CMS pages served from full-route ISR (#2352 slice 1).
 *
 * Everything here needs a REAL server, and each case says why the unit suite
 * cannot stand in for it:
 *
 *  • the fixed per-release nonce is only meaningful if the nonce in the POLICY on a
 *    later response still matches the nonce FROZEN into the stored HTML — two
 *    different things that only a real render puts side by side;
 *  • the prefetch case (F1, the reconciliation's highest-severity finding) is about
 *    what a prefetch-shaped request causes to be STORED, which needs a store;
 *  • unpublish → 404 (F4) is simultaneously the verification the reconciliation
 *    asked for on `revalidatePublicSite()`: if `revalidatePath("/", "layout")` did
 *    not clear full-route ISR entries, an unpublished page would keep answering 200
 *    from the store and this spec would fail. Nothing short of a real cache can
 *    show that.
 *
 * This stack is seeded `SEED_THEME_COMPLETE=1` (.github/workflows/e2e.yml) and
 * built with `RELEASE_ID=<commit sha>`, so the site is open and the nonce is
 * genuinely release-derived rather than the per-process fallback.
 *
 * Anonymous on purpose except where a case says otherwise: a stored page is one
 * copy served to everyone, and the anonymous visitor is who it is stored for.
 */

/** A seeded CMS page served by the `(website)/[...slug]` catch-all. */
const CMS_PAGE = "/about";

/**
 * One named directive out of the response's policy.
 *
 * Assertions here MUST go through this rather than matching against the whole
 * header, and the slice-1 review is why: the D1 tightening drops Stripe from
 * `script-src` ONLY, and `https://js.stripe.com` is still legitimately present in
 * `connect-src` and `frame-src`. A whole-header `not.toContain` therefore fails on
 * a correct policy — and, worse, would not have caught Stripe coming BACK into
 * `script-src`, which is the property the test claims to hold. The same trap
 * applies to `'unsafe-inline'`, which `style-src` carries on every route.
 */
function directive(response: APIResponse, name: string): string {
  const policy = response.headers()["content-security-policy"];
  expect(policy, "every response must carry a CSP").toBeTruthy();

  const found = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  expect(found, `the policy must carry a ${name}`).toBeTruthy();

  return found as string;
}

function scriptSrcNonce(response: APIResponse): string {
  const nonce = directive(response, "script-src").match(/'nonce-([^']+)'/)?.[1];
  expect(nonce, "script-src must name a nonce").toBeTruthy();
  return nonce as string;
}

/** Every inline `<script>` open tag in `html` that carries no non-empty nonce. */
function unnoncedInlineScripts(html: string): string[] {
  const offenders: string[] = [];

  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attributes = match[1];
    if (/\bsrc\s*=/i.test(attributes)) continue;
    if (/\btype\s*=\s*["']?application\/(?:ld\+)?json/i.test(attributes)) continue;
    if (/\bnonce\s*=\s*(?:"[^"]+"|'[^']+'|[^\s"'>]+)/i.test(attributes)) continue;
    offenders.push(match[0]);
  }

  return offenders;
}

test("a CMS page is served with the SAME script nonce on every request", async ({
  request,
}) => {
  const first = await request.get(CMS_PAGE);
  const second = await request.get(CMS_PAGE);

  expect(first.status()).toBe(200);
  expect(second.status()).toBe(200);

  const nonce = scriptSrcNonce(first);
  expect(
    scriptSrcNonce(second),
    "a stored page can carry only one nonce, so the policy must not change between responses",
  ).toBe(nonce);
});

test("every inline script in the stored page carries the nonce the policy names", async ({
  request,
}) => {
  // The "zero CSP violations" half of the measurement gate, asserted rather than
  // eyeballed in a console. A mismatch here is a page that never hydrates.
  const response = await request.get(CMS_PAGE);
  const html = await response.text();
  const nonce = scriptSrcNonce(response);

  expect(unnoncedInlineScripts(html)).toEqual([]);
  expect(
    html.includes(`nonce="${nonce}"`),
    "the nonce stamped into the HTML must be the one the policy allows",
  ).toBe(true);
});

/**
 * F1 (#2352 reconciliation, highest severity).
 *
 * `Purpose: prefetch` and `Next-Router-Prefetch` are ordinary request headers
 * anyone can set. The proxy matcher used to skip them, which under full-route ISR
 * would mean a prefetch-shaped miss GENERATING and STORING a page with no nonce
 * stamped in — and that copy then being served to every later visitor under the
 * nonce-only policy, so nothing on the page would execute. #2404 removed the
 * exemption; this is the assertion that keeps it removed, on the wire.
 */
for (const [label, headers] of [
  ["Purpose: prefetch", { Purpose: "prefetch" }],
  ["Next-Router-Prefetch", { "Next-Router-Prefetch": "1" }],
  ["Sec-Purpose: prefetch", { "Sec-Purpose": "prefetch" }],
] as const) {
  test(`a ${label} request stores a fully nonced page`, async ({ request }) => {
    const prefetched = await request.get(`${CMS_PAGE}?prefetch-probe=${Date.now()}`, {
      headers,
    });

    expect(prefetched.status(), `${label} must reach the app, not be skipped`).toBe(
      200,
    );

    const nonce = scriptSrcNonce(prefetched);
    const html = await prefetched.text();

    expect(
      unnoncedInlineScripts(html),
      "a prefetch-shaped request must not produce a nonce-less page",
    ).toEqual([]);
    expect(html.includes(`nonce="${nonce}"`)).toBe(true);

    // And an ordinary request for the same address gets the same nonce, so a
    // page stored by a prefetch is still usable by everyone else.
    const ordinary = await request.get(CMS_PAGE);
    expect(scriptSrcNonce(ordinary)).toBe(nonce);
  });
}

test("Stripe is dropped from script-src on the public website and kept elsewhere", async ({
  request,
}) => {
  // The tightening bundled with D1's trade. `/login` is a `(public)` route, so it
  // keeps a per-request nonce and the unchanged policy.
  const website = await request.get(CMS_PAGE);
  const login = await request.get("/login");

  expect(directive(website, "script-src")).not.toContain("https://js.stripe.com");
  expect(directive(login, "script-src")).toContain("https://js.stripe.com");
  // Stripe stays where it was never the point: the payment surfaces reach
  // api.stripe.com and frame js.stripe.com, and D1 did not touch either.
  expect(directive(website, "connect-src")).toContain("https://api.stripe.com");
  expect(directive(website, "frame-src")).toContain("https://js.stripe.com");
  // Google Tag Manager stays in script-src — the analytics module loads gtag from
  // it on exactly these pages.
  expect(directive(website, "script-src")).toContain(
    "https://www.googletagmanager.com",
  );
  // And the public website may not reach for the blunt option the owner rejected.
  expect(directive(website, "script-src")).not.toContain("'unsafe-inline'");
});

test("a stored CMS page is never offered to a shared cache", async ({ request }) => {
  // The #2322 invariant, asserted where slice 1 moved it (slice-1 review).
  // `export const revalidate = 300` makes Next fill in
  // `s-maxage=300, stale-while-revalidate=31535700` of its own accord
  // (`server/lib/cache-control.js` + the 31536000 `expireTime` default), which is
  // precisely the directive #2322 exists to keep off public pages: a shared cache
  // would store the page and could then serve it stale for the best part of a
  // year, where `revalidatePublicSite()` cannot reach it. The unit suite asserts
  // the proxy's own header; only a real server shows which header survives to the
  // wire, because the framework writes its own when the proxy has not.
  const response = await request.get(CMS_PAGE);
  const cacheControl = response.headers()["cache-control"] ?? "";

  expect(cacheControl, "a CMS page must carry a Cache-Control").toBeTruthy();
  expect(cacheControl).toContain("private");
  expect(cacheControl).not.toContain("s-maxage");
  expect(cacheControl).not.toContain("stale-while-revalidate");
});

test("an anonymous visitor gets the signed-out header on a stored page", async ({
  page,
}) => {
  await page.goto(CMS_PAGE);

  await expect(page.getByRole("link", { name: "Log In" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Dashboard" })).toHaveCount(0);
});

test("a stored page loads in a browser with no CSP or hydration complaint", async ({
  page,
}) => {
  // The "zero CSP violations in the console" half of the #2352 measurement gate,
  // asserted in a real browser rather than eyeballed — and the same run covers
  // hydration, because both replacements for the layout's request reads could fail
  // here and nowhere else:
  //  • a blocked inline script means the fixed nonce and the stored HTML disagree,
  //    and the page never becomes interactive;
  //  • a hydration mismatch would mean a client component rendered one thing during
  //    generation and another in the browser — the footer's `data-page-slug`, which
  //    now comes from `usePathname()` instead of a request header, is the one to
  //    watch.
  // Filtered to those two classes on purpose: a broad "no console errors" assertion
  // would fail on unrelated noise and get deleted rather than fixed.
  const complaints: string[] = [];
  const WATCHED = [
    "content security policy",
    "refused to execute",
    "refused to load",
    "hydration",
    "hydrating",
  ];

  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const text = message.text();
    if (WATCHED.some((needle) => text.toLowerCase().includes(needle))) {
      complaints.push(text);
    }
  });

  await page.goto(CMS_PAGE);
  // The CTA is rendered by a client component reading the marker cookie, so it
  // being visible means React has hydrated and any mismatch has been reported.
  await expect(page.getByRole("link", { name: "Log In" }).first()).toBeVisible();

  expect(complaints).toEqual([]);
  // And the footer's slug came out as the real address, not the "home" fallback
  // `usePathname()` returns with no router context.
  await expect(page.locator("footer[data-page-slug]")).toHaveAttribute(
    "data-page-slug",
    CMS_PAGE.replace(/^\//, ""),
  );
});

test.describe("signed in", () => {
  test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

  test("the header corrects itself in the browser from the marker cookie", async ({
    page,
  }) => {
    // #2352 D2. The page itself is the same stored copy the anonymous visitor
    // above was served — the server no longer knows who is asking — so this only
    // passes if the marker cookie and the client-side swap both work.
    await page.goto(CMS_PAGE);

    await expect(page.getByRole("link", { name: "Dashboard" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Log In" })).toHaveCount(0);

    const hint = (await page.context().cookies()).find(
      (cookie) => cookie.name === "signed-in-hint",
    );
    expect(hint?.value).toBe("1");
    // A display hint, not a session: readable by the page, and carrying one bit.
    expect(hint?.httpOnly).toBe(false);
  });
});

test.describe("a slug under another route group's prefix", () => {
  test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

  /**
   * F1 (slice-1 review). `(website)/[...slug]` claims every URL no other route
   * claims, which is WIDER than the set the proxy gives the fixed per-release nonce
   * to — so a page served in the difference would be STORED carrying a per-request
   * nonce that no later response names, and every inline script on it would be
   * refused. `/pay` is the live shape: `pay` was reserved nowhere, and `(public)/pay`
   * holds only `[token]/`, so the bare path fell through to the catch-all.
   */
  test("is refused at the write, and the address is a plain 404", async ({
    request,
  }) => {
    const created = await request.post("/api/admin/page-content", {
      data: {
        slug: "pay",
        caption: "How to pay",
        menuTitle: "",
        title: "How to pay",
        headerText: "",
        sortOrder: 9100,
      },
    });

    expect(
      created.status(),
      "a slug under another route group's prefix must be refused at the write",
    ).toBe(400);
    expect(((await created.json()) as { error: string }).error).toContain(
      "reserved",
    );

    // And the address itself answers a plain miss rather than a page nobody can use.
    expect((await request.get("/pay")).status()).toBe(404);
  });
});

/**
 * The D1 narrowing (owner decision, 3 Aug 2026): the fixed per-release nonce covers
 * exactly the five approved routes, and the three public pages the first cut swept
 * in are back on a freshly minted per-request nonce.
 *
 * Only a real server can show this. The unit suite proves the PROXY publishes two
 * different nonces for the two territories; what has to hold is that each RENDER
 * stamps the value its own response's policy names — the proxy's header and Next's
 * stamping are separate mechanisms, and a mismatch means every inline script on the
 * page is refused and the page never becomes interactive.
 */
test.describe("the per-request public pages (#2352 D1 narrowing)", () => {
  /**
   * `/hut-leader-instructions` with no `?a=`: PIN-gated and per-assignment, so it is
   * `force-dynamic` for a permanent reason and shows a form rather than any
   * assignment. That is enough for every assertion here, all of which are about the
   * nonce and the shared chrome rather than the page's own content.
   */
  const PER_REQUEST_PAGE = "/hut-leader-instructions";

  test("gets a FRESH nonce on every request, and the HTML matches its own", async ({
    request,
  }) => {
    const first = await request.get(PER_REQUEST_PAGE);
    const second = await request.get(PER_REQUEST_PAGE);

    expect(first.status()).toBe(200);
    expect(second.status()).toBe(200);

    const firstNonce = scriptSrcNonce(first);
    const secondNonce = scriptSrcNonce(second);

    expect(
      secondNonce,
      "a page that is never stored must mint a nonce per response — that unguessable " +
        "value is the defence the five approved routes give up, and this page gives " +
        "up nothing",
    ).not.toBe(firstNonce);

    // Each response's own HTML carries its own value, and no inline script is left
    // unnonced. Both halves matter: equal-but-absent would also pass a looser check.
    for (const [response, nonce] of [
      [first, firstNonce],
      [second, secondNonce],
    ] as const) {
      const html = await response.text();
      expect(unnoncedInlineScripts(html)).toEqual([]);
      expect(
        html.includes(`nonce="${nonce}"`),
        "the nonce stamped into the HTML must be the one this response's policy allows",
      ).toBe(true);
    }
  });

  test("is not served the release nonce that a stored CMS page carries", async ({
    request,
  }) => {
    // The narrowing from both sides in one case. `/about` is stored and carries the
    // release value; this page must not, or the move would be cosmetic.
    const stored = await request.get(CMS_PAGE);
    const perRequest = await request.get(PER_REQUEST_PAGE);

    expect(scriptSrcNonce(perRequest)).not.toBe(scriptSrcNonce(stored));
  });

  test("still gets the tightened public-website policy", async ({ request }) => {
    // The deliberate asymmetry: the Stripe tightening follows the WIDE predicate, so
    // narrowing the NONCE must not have handed this page a looser policy as a side
    // effect. Stripe.js is loaded only from the member payment surfaces.
    const response = await request.get(PER_REQUEST_PAGE);

    expect(directive(response, "script-src")).not.toContain("https://js.stripe.com");
    expect(directive(response, "script-src")).not.toContain("'unsafe-inline'");
  });

  test("loads in a browser with no CSP or hydration complaint", async ({ page }) => {
    // The property the split exists to protect, in the only place it can fail: a
    // per-request nonce that the render did not receive would block every inline
    // script here and the page would never hydrate. Watched classes only — a broad
    // "no console errors" assertion fails on unrelated noise and gets deleted rather
    // than fixed.
    const complaints: string[] = [];
    const WATCHED = [
      "content security policy",
      "refused to execute",
      "refused to load",
      "hydration",
      "hydrating",
    ];

    page.on("console", (message) => {
      if (message.type() !== "error" && message.type() !== "warning") return;
      const text = message.text();
      if (WATCHED.some((needle) => text.toLowerCase().includes(needle))) {
        complaints.push(text);
      }
    });

    await page.goto(PER_REQUEST_PAGE);
    // Rendered by the shared chrome's client component reading the marker cookie, so
    // it being visible means React hydrated and any mismatch has been reported.
    await expect(page.getByRole("link", { name: "Log In" }).first()).toBeVisible();

    expect(complaints).toEqual([]);
    // And the chrome really is the SAME chrome: the footer's slug comes from
    // `usePathname()` in the shared component, so a per-group copy would show here.
    await expect(page.locator("footer[data-page-slug]")).toHaveAttribute(
      "data-page-slug",
      PER_REQUEST_PAGE.replace(/^\//, ""),
    );
  });
});

/**
 * Percent-encoded addresses, which is the ONE half of the nonce split no unit test
 * can see (slice-1 security re-review).
 *
 * The re-review reported the classifier's raw segment comparison as a high-severity
 * bypass, on the premise that Next resolves routes from the decoded path — encode one
 * character of `/hut-leader-instructions` or `/dashboard` and, the argument went, the
 * page would be served under the publicly readable release nonce. The premise is
 * false: a static route matches by exact string equality against the RAW pathname and
 * a dynamic route matches its regex against the raw pathname, so the classifier and
 * the route table already agree. Measured on a container build of this branch before
 * the refutation was accepted — `/hut-leader-instruction%73` answered 404 with the ISR
 * headers only the catch-all sets, and both requests named the same nonce as the HTML
 * carried — and these are the cases that keep it honest: a unit test can only ask the
 * predicate what it thinks, while these ask the server what it serves.
 *
 * They fail in both directions, which is the point: decoding inside the classifier
 * (the "fix" the finding proposed) would break the consistency case below, and Next
 * changing its resolution in a future upgrade would break the route-table case.
 */
test.describe("percent-encoded public addresses", () => {
  test("an encoded per-request address is catch-all territory, and stays consistent", async ({
    request,
  }) => {
    const encoded = "/hut-leader-instruction%73";

    // The route-table half. `/hut-leader-instructions` is a real page; its encoded
    // form is claimed by no static route, so the catch-all serves it, refuses the
    // slug and 404s. Anything but 404 here means Next started resolving encoded
    // paths to static routes and the classifier has to follow.
    const first = await request.get(encoded);
    expect(first.status()).toBe(404);
    expect((await request.get("/hut-leader-instructions")).status()).toBe(200);

    // The consequence, and the reason the classifier must NOT decode: an address the
    // catch-all serves is stored, so it needs the one nonce the policy keeps naming.
    // Handing it a fresh nonce per request — which is what decoding would do — leaves
    // the second visitor a stored document whose scripts the new policy refuses.
    const second = await request.get(encoded);
    const nonce = scriptSrcNonce(first);

    expect(scriptSrcNonce(second)).toBe(nonce);
    expect(nonce).toBe(scriptSrcNonce(await request.get(CMS_PAGE)));

    const html = await second.text();
    expect(unnoncedInlineScripts(html)).toEqual([]);
    expect(
      html.includes(`nonce="${nonce}"`),
      "the stored document's nonce must still be the one this response's policy allows",
    ).toBe(true);
  });

  test("an encoded /join/apply is the group-join page, not the apply page", async ({
    request,
  }) => {
    // The mirror direction, and the one that matters most for security: a DYNAMIC
    // route matches the raw path, so `/join/appl%79` is `(website-dynamic)/join/[code]`
    // with code `apply`. Decoding in the classifier would have called this address
    // one of the approved five and served a genuinely per-request page under the
    // fixed, publicly readable nonce.
    const canonical = await request.get("/join/apply");
    expect(canonical.status()).toBe(200);

    // Read the heading off the page itself rather than hardcoding it: an admin-authored
    // `join/apply` row overrides the code default, and the assertion is about which
    // ROUTE answered, not about the copy.
    const heading = /<h1[^>]*>([^<]+)<\/h1>/.exec(await canonical.text())?.[1];
    expect(heading, "the apply page must render an h1 to compare against").toBeTruthy();

    expect(await (await request.get("/join/appl%79")).text()).not.toContain(
      heading as string,
    );
  });
});

/**
 * The #2570 residual, pinned at the properties that must hold rather than at the
 * fault — and with the fault's SEVERITY corrected by measurement.
 *
 * A mistyped member-area address is claimed by the CMS catch-all, which refuses it
 * (it is outside the fixed-nonce set) and raises a 404 — and that 404 DOCUMENT is
 * stored, so a later visitor is served a copy whose baked-in nonce the new policy no
 * longer names and whose inline scripts are therefore refused. Measured on a
 * container build of this branch: two requests for `/admin/typo` both answered 404,
 * the second with a fresh policy nonce while the HTML still carried the first
 * request's value.
 *
 * **The severity is worse than the briefing that produced the decision said, and the
 * measurement is why.** A `notFound()` response from this route has ZERO
 * server-rendered visible markup: `<body>` is an empty placeholder and the whole 404
 * screen arrives inside the RSC flight payload, which is carried in nonce'd inline
 * `<script>` tags (measured: 0 visible characters outside `<script>` on
 * `/admin/typo`, `/dashboard/nope` AND the in-territory `/definitely-missing`, versus
 * ~3.7k on `/contact`). So the refused-script outcome is a BLANK page, not the
 * readable-but-inert page the owner was told about. The in-territory miss is
 * unaffected because it carries the fixed nonce and the policy keeps naming it.
 *
 * The owner chose to stop storing those documents (option 2, 3 Aug). Next's
 * per-render cache opt-out answers 500 on next@16.2.12, and a proxy rewrite cannot
 * substitute for it because middleware runs before routing and cannot tell a typo
 * from a real member address. So the decision is back with the owner, and these cases
 * assert only what is TRUE and must stay true: a proper 404 on both requests (no
 * 500 — the outcome option 2's own terms said to drop the change for), the club's own
 * 404 content present in the document, and a per-request nonce rather than the
 * release value. The mismatch itself is deliberately NOT asserted: a test that pins a
 * fault fails the day the fault is fixed.
 */
test.describe("a mistyped member-area address", () => {
  for (const address of ["/dashboard/nope", "/admin/typo"]) {
    test(`answers a proper 404 twice in a row at ${address}`, async ({ request }) => {
      const first = await request.get(address);
      const second = await request.get(address);

      expect(first.status(), "a mistyped address must never 500").toBe(404);
      expect(second.status(), "including when served from the store").toBe(404);

      // The club's own 404 screen, not Next's built-in one: `src/app/not-found.tsx`
      // renders the admin-authored `/404` page content, or its hardcoded fallback.
      expect(await second.text()).toContain("Page Not Found");

      // A per-request nonce, not the release value — these addresses belong to
      // another route group and the narrowing did not change that.
      expect(scriptSrcNonce(second)).not.toBe(
        scriptSrcNonce(await request.get(CMS_PAGE)),
      );
    });
  }
});

/**
 * The headers those same stored 404s left with (#2578), on a real server because that
 * is the only place the question can be answered.
 *
 * The unit suite asserts what the PROXY writes. What reaches the wire is decided by
 * Next: it writes its own `Cache-Control` only when the response does not already carry
 * one (`send-payload.js`), so a proxy that skips a path hands the framework's value to
 * the visitor — which is exactly how these three URLs came to ship
 * `s-maxage=15, stale-while-revalidate=31535985` with no `Vary`. Measured on a
 * container build of slice 1; the pre-slice-1 baseline answered `private, no-cache,
 * no-store` on all four of the addresses the issue named. `/API/x.png` is the fifth,
 * added by the review of this fix rather than by the issue — see the list.
 *
 * `/pay`, `/dashboard/nope` and `/admin/typo` are outside the public-website territory
 * and are served from the page store anyway, because the CMS catch-all claims every URL
 * no other route claims. `/definitely-missing` is the in-territory control that was
 * always correct — it is what showed the fault was keyed on territory rather than being
 * a general 404 problem, and a regression that broke both would otherwise look like a
 * broken test rather than a broken invariant.
 *
 * The cookie half is driven with a stale `signed-in-hint` on an ANONYMOUS request, which
 * makes the proxy clear it: a real `Set-Cookie` on a response any visitor can provoke,
 * which is what makes the combination reachable by a shared cache at all.
 */
test.describe("out-of-territory 404 cache headers", () => {
  const MEASURED = [
    "/pay",
    "/dashboard/nope",
    "/admin/typo",
    // The in-territory control.
    "/definitely-missing",
    // Asset-shaped under an odd-cased `/API/` prefix, added by the review of this fix
    // and failing before it: no `afterFiles` rewrite claims it (the `(?!api/)`
    // lookahead compiles case-insensitively), no handler claims it (Next's route table
    // is case-sensitive), so the CMS catch-all answers it from the page store like any
    // other missing address. `/API/…` is ordinary scanner vocabulary over an unbounded
    // URL space, which is what made this the one shape worth measuring on the wire
    // rather than only in the unit matrix.
    "/API/x.png",
  ];

  for (const address of MEASURED) {
    test(`${address} is never offered to a shared cache`, async ({ request }) => {
      // Twice, because the first request GENERATES and the second is served from the
      // store — and it was the stored answer that carried the directive.
      await request.get(address);
      const second = await request.get(address);
      const cacheControl = second.headers()["cache-control"] ?? "";

      expect(second.status(), "still a proper 404").toBe(404);
      expect(cacheControl, "every one of these must carry a directive").toBeTruthy();
      expect(cacheControl).toContain("private");
      expect(cacheControl).toContain("no-store");
      expect(cacheControl).not.toContain("s-maxage");
      expect(cacheControl).not.toContain("stale-while-revalidate");
    });

    test(`${address} never pairs a Set-Cookie with a shared-cache directive`, async ({
      request,
    }) => {
      const response = await request.get(address, {
        headers: { cookie: "signed-in-hint=1" },
      });
      const cacheControl = response.headers()["cache-control"] ?? "";
      const setCookie = response.headers()["set-cookie"] ?? "";

      // The premise of the case: if the proxy stopped correcting the stale hint here,
      // the assertion below would pass for the wrong reason.
      expect(setCookie, "the stale hint must be corrected on this response").toContain(
        "signed-in-hint",
      );
      expect(cacheControl).not.toContain("s-maxage");
      expect(cacheControl).not.toContain("public");
      expect(cacheControl).toContain("private");
    });
  }

  test("a real asset keeps its own caching and carries no marker cookie", async ({
    request,
  }) => {
    // The shape deliberately left OUT of the override: a file the filesystem serves
    // cannot come from the page store, so there is no shared-cache directive to strip
    // — and overriding would cost the club logo its browser caching on every public
    // page view. The cookie is withheld instead, so nothing pairs a `Set-Cookie` with
    // whatever directive that layer chose.
    // The same real file `asset-url-404.spec.ts` uses: `public/branding/*` ships
    // `.example` names, and a request for one is served by the filesystem.
    const response = await request.get("/branding/favicon.example.ico", {
      headers: { cookie: "signed-in-hint=1" },
    });
    const cacheControl = response.headers()["cache-control"] ?? "";

    expect(response.status(), "the shipped branding asset must exist").toBe(200);
    expect(response.headers()["set-cookie"] ?? "").not.toContain("signed-in-hint");
    // The half of this case's name that is about CACHING, which the first cut asserted
    // nowhere: the unit matrix proves the proxy writes nothing here, and only a real
    // server can show that what reaches the wire is the filesystem layer's own value
    // rather than `no-store`. This is the promise the changelog makes to operators —
    // "the club logo and other shipped images keep their normal browser caching" — so
    // a later change that dropped the asset arm out of the predicate for the header
    // while leaving the cookie alone would be caught here.
    expect(cacheControl, "the filesystem layer's own directive must survive").not.toContain(
      "no-store",
    );
    // Deliberately not pinning the exact value: it belongs to whichever layer serves
    // the file (`send`'s set-if-absent value for `public/`, or an operator's own front
    // door), and this fix's promise is only that the proxy does not replace it with
    // `no-store`. `s-maxage` is not asserted against either — an image is the same
    // bytes for everyone and this case already proves no `Set-Cookie` rides with it,
    // so an operator caching it in front of the app is their choice, not this hazard.
  });
});

/**
 * F4, and the verification of `revalidatePublicSite()` the reconciliation asked
 * for (#2352 F3).
 *
 * Hiding a page has to take effect at once. If `revalidatePath("/", "layout")` did
 * not clear the full-route store, the unpublished page would keep answering 200
 * from it for up to the 300-second backstop — so a passing assertion here IS the
 * evidence that the call clears stored pages and not merely the tagged data caches.
 */
test.describe("unpublishing a CMS page", () => {
  test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

  /**
   * The probe page this case hides, created rather than borrowed.
   *
   * It cannot be one of the seeded pages: `canUnpublishPage()`
   * (`src/lib/page-content.ts`) refuses to hide a system or built-in slug —
   * `about`, `join`, `rules`, `contact`, `committee`, `privacy`, `terms`, `faq` —
   * because code routes, the footer and the sitemap link them, so the admin PATCH
   * answers 422 for every one of them. An admin-CREATED page is the only kind the
   * product allows hiding, which is also the case an operator actually meets.
   *
   * `menuTitle` is empty on purpose: `listWebsiteMenuPages()` drops a page with no
   * menu title, so the probe never appears in the public navigation and no other
   * spec's expectations move. It is left hidden at the end for the same reason.
   */
  const PROBE_SLUG = "e2e-isr-unpublish-probe";
  const PROBE_PATH = `/${PROBE_SLUG}`;

  async function probePageId(request: APIRequestContext): Promise<string> {
    const created = await request.post("/api/admin/page-content", {
      data: {
        slug: PROBE_SLUG,
        caption: "ISR probe",
        menuTitle: "",
        title: "ISR probe",
        headerText: "",
        sortOrder: 9000,
      },
    });

    if (created.status() === 201) {
      return ((await created.json()) as { page: { id: string } }).page.id;
    }

    // 409: a previous run left it behind — this case deliberately leaves its
    // probe HIDDEN rather than deleting it, so the site is as it found it and no
    // other spec's menu expectations move. Reuse it.
    expect(
      created.status(),
      "the probe page must be creatable or already present",
    ).toBe(409);

    const listed = await request.get("/api/admin/page-content");
    expect(listed.status()).toBe(200);
    const { pages } = (await listed.json()) as {
      pages: Array<{ id: string; path: string }>;
    };
    const existing = pages.find((candidate) => candidate.path === PROBE_PATH);
    expect(existing, `${PROBE_PATH} must exist after a 409`).toBeTruthy();
    return existing!.id;
  }

  async function setPublished(
    request: APIRequestContext,
    id: string,
    published: boolean,
  ) {
    const response = await request.patch("/api/admin/page-content", {
      data: { id, published },
    });
    expect(response.status()).toBe(200);
  }

  test("clears the stored page immediately, and republishing restores it", async ({
    request,
  }) => {
    const id = await probePageId(request);

    try {
      // Published on create (`PageContent.published` defaults true), so this both
      // warms the store and shows on-demand generation working for an address
      // that did not exist when the release was built — the whole point of
      // `generateStaticParams()` returning an empty list.
      await setPublished(request, id, true);
      expect((await request.get(PROBE_PATH)).status()).toBe(200);

      await setPublished(request, id, false);
      expect(
        (await request.get(PROBE_PATH)).status(),
        "a hidden page must 404 at once — a 200 here means the stored copy outlived the write",
      ).toBe(404);

      await setPublished(request, id, true);
      expect(
        (await request.get(PROBE_PATH)).status(),
        "republishing must restore it just as immediately",
      ).toBe(200);
    } finally {
      // Leave the site as this spec found it.
      await setPublished(request, id, false);
    }
  });
});

/**
 * Deleting a CMS page (#2352 MC-03D).
 *
 * The counterpart to the unpublish case above, and the reason it is a separate
 * one rather than an extra assertion there: unpublish proves the stored copy is
 * cleared when a page is HIDDEN, and deletion is the lifecycle step that had no
 * supported writer at all until MC-03D. The failure mode is the same and it is
 * the whole point of the case — a 200 on the request immediately after the
 * delete means the stored copy outlived the write, and on a quiet site it would
 * keep answering for hours, because `revalidate = 300` hands a stale entry to
 * the requester before regeneration starts rather than blocking on it.
 *
 * Deliberately with NO sleep anywhere. A sleep would let the 300-second backstop
 * take the credit for what the invalidation call is supposed to do.
 */
test.describe("deleting a CMS page", () => {
  test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

  /**
   * Its own probe, not the unpublish case's: that one is deliberately left behind
   * hidden, and two specs sharing one row would race whichever ran first.
   *
   * `menuTitle` is empty for the same reason it is there — `listWebsiteMenuPages()`
   * drops a page with no menu title, so the probe never enters the public
   * navigation and no other spec's expectations move while it exists.
   */
  const PROBE_SLUG = "e2e-isr-delete-probe";
  const PROBE_PATH = `/${PROBE_SLUG}`;

  async function createProbe(request: APIRequestContext): Promise<string> {
    const created = await request.post("/api/admin/page-content", {
      data: {
        slug: PROBE_SLUG,
        caption: "ISR delete probe",
        menuTitle: "",
        title: "ISR delete probe",
        headerText: "",
        sortOrder: 9001,
      },
    });

    if (created.status() === 201) {
      return ((await created.json()) as { page: { id: string } }).page.id;
    }

    // 409: a previous run failed between creating and deleting. Reuse the row so
    // the case is self-healing rather than blocked.
    expect(
      created.status(),
      "the probe page must be creatable or already present",
    ).toBe(409);

    const listed = await request.get("/api/admin/page-content");
    expect(listed.status()).toBe(200);
    const { pages } = (await listed.json()) as {
      pages: Array<{ id: string; path: string }>;
    };
    const existing = pages.find((candidate) => candidate.path === PROBE_PATH);
    expect(existing, `${PROBE_PATH} must exist after a 409`).toBeTruthy();
    return existing!.id;
  }

  async function deleteProbe(request: APIRequestContext, id: string) {
    return request.delete("/api/admin/page-content", { data: { id } });
  }

  test("clears the stored page immediately, and the address stays a 404", async ({
    request,
  }) => {
    const id = await createProbe(request);
    let deleted = false;

    try {
      // Published on create, so this both warms the store and shows on-demand
      // generation for an address that did not exist when the release was built.
      const warm = await request.get(PROBE_PATH);
      expect(warm.status(), "the probe must be served before it is deleted").toBe(
        200,
      );
      // A second request to prove the first one STORED something, so the 404
      // below is a cleared store and not merely a page that was never cached.
      const warmAgain = await request.get(PROBE_PATH);
      expect(warmAgain.status()).toBe(200);
      expect(
        warmAgain.headers()["x-nextjs-cache"] ?? "",
        "the probe must be answered from the store before it is deleted",
      ).toBe("HIT");

      const removed = await deleteProbe(request, id);
      expect(removed.status(), "the supported delete must succeed").toBe(200);
      deleted = true;
      const removedBody = (await removed.json()) as {
        ok: boolean;
        referencedBySlugs: string[];
        referencedByFooterSections: string[];
        wasBookNowTarget: boolean;
        publicCacheCleared: boolean;
      };
      expect(removedBody.ok).toBe(true);
      expect(removedBody.referencedBySlugs).toEqual([]);
      // The footer's admin-authored link lists are scanned too (first review,
      // finding 3); the starter footer links only built-in pages, so a probe page
      // is genuinely unreferenced there.
      expect(removedBody.referencedByFooterSections).toEqual([]);
      expect(removedBody.wasBookNowTarget).toBe(false);
      // Against a real server the flush really happened, which is what the 404
      // below then proves behaviourally. The flag exists so that a flush failure
      // is reported as "deleted but not flushed" rather than as a failed delete
      // (finding 5) — here it must be true, or the 404 assertion is testing the
      // wrong thing.
      expect(removedBody.publicCacheCleared).toBe(true);

      // The assertion the measurement gate is for. No sleep.
      expect(
        (await request.get(PROBE_PATH)).status(),
        "a deleted page must 404 at once — a 200 here means the stored copy outlived the write",
      ).toBe(404);

      // What a visitor actually gets on the request after that: the 404 itself is
      // stored, which is fine for this address because it is inside the
      // fixed-nonce set and so carries the release nonce.
      expect((await request.get(PROBE_PATH)).status()).toBe(404);

      // Prefetch-shaped, because reconciliation F1 on this issue was exactly a
      // prefetch-shaped request defeating the store/nonce path, and a prefetch
      // served stale skips revalidation entirely.
      const prefetched = await request.get(PROBE_PATH, {
        headers: {
          "Next-Router-Prefetch": "1",
          Purpose: "prefetch",
          "Sec-Purpose": "prefetch",
        },
      });
      expect(
        prefetched.status(),
        "a prefetch-shaped request must not resurrect the deleted page",
      ).toBe(404);

      // The row is genuinely gone rather than hidden: it is absent from the
      // admin list, which reads every row regardless of published state.
      const listed = await request.get("/api/admin/page-content");
      expect(listed.status()).toBe(200);
      const { pages } = (await listed.json()) as {
        pages: Array<{ path: string }>;
      };
      expect(
        pages.map((page) => page.path),
        "the deleted row must be absent from the admin list, not merely unpublished",
      ).not.toContain(PROBE_PATH);

      // Deleting it again is a 404, not a second success — the id is gone.
      expect((await deleteProbe(request, id)).status()).toBe(404);

      // The slug is free immediately (D-B6): recreating is the operator's repair
      // path after a mistyped page, and the create writer invalidates too, so a
      // stored 404 cannot outlive the new page.
      const recreated = await request.post("/api/admin/page-content", {
        data: {
          slug: PROBE_SLUG,
          caption: "ISR delete probe",
          menuTitle: "",
          title: "ISR delete probe",
          headerText: "",
          sortOrder: 9001,
        },
      });
      expect(
        recreated.status(),
        "a hard delete frees the slug, so re-creating it must succeed",
      ).toBe(201);
      const recreatedId = ((await recreated.json()) as {
        page: { id: string };
      }).page.id;
      expect(
        (await request.get(PROBE_PATH)).status(),
        "the recreated page must be served at once — the stored 404 must not outlive it",
      ).toBe(200);
      expect((await deleteProbe(request, recreatedId)).status()).toBe(200);
      expect((await request.get(PROBE_PATH)).status()).toBe(404);
    } finally {
      // Leave the site as this spec found it, whichever assertion failed.
      if (!deleted) {
        await deleteProbe(request, id);
      }
      const listed = await request.get("/api/admin/page-content");
      if (listed.status() === 200) {
        const { pages } = (await listed.json()) as {
          pages: Array<{ id: string; path: string }>;
        };
        const stray = pages.find((page) => page.path === PROBE_PATH);
        if (stray) {
          await deleteProbe(request, stray.id);
        }
      }
    }
  });

  test("refuses to delete a built-in page the site itself links", async ({
    request,
  }) => {
    // The permission predicate is shared with hiding, so this is the delete-side
    // proof that the shared rule is actually enforced on the real server: /about
    // is linked from the footer and read by a code route.
    const listed = await request.get("/api/admin/page-content");
    expect(listed.status()).toBe(200);
    const { pages } = (await listed.json()) as {
      pages: Array<{ id: string; path: string }>;
    };
    const about = pages.find((page) => page.path === "/about");
    expect(about, "the seeded /about page must exist").toBeTruthy();

    const refused = await request.delete("/api/admin/page-content", {
      data: { id: about!.id },
    });

    expect(refused.status()).toBe(422);
    expect((await request.get("/about")).status()).toBe(200);
  });
});
