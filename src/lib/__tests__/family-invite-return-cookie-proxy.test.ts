import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  FAMILY_INVITE_RETURN_COOKIE,
  FAMILY_INVITE_RETURN_MAX_AGE_SECONDS,
  FAMILY_INVITE_RETURN_NONCE_HEADER,
  parseFamilyInviteReturnCookie,
} from "@/lib/family-invite-return-address";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";

/**
 * #2827 — the proxy is what carries the family-invite post-login return address.
 *
 * The invite page's sign-in link is a plain `/login` anchor now, so the address
 * has to travel out of band and it has to survive with JavaScript switched off.
 * A server COMPONENT may not set a cookie during render, and the token only ever
 * reaches the server on a request whose URL contains it — so the response to the
 * invite page's own GET is the carrier, and that response is the proxy's.
 *
 * These cases assert the whole of that: the cookie is written, it carries the
 * exact path, it is `HttpOnly` (which is the entire point — a value on the page
 * would be readable by the script and CSS readers this fix exists to keep it away
 * from), and it is written on the invite page and nowhere else.
 *
 * Two conditions came out of the 20 Aug 2026 review and are pinned here too,
 * because both are behaviour nothing else can see:
 *
 *  - **A signed-in GET RETIRES the address rather than writing it.** The visitor
 *    has arrived, and every one of the four sign-in flows terminates in exactly
 *    this request — which is what makes "cleared on use" true for the Google and
 *    2FA flows, whose server components cannot write a cookie at all.
 *  - **Only a `Sec-Fetch-Dest: document` request writes it.** `SameSite=Lax`
 *    stops a cookie being SENT cross-site, not being STORED from a cross-site
 *    response, so without this an `<img src>` on any page could plant a victim's
 *    post-login landing.
 *
 * A third condition arrived with #2974, and the cases below own it here because
 * this is the only place both halves of it exist at once:
 *
 *  - **The write mints a tab-binding nonce**, stores it in the cookie as
 *    `<nonce>.<path>`, and hands the SAME value to the render in
 *    `FAMILY_INVITE_RETURN_NONCE_HEADER` so the invite page can put it on its
 *    sign-in anchor. Without the header the two halves could never meet: only
 *    middleware can write the cookie, and only the render can write the link.
 *  - **A client's own copy of that header never reaches the render.** It is
 *    deleted on every request before the proxy sets its own.
 *
 * The #2578 pairing is asserted in `csp-proxy.test.ts`, which owns that invariant
 * for both of the proxy's cookie writers.
 */

// Same pins as csp-proxy.test.ts: without a database the setup gate resolves
// "incomplete" and the module gate disables every optional module, and either
// short-circuit would answer these requests before the header block runs.
vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: async () => ({ isComplete: true, css: "" }),
}));

vi.mock("@/lib/module-settings", async (importOriginal) => {
  const original = (await importOriginal()) as typeof import("@/lib/module-settings");
  const { MODULE_KEYS: keys } = await import("@/config/modules");

  return {
    ...original,
    loadEffectiveModuleFlags: async () =>
      Object.fromEntries(keys.map((key) => [key, true])) as FeatureFlags,
  };
});

import proxy from "../../proxy";

const TOKEN =
  "e7c1b93a5d0f4826" + "1af74c02be95d738" + "6b0d2e8149a3fc57" + "d4938e6017c2ba5f";

const INVITE_PATH = `/family-invite/${TOKEN}`;

function returnCookies(headers: Headers): string[] {
  return headers
    .getSetCookie()
    .filter((value) => value.startsWith(`${FAMILY_INVITE_RETURN_COOKIE}=`));
}

/** The `<nonce>.<path>` pair a written cookie carries, or null. */
function returnCookiePair(headers: Headers) {
  const [cookie] = returnCookies(headers);

  if (!cookie) return null;

  const value = cookie.slice(
    `${FAMILY_INVITE_RETURN_COOKIE}=`.length,
    cookie.indexOf(";"),
  );

  return parseFamilyInviteReturnCookie(value);
}

/** The tab-binding nonce the proxy forwarded to the render, or null. */
function forwardedNonce(headers: Headers) {
  return headers.get(`x-middleware-request-${FAMILY_INVITE_RETURN_NONCE_HEADER}`);
}

