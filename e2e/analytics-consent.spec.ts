import { expect, test, type APIRequestContext, type Page } from "./helpers/accessibility";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";
import { overrideModules, setModuleSettings } from "./helpers/modules";
import { ADMIN_WRITE_VISIBLE_POLL } from "./helpers/public-cache";

/*
  Google Analytics consent, end to end (#2573, docs/E2E_PLAYWRIGHT.md).

  This spec exists for the one guarantee a unit test can only prove
  STRUCTURALLY. The component test asserts that no `<Script>` element is
  rendered before the visitor accepts; that is good evidence, but the promise the
  owner's decision actually makes is about the NETWORK — "do not send Google
  Analytics requests, cookieless pings or consent-status data to Google before
  acceptance". Only a real browser can be asked whether anything left for
  Google's hosts, so that is what this asserts: every request to
  googletagmanager.com, google-analytics.com and analytics.google.com is
  recorded, and the expected count before Accept is zero.

  It also covers the hard cutover from the operator's side: the club starts with
  no measurement id (the seed has none, because `NEXT_PUBLIC_GA_MEASUREMENT_ID`
  is no longer read and its value is not imported), so the admin has to save one
  through Admin -> Integrations before anything can load at all.

  A fake measurement id is used deliberately. The soft-navigation test serves a
  fixed local gtag stub and fulfils collection requests: it tests the app's event
  calls and kill switch without depending on Google's loader or sending hits.
  Other tests still observe requests to Google with the fake id.
*/

test.describe.configure({ mode: "serial" });

/** A stream id that belongs to nobody. Valid in shape, dead in fact. */
const FAKE_MEASUREMENT_ID = "G-E2E0TEST00";

const GOOGLE_ANALYTICS_HOSTS = [
  "googletagmanager.com",
  "google-analytics.com",
  "analytics.google.com",
];

const SETTINGS_ENDPOINT = "/api/admin/integrations/analytics";

let admin: APIRequestContext;
/** Signed out, like the visitors this spec is about. Only reads the public site. */
let visitor: APIRequestContext;
let previousModules: Record<string, boolean>;

interface GoogleRequestLog {
  /** Every request URL, in order, recorded as the request BEGINS. */
  readonly urls: string[];
  /** How many of `urls` have finished or failed. */
  settled: number;
  /** The `dl` (page location) of each `page_view` event sent. */
  readonly pageViews: string[];
}

/**
 * The one rule for "this request is to a Google Analytics host". The recorder,
 * the settle counter and the local stub all use it, so nothing that is recorded
 * can reach the live network in a test that serves the stub.
 */
const isGoogleAnalyticsUrl = (url: string) =>
  GOOGLE_ANALYTICS_HOSTS.some((host) => url.includes(host));

/**
 * Every request the page made to a Google Analytics host, in order.
 *
 * Attached to the page rather than filtered afterwards, and recorded from
 * before the first navigation, so a request made during initial load cannot be
 * missed. A URL is recorded at `request`, not `requestfinished`, which would
 * under-report: a blocked or failed request is still a request that left, and
 * is still a disclosure. Settlement is counted separately, for a test that has
 * to know the page's own traffic is over before it takes a snapshot.
 */
function recordGoogleRequests(page: Page): GoogleRequestLog {
  const log: GoogleRequestLog = { urls: [], settled: 0, pageViews: [] };
  page.on("request", (request) => {
    const url = request.url();
    if (!isGoogleAnalyticsUrl(url)) return;
    log.urls.push(url);
    // GA4 puts a lone event's name in the URL, and each event of a batch on
    // its own line of the body; the page location is shared, in the URL.
    const params = new URL(url).searchParams;
    const events = [
      params.get("en"),
      ...(request.postData() ?? "")
        .split("\n")
        .map((line) => new URLSearchParams(line).get("en")),
    ];
    for (const event of events) {
      if (event === "page_view") log.pageViews.push(params.get("dl") ?? "");
    }
  });
  const settle = (request: { url(): string }) => {
    const url = request.url();
    if (!isGoogleAnalyticsUrl(url)) return;
    log.settled += 1;
  };
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);
  return log;
}

/** A local tag: replay queued events and process later pushes, respecting opt-out. */
async function stubGoogleTag(page: Page): Promise<void> {
  await page.route((url) => isGoogleAnalyticsUrl(url.href), async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "www.googletagmanager.com" && url.pathname === "/gtag/js") {
      await route.fulfill({
        contentType: "application/javascript",
        body: `(() => {
          const id = ${JSON.stringify(FAKE_MEASUREMENT_ID)};
          const queue = window.dataLayer = window.dataLayer || [];
          const send = (args) => {
            if (args[0] !== 'event' || window['ga-disable-' + id]) return;
            const params = new URLSearchParams({
              tid: id, en: args[1], dl: args[2]?.page_location || location.href,
            });
            fetch('https://www.google-analytics.com/g/collect?' + params,
              { mode: 'no-cors' }).catch(() => {});
          };
          const pending = queue.slice();
          queue.push = (...items) => {
            const length = Array.prototype.push.apply(queue, items);
            items.forEach(send);
            return length;
          };
          pending.forEach(send);
        })();`,
      });
    } else {
      await route.fulfill({ status: 204 });
    }
  });
}

/** The stub's first page_view began and all recorded requests settled. */
function firstPageTrafficSettled(log: GoogleRequestLog, pageLocation: string): boolean {
  return log.pageViews.includes(pageLocation) && log.settled === log.urls.length;
}

/** A recorded request, as a failure message names it. */
function describeGoogleRequest(url: string): string {
  const parsed = new URL(url);
  const event = parsed.searchParams.get("en");
  const location = parsed.searchParams.get("dl");
  return [
    `${parsed.host}${parsed.pathname}`,
    event ? `en=${event}` : "",
    location ? `dl=${location}` : "",
  ].filter(Boolean).join(" ");
}

async function saveAnalyticsSettings(
  request: APIRequestContext,
  data: {
    measurementId: string;
    consentBannerEnabled: boolean;
    bannerMessage: string;
  },
): Promise<void> {
  const res = await request.put(SETTINGS_ENDPOINT, { data });
  expect(res.ok(), `PUT ${SETTINGS_ENDPOINT} (${res.status()})`).toBeTruthy();
  await expectPublicSiteServes(data);
}

/**
 * The analytics configuration the public home page is being SERVED with, read
 * from the document itself: the layout hands it to the consent component as a
 * prop, so it is in the page's serialised component payload. The quotes there
 * are backslash-escaped, hence the optional backslashes.
 */