// The init type is taken from the constructor rather than written as the DOM's
// `RequestInit`: Next's own is narrower (its `signal` may not be null), so the
// global one does not type-check here.
type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

/**
 * A request as a BROWSER makes it when the visitor navigates to a page: every
 * modern engine sets these, and script cannot forge them (they are on the
 * forbidden-header list). `document` is the value only a top-level navigation
 * gets — an `<iframe>` reports `iframe`, an `<img>` reports `image` — which is
 * what the stamp condition turns on. Written as the DEFAULT here so every case
 * below reads as the real flow, and the cases that drop or change it are visibly
 * the exceptions.
 */
const NAVIGATION_HEADERS = {
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
} as const;

async function get(path: string, init?: NextRequestInit) {
  return proxy(
    new NextRequest(`https://example.org${path}`, {
      ...init,
      headers: { ...NAVIGATION_HEADERS, ...(init?.headers as Record<string, string>) },
    }),
  );
}

/** The same request with no `Sec-Fetch-*` headers at all, or with other values. */
async function getRaw(path: string, init?: NextRequestInit) {
  return proxy(new NextRequest(`https://example.org${path}`, init));
}

beforeEach(() => {
  // Not vacuous: every module on, so no gate answers ahead of the header block.
  expect(MODULE_KEYS.length).toBeGreaterThan(0);
});