async function servedAnalyticsState(): Promise<string> {
  const html = await (await visitor.get("/")).text();
  const measurementId =
    /measurementId\\?":\\?"([^"\\]*)/.exec(html)?.[1] ?? "";
  if (measurementId === "") return "off";
  const bannerEnabled =
    /consentBannerEnabled\\?":(true|false)/.exec(html)?.[1] ?? "unknown";
  return `${measurementId} banner=${bannerEnabled}`;
}

/**
 * Wait until the public site is rendered with the settings just saved (#5205).
 *
 * The settings route clears the public caches as its response finishes, so the
 * very next page load can still be the old configuration, and every test below
 * would then be asserting about the state the test before it left behind. This
 * waits for the write to land BEFORE the test's own page is opened, so the
 * recorded Google requests are never those of a stale render.
 */
async function expectPublicSiteServes(data: {
  measurementId: string;
  consentBannerEnabled: boolean;
}): Promise<void> {
  const expected =
    data.measurementId === ""
      ? "off"
      : `${data.measurementId} banner=${data.consentBannerEnabled}`;
  await expect
    .poll(servedAnalyticsState, {
      message:
        "the public home page must be served with the analytics settings just saved",
      ...ADMIN_WRITE_VISIBLE_POLL,
    })
    .toBe(expected);
}

const BANNER_MESSAGE = "E2E: analytics runs only after you select Accept.";

const banner = (page: Page) =>
  page.getByRole("dialog", { name: "Analytics cookie consent" });

test.beforeAll(async ({ playwright, baseURL }) => {
  admin = await playwright.request.newContext({
    baseURL,
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  visitor = await playwright.request.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  previousModules = await overrideModules(admin, { analytics: true });
});

test.afterAll(async () => {
  // Clear the measurement id first, so the club is left with analytics off even
  // if the module restore below is what fails.
  await saveAnalyticsSettings(admin, {
    measurementId: "",
    consentBannerEnabled: true,
    bannerMessage: BANNER_MESSAGE,
  }).catch(() => {});
  if (previousModules) {
    await setModuleSettings(admin, previousModules).catch(() => {});
  }
  await visitor.dispose();
  await admin.dispose();
});

test.describe("Google Analytics consent (anonymous visitor)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the module alone loads nothing: the hard cutover leaves analytics off", async ({
    page,
  }) => {
    // The module is ON for this whole file, and the club has no measurement id
    // saved — which is exactly the state every club is in immediately after the
    // upgrade that removes the environment variable.
    await saveAnalyticsSettings(admin, {
      measurementId: "",
      consentBannerEnabled: true,
      bannerMessage: BANNER_MESSAGE,
    });

    const googleRequests = recordGoogleRequests(page).urls;
    await page.goto("/");
    await expect(page.locator("footer")).toBeVisible();

    expect(googleRequests).toEqual([]);
    await expect(banner(page)).toBeHidden();
    // And no preferences control either — there is nothing to have a preference
    // about.
    await expect(
      page.getByRole("button", { name: "Analytics preferences" }),
    ).toBeHidden();
  });

  test("banner enabled: NOTHING reaches Google before Accept, and only the saved id after", async ({
    page,
  }) => {
    await saveAnalyticsSettings(admin, {
      measurementId: FAKE_MEASUREMENT_ID,
      consentBannerEnabled: true,
      bannerMessage: BANNER_MESSAGE,
    });

    const googleRequests = recordGoogleRequests(page).urls;
    await page.goto("/");

    // The banner shows the admin's own wording.
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText(BANNER_MESSAGE);

    // THE GUARANTEE. Not "no tag" — no request of any kind, to any Google
    // Analytics host, before the visitor has said yes.
    expect(
      googleRequests,
      "no request may reach Google before the visitor accepts",
    ).toEqual([]);

    await banner(page).getByRole("button", { name: "Accept" }).click();
    await expect(banner(page)).toBeHidden();

    // Now the loader is fetched, for the id the admin saved and no other.
    await expect
      .poll(() => googleRequests.length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(
      googleRequests.some((url) =>
        url.includes(`googletagmanager.com/gtag/js?id=${FAKE_MEASUREMENT_ID}`),
      ),
      `expected the gtag loader for ${FAKE_MEASUREMENT_ID}; saw ${googleRequests.join(", ")}`,
    ).toBe(true);

    /*
      A CONDITIONAL check on the URL sanitisation, and its limit is stated
      rather than hidden. Google may serve its library for the fake id, and a
      `collect` request may or may not follow the loader (CI run 44464520408:
      loader 200, no hit), so this loop checks only the requests made by the
      time it runs. Whether Google answers is not this spec's to control, and
      the loop must not be mistaken for the proof.

      What proves the sanitisation is `analytics-route-policy.test.ts` (only
      origin + pathname is ever built, for an eligible route) and
      `analytics-consent.test.tsx` (`send_page_view: false`, one page view per
      address, the referrer reduced). This is here so that a query string in a
      collect request's `dl` fails the suite instead of going unnoticed.
    */
    const origin = new URL(page.url()).origin;
    for (const url of googleRequests) {
      const pageLocation = new URL(url).searchParams.get("dl");
      if (!pageLocation) continue;
      expect(pageLocation, `page_location in ${url}`).toBe(`${origin}/`);
    }
  });

  test("banner enabled: declining loads nothing, and the choice survives a reload", async ({
    page,
  }) => {
    await saveAnalyticsSettings(admin, {
      measurementId: FAKE_MEASUREMENT_ID,
      consentBannerEnabled: true,
      bannerMessage: BANNER_MESSAGE,
    });

    const googleRequests = recordGoogleRequests(page).urls;
    await page.goto("/");
    await expect(banner(page)).toBeVisible();

    await banner(page).getByRole("button", { name: "Decline" }).click();
    await expect(banner(page)).toBeHidden();
    expect(googleRequests).toEqual([]);

    // The stored decline is honoured on revisit: no banner, and still nothing
    // sent.
    await page.reload();
    await expect(page.locator("footer")).toBeVisible();
    await expect(banner(page)).toBeHidden();
    expect(googleRequests).toEqual([]);
  });

  test("analytics never loads on an excluded route, even with the banner switched off", async ({
    page,
  }) => {
    await saveAnalyticsSettings(admin, {
      measurementId: FAKE_MEASUREMENT_ID,
      consentBannerEnabled: false,
      bannerMessage: BANNER_MESSAGE,
    });

    const googleRequests = recordGoogleRequests(page).urls;
    // Banner OFF, so this is the most permissive configuration there is: if the
    // route policy were not enforced, the tag would load here.
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    expect(
      googleRequests,
      "an authentication route must never load analytics",
    ).toEqual([]);
    await expect(banner(page)).toBeHidden();
  });

  test("a soft navigation off the public website disables the resident tag", async ({
    page,
  }) => {
    /*
      The gap this closes, in the browser rather than in theory: the runtime is
      mounted by the public WEBSITE layouts only, so clicking the header's own
      "Log In" link is a client-side navigation into a route group that mounts
      nothing analytics-related. React unmounts the runtime there — and unmounting
      a script element cannot unload a library the browser has already executed,
      so before the unmount effect the tag stayed resident with its kill switch
      OFF and went on collecting across the login, recovery and member routes the
      owner's section 7 excludes.

      What is asserted is the state Google's own library reads: `ga-disable-<id>`
      must be true once the runtime has gone. Next may retain the already-injected
      `next/script` node for the life of this document, so DOM-node removal is not
      the boundary and is deliberately not asserted. The local stub replays queued
      events and observes future gtag calls, respecting the same kill switch. The snapshot
      waits for its first `page_view` and completed local requests,
      and any request that BEGINS after it, through the navigation, fails the count
      at the end.
    */
    await saveAnalyticsSettings(admin, {
      measurementId: FAKE_MEASUREMENT_ID,
      consentBannerEnabled: false,
      bannerMessage: BANNER_MESSAGE,
    });

    await stubGoogleTag(page);
    const google = recordGoogleRequests(page);
    const googleRequests = google.urls;
    await page.goto("/");
    await expect(banner(page)).toBeHidden();
    await expect
      .poll(() => googleRequests.length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    // Collecting: the loader is present and the per-id kill switch is off.
    await expect(page.locator("#ga4-loader")).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            (window as unknown as Record<string, unknown>)[`ga-disable-${id}`],
          FAKE_MEASUREMENT_ID,
        ),
      )
      .toBe(false);

    // The home page's own traffic ends before the snapshot: its page_view hit
    // starts only after the loader has finished, so counting at the loader
    // alone raced it (#5155: expected 1, received 4).
    const homeLocation = `${new URL(page.url()).origin}/`;
    await expect
      .poll(
        () =>
          firstPageTrafficSettled(google, homeLocation)
            ? "settled"
            : `still waiting (${google.settled}/${googleRequests.length} settled): ${googleRequests
                .map(describeGoogleRequest)
                .join(", ")}`,
        {
          message: "the home page's own Google traffic must be over before the snapshot",
          timeout: 15_000,
        },
      )
      .toBe("settled");
    const requestsBefore = googleRequests.length;
    // A marker on the document, so the assertions below can state WHICH kind of
    // navigation happened rather than assume it. A full document load wipes it —
    // and a full load was always clean, so it would prove nothing about the fix.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__analyticsNavProbe = true;
    });

    // The header's own CTA, clicked as a visitor would.
    const logIn = page
      .getByRole("banner")
      .getByRole("link", { name: "Log In" })
      .first();
    await expect(logIn).toBeVisible();
    await logIn.click();
    await expect(page).toHaveURL(/\/login$/);

    // Asserted, not assumed: `/login` is in a different route GROUP but under the
    // same root layout, so Next transitions to it client-side. If this ever fails,
    // the framework has started hard-navigating between the groups — worth knowing,
    // because then this whole class of leak cannot occur but nothing here proves
    // the fix any more either.
    expect(
      await page.evaluate(
        () =>
          (window as unknown as Record<string, unknown>).__analyticsNavProbe ===
          true,
      ),
      "expected a client-side navigation into /login, not a full document load",
    ).toBe(true);

    // The runtime turned the tag off on its way out. This is the assertion the fix
    // exists for: the same document, the library still resident, collection off.
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            (window as unknown as Record<string, unknown>)[`ga-disable-${id}`],
          FAKE_MEASUREMENT_ID,
        ),
      )
      .toBe(true);
    expect(
      googleRequests.length,
      `no further request may reach Google after leaving the public website; saw ${googleRequests
        .slice(requestsBefore)
        .map(describeGoogleRequest)
        .join(", ")}`,
    ).toBe(requestsBefore);
  });

  test("banner disabled: analytics loads without asking, and the footer opt-out still works", async ({
    page,
  }) => {
    await saveAnalyticsSettings(admin, {
      measurementId: FAKE_MEASUREMENT_ID,
      consentBannerEnabled: false,
      bannerMessage: BANNER_MESSAGE,
    });

    const googleRequests = recordGoogleRequests(page).urls;
    await page.goto("/");

    // No prompt, and the tag loads by itself.
    await expect(banner(page)).toBeHidden();
    await expect
      .poll(() => googleRequests.length, { timeout: 15_000 })
      .toBeGreaterThan(0);

    // The preferences control is what makes this mode honest, so it has to be
    // reachable from the page itself rather than only in theory.
    const preferences = page.getByRole("button", {
      name: "Analytics preferences",
    });
    await expect(preferences).toBeVisible();
    await preferences.click();

    const panel = page.getByRole("dialog", { name: /Analytics preferences/ });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("currently allowed");
    await panel.getByRole("button", { name: "Turn analytics off" }).click();
    await expect(panel).toBeHidden();

    // The opt-out survives a reload in banner-off mode — the whole point of the
    // owner's clarification 1: turning the banner off must not make the
    // preferences control ineffective.
    const afterOptOut = recordGoogleRequests(page).urls;
    await page.reload();
    await expect(page.locator("footer")).toBeVisible();
    expect(
      afterOptOut,
      "a preferences opt-out must be honoured on later page loads",
    ).toEqual([]);

    await preferences.click();
    await expect(panel).toContainText("currently switched off");
  });
});