describe("proxy family-invite return address (#2827, #2974)", () => {
  it("stamps the exact invite path on a GET of the invite page", async () => {
    const response = await get(INVITE_PATH);
    const [cookie, ...rest] = returnCookies(response.headers);

    expect(cookie, "the invite page must carry a return address").toBeTruthy();
    expect(rest, "one cookie, not several").toEqual([]);
    expect(returnCookiePair(response.headers)?.path).toBe(INVITE_PATH);
  });

  it("writes it HttpOnly, SameSite=Lax, path-wide and short-lived", async () => {
    const [cookie] = returnCookies((await get(INVITE_PATH)).headers);

    // HttpOnly is the property the whole rework rests on. Without it the token
    // would be readable from `document.cookie`, which is a wider exposure than
    // the href this replaced.
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${FAMILY_INVITE_RETURN_MAX_AGE_SECONDS}`);
  });

  /**
   * #2974 — THE TAB BINDING, at the only point where both of its halves exist.
   *
   * A cookie is per-browser. Before this, somebody who opened an invitation on a
   * shared kiosk and walked away without signing in handed the next person to
   * sign in that landing, with the invited email address and the family-group
   * name on it. The nonce is what makes the address belong to the tab instead:
   * the render puts it on the sign-in anchor, and a landing site honours the
   * cookie only for a request that presents it.
   */
  it("mints a tab-binding nonce and stores it in the cookie", async () => {
    const pair = returnCookiePair((await get(INVITE_PATH)).headers);

    expect(pair, "the cookie must parse as <nonce>.<path>").not.toBeNull();
    expect(pair?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(pair?.path).toBe(INVITE_PATH);
  });

  it("hands the render the SAME nonce it put in the cookie", async () => {
    // Without this the two halves could never meet: only middleware can write the
    // cookie, and only the render can write the link the nonce has to travel on.
    const response = await get(INVITE_PATH);

    expect(forwardedNonce(response.headers)).toBe(
      returnCookiePair(response.headers)?.nonce,
    );
  });

  it("mints a FRESH nonce per navigation, and never one derived from the token", async () => {
    const first = returnCookiePair((await get(INVITE_PATH)).headers)?.nonce;
    const second = returnCookiePair((await get(INVITE_PATH)).headers)?.nonce;

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second, "two navigations must not share a nonce").not.toBe(first);
    // A nonce derived from the token would turn the anchor back into a token
    // oracle, which is the class #2827 exists to close.
    expect(TOKEN).not.toContain(first);
    expect(first).not.toContain(TOKEN.slice(0, 8));
  });

  it("never lets a CLIENT's own copy of the nonce header reach the render", async () => {
    // `new Headers(request.headers)` copies whatever the visitor sent, so the
    // proxy deletes this header on every request before setting its own. A forged
    // nonce would match no cookie, so this is belt-and-braces — but a header that
    // is a message FROM the proxy must never be writable by the caller.
    const planted = "ffffffffffffffffffffffffffffffff";

    const onInvite = await get(INVITE_PATH, {
      headers: { [FAMILY_INVITE_RETURN_NONCE_HEADER]: planted },
    });

    expect(forwardedNonce(onInvite.headers)).not.toBe(planted);
    expect(forwardedNonce(onInvite.headers)).toBe(
      returnCookiePair(onInvite.headers)?.nonce,
    );

    for (const path of ["/", "/login", "/dashboard", `/pay/${TOKEN}`]) {
      const response = await get(path, {
        headers: { [FAMILY_INVITE_RETURN_NONCE_HEADER]: planted },
      });

      expect(forwardedNonce(response.headers), path).toBeNull();
    }
  });

  it("forwards no nonce on a request that writes no address", async () => {
    // A signed-in visitor is retiring the address, and a non-navigation writes
    // nothing at all: in neither case is there a live nonce for a render to use.
    const signedIn = await get(INVITE_PATH, {
      headers: { cookie: "authjs.session-token=abc" },
    });
    const subresource = await getRaw(INVITE_PATH, {
      headers: { "sec-fetch-dest": "image" },
    });

    expect(forwardedNonce(signedIn.headers)).toBeNull();
    expect(forwardedNonce(subresource.headers)).toBeNull();
  });

  it("RETIRES the address for a signed-in visitor, who has arrived", async () => {
    // The whole of "cleared on use". The first cut wrote it here too, and left the
    // clearing to /api/auth/post-login-landing — but that route's answer IS a
    // redirect to this page, so the GET it authorised restored the value it had
    // just cleared, and the Google and 2FA flows never call that route at all.
    // Measured consequence on a shared browser: the next person to sign in within
    // ten minutes landed on the previous visitor's invite page, holding their live
    // token. Every one of the four flows ends in this request, so retiring here is
    // what makes the claim true for all four.
    const response = await get(INVITE_PATH, {
      headers: { cookie: "authjs.session-token=abc" },
    });
    const [cookie, ...rest] = returnCookies(response.headers);

    expect(cookie, "the landing must retire the address").toBeTruthy();
    expect(rest, "one cookie, not several").toEqual([]);
    expect(cookie).toContain(`${FAMILY_INVITE_RETURN_COOKIE}=;`);
    expect(cookie).toContain("Max-Age=0");
    // The same attributes as the write, so a browser holding the original under
    // `Path=/` cannot be left with it.
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain(TOKEN);
  });

  it("retires it whatever the navigation looked like", async () => {
    // Retiring is always the safe direction, so it is deliberately NOT gated on
    // the document-navigation condition below: a session-bearing request that
    // reaches this address clears the value however it got here.
    for (const dest of ["image", "iframe", "empty"]) {
      const response = await getRaw(INVITE_PATH, {
        headers: { cookie: "authjs.session-token=abc", "sec-fetch-dest": dest },
      });

      expect(returnCookies(response.headers), dest).toHaveLength(1);
      expect(returnCookies(response.headers)[0], dest).toContain("Max-Age=0");
    }
  });

  it("refuses to WRITE it on anything but a top-level document navigation", async () => {
    // Cookie planting. `SameSite=Lax` decides whether a cookie is SENT
    // cross-site, not whether a cross-site response may STORE one — so without
    // this condition `<img src="https://club.example/family-invite/<token>">` on
    // an attacker's page pre-positioned a victim's post-login landing with no
    // interaction on the club's site at all. `Sec-Fetch-Dest` is browser-set and
    // unforgeable from script, and only a navigation the visitor can SEE reports
    // `document`.
    for (const dest of ["image", "iframe", "frame", "object", "empty", "script"]) {
      const response = await getRaw(INVITE_PATH, {
        headers: { "sec-fetch-dest": dest, "sec-fetch-mode": "no-cors" },
      });

      expect(returnCookies(response.headers), dest).toEqual([]);
    }
  });

  it("degrades to no address when the browser sends no Sec-Fetch-* at all", async () => {
    // Fail closed, and gracefully: an engine too old to send these headers gets
    // the member's ordinary post-login landing, exactly as an expired cookie does,
    // and the page's own copy already tells the recipient to return to the link
    // once their login is active. Nothing errors, and no token is stored.
    const response = await getRaw(INVITE_PATH);

    expect(returnCookies(response.headers)).toEqual([]);
  });

  it("writes it on a cross-site navigation, which is the ORDINARY path", async () => {
    // Deliberately not narrowed to `Sec-Fetch-Site: same-origin`: the normal way
    // in is a click on an emailed link, which arrives from a webmail page and is
    // therefore `cross-site`. Requiring same-origin would have broken the one
    // flow this feature exists for.
    const response = await getRaw(INVITE_PATH, {
      headers: { ...NAVIGATION_HEADERS, "sec-fetch-site": "cross-site" },
    });

    expect(returnCookies(response.headers)).toHaveLength(1);
    expect(returnCookiePair(response.headers)?.path).toBe(INVITE_PATH);
  });

  it("normalises a trailing slash rather than missing the address", async () => {
    const response = await get(`${INVITE_PATH}/`);

    expect(returnCookiePair(response.headers)?.path).toBe(INVITE_PATH);
  });

  it("ignores a query string, which the address has no use for", async () => {
    const response = await get(`${INVITE_PATH}?utm_source=email`);
    const [cookie] = returnCookies(response.headers);

    expect(returnCookiePair(response.headers)?.path).toBe(INVITE_PATH);
    expect(cookie).not.toContain("utm_source");
  });

  it("writes nothing on any other address", async () => {
    // Deliberately includes the sibling (public) token routes: they render no
    // sign-in link, so a return address for them would be a cookie nobody reads,
    // carrying a bearer credential for no benefit.
    for (const path of [
      "/",
      "/login",
      "/dashboard",
      "/family-invite",
      "/family-invite/",
      `/family-invite/${TOKEN}/extra`,
      `/family-invite/${TOKEN.slice(0, 63)}`,
      `/family-invite/${TOKEN.toUpperCase()}`,
      `/pay/${TOKEN}`,
      `/chores/${TOKEN}`,
      `/membership-cancellation/${TOKEN}`,
      "/api/auth/post-login-landing",
    ]) {
      const response = await get(path);

      expect(returnCookies(response.headers), path).toEqual([]);
    }
  });

  it("writes nothing on any other address for a SIGNED-IN visitor either", async () => {
    // The same addresses again, this time carrying a session — because the RETIRE
    // branch runs before the document-navigation condition and is therefore the one
    // branch a loosened address check would reach on an ordinary page. Found by
    // mutation, 21 Aug 2026: replacing `getFamilyInviteReturnPath()` in the planner
    // with a bare pass-through left every case above green, because the cookie
    // builder refuses a bad path on the WRITE side — while a signed-in member
    // browsing the site collected a `family-invite-return=; Max-Age=0` header on
    // every page view. Harmless in itself, and exactly the kind of drift a guard
    // that no longer discriminates goes on to permit.
    for (const path of ["/", "/login", "/dashboard", `/pay/${TOKEN}`]) {
      const response = await get(path, {
        headers: { cookie: "authjs.session-token=abc" },
      });

      expect(returnCookies(response.headers), path).toEqual([]);
    }
  });

  it("writes nothing on a method that is not GET", async () => {
    for (const method of ["POST", "HEAD", "PUT", "DELETE"]) {
      const response = await get(INVITE_PATH, { method });

      expect(returnCookies(response.headers), method).toEqual([]);
    }
  });

  it("leaves the response cacheable by nobody but the browser", async () => {
    // The #2578 pairing, checked here as well as in csp-proxy.test.ts, because a
    // Set-Cookie carrying a bearer credential beside a shared-cache directive
    // would be strictly worse than the marker cookie that rule was written for.
    const response = await get(INVITE_PATH);
    const directive = response.headers.get("Cache-Control") ?? "";

    expect(returnCookies(response.headers)).toHaveLength(1);
    expect(directive).toContain("private");
    expect(directive).toContain("no-store");
    expect(directive).not.toContain("s-maxage");
    expect(directive).not.toContain("public");
  });
});
