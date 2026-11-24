import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Not ready yet" until site setup is complete (#2420).
 *
 * The defect: while `ClubTheme.completedAt IS NULL`, `(website)/layout.tsx`
 * returns its holding screen instead of `{children}`, the page component never
 * runs, and EVERY public address — real page, typo, and bot probe alike —
 * answers `200 OK`. Search engines are told a dead address is fine and
 * monitoring cannot tell an unconfigured site from a working one.
 *
 * Both halves of the contract are pinned here, and the second is as load-bearing
 * as the first:
 *  - with setup incomplete, every public-website address is 503 with the holding
 *    screen, and the admin area / API / setup wizard / login are untouched, so
 *    an operator part-way through setup can still finish it;
 *  - with setup complete, the gate is inert and behaviour is exactly as before —
 *    a change that 503s a live club's website would be far worse than the bug.
 */

const mocks = vi.hoisted(() => ({
  completion: vi.fn(),
  themeState: vi.fn(),
  clubIdentity: vi.fn(),
  emailSettings: vi.fn(),
}));

vi.mock("@/lib/club-theme", () => ({
  readSetupCompletion: mocks.completion,
  getWebsiteThemeRenderState: mocks.themeState,
}));
vi.mock("@/lib/club-identity-settings", () => ({
  getClubIdentity: mocks.clubIdentity,
}));
vi.mock("@/lib/email-message-settings", () => ({
  loadEmailMessageSettings: mocks.emailSettings,
}));

import {
  getSetupGateState,
  getSetupInProgressResponse,
  isPublicWebsitePath,
  NON_WEBSITE_ROOT_SEGMENTS,
  resetSetupGateCache,
  SETUP_STATE_READ_TIMEOUT_MS,
  SETUP_STATE_TTL_MS,
} from "@/lib/setup-gate";
import {
  buildSetupInProgressDocument,
  SETUP_IN_PROGRESS_COPY,
  SETUP_IN_PROGRESS_RETRY_AFTER_SECONDS,
} from "@/lib/setup-in-progress-screen";
import { escapeHtml } from "@/lib/email-templates/escape";
import { CSP_HEADER, SECURITY_HEADERS } from "@/lib/csp";
import proxy from "@/proxy";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

const CLUB_NAME = "Example Alpine Club";
const CONTACT_EMAIL = "office@example.org";

function setupIncomplete() {
  mocks.completion.mockResolvedValue({ readFailed: false, isComplete: false });
  mocks.themeState.mockResolvedValue({
    isComplete: false,
    css: ":root{--brand-gold:#c8a227}",
  });
}

function setupComplete() {
  mocks.completion.mockResolvedValue({ readFailed: false, isComplete: true });
  mocks.themeState.mockResolvedValue({
    isComplete: true,
    css: ":root{--brand-gold:#c8a227}",
  });
}

function request(url: string, init?: { method?: string }) {
  return new NextRequest(`https://example.org${url}`, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSetupGateCache();
  mocks.clubIdentity.mockResolvedValue({ name: CLUB_NAME });
  mocks.emailSettings.mockResolvedValue({
    clubName: CLUB_NAME,
    contactEmail: CONTACT_EMAIL,
  });
  setupComplete();
});

/**
 * The addresses the issue measured, plus the two shapes that matter most either
 * side of the fix: a real published page and the site root.
 */
const publicWebsiteUrls = [
  "/",
  "/about",
  "/contact",
  "/join/membership",
  "/hut-leader-instructions",
  "/definitely-missing",
  "/wp-admin/setup-config.php",
  "/.env",
  // Not the admin area: Next routing is case-sensitive, so this is an unmatched
  // website address and must be gated like any other.
  "/Admin/nope",
  // Shapes that merely START with an excluded matcher token (#2420 review F3).
  // These were skipping the proxy entirely, so pre-setup they answered 200.
  "/apiary",
  "/api-docs",
  "/favicon.icons",
  "/logo.pngs",
  "/faviconXico",
];

/**
 * Everything an operator part-way through setup still needs, plus the machine
 * surfaces. `/api/*` is listed even though the proxy matcher already drops it —
 * the gate must refuse it on its own so `api/[[...unmatched]]` (#2405) keeps
 * answering JSON 404, and the module gate keeps its verb-by-verb parity with
 * that route, identically in both setup states. Bare `/api` and `/api/` are
 * included because #2405 moved that route to an OPTIONAL catch-all to claim
 * them, and the gate must not take them back.
 */
const exemptUrls = [
  "/admin",
  "/admin/site-style",
  "/admin/setup",
  "/api",
  "/api/",
  "/api/admin/site-style",
  "/api/definitely-missing",
  "/login",
  "/forgot-password",
  "/reset-password/some-token",
  "/dashboard",
  "/bookings",
  "/finance",
  "/lodge/kiosk",
  "/display",
  "/robots.txt",
  "/sitemap.xml",
  "/favicon.ico",
  "/_next/static/chunks/main.js",
  // Asset-shaped URLs. #2420's F3 kept these out of the gate because the proxy
  // matcher skipped them, so a 503 could never have been served for one. #2404's
  // Option A removed that exclusion — the proxy runs on them now and the gate
  // really is asked — and the answer must not change, for a stronger reason: the
  // holding screen is an HTML DOCUMENT, and answering a request for an image
  // with one is precisely what #2404 exists to stop. The last two are MISSES
  // (nothing backs either URL), which is the case the rewrites terminate with an
  // empty 404; a 503 here would put the document straight back.
  "/logo.png",
  "/branding/logo.png",
  "/gallery.svg",
  "/branding/definitely-missing.png",
  "/wp-content/uploads/x.jpg",
  // The terminal route those misses are rewritten to. Reachable directly, and it
  // has no extension, so only NON_WEBSITE_ROOT_SEGMENTS keeps it out.
  "/asset-not-found",
];

describe("which addresses the setup gate covers", { timeout: CENSUS_TIMEOUT_MS }, () => {
  it.each(publicWebsiteUrls)("treats %s as a public-website address", (url) => {
    expect(isPublicWebsitePath(url)).toBe(true);
  });

  it.each(exemptUrls)("leaves %s outside the gate", (url) => {
    expect(isPublicWebsitePath(url)).toBe(false);
  });

  it("ignores a trailing slash", () => {
    expect(isPublicWebsitePath("/about/")).toBe(true);
    expect(isPublicWebsitePath("/admin/")).toBe(false);
  });

  /**
   * The exemption list is a DENY list because `(website)/[...slug]` claims every
   * URL no other route group claims — so a top-level route added to any other
   * group would start answering 503 during setup unless it is listed. This walks
   * the route tree and fails when that happens, which is what keeps the list
   * from quietly going stale.
   *
   * BOTH public route groups count as the website (#2352 D1 narrowing, 3 Aug
   * 2026). `(website-dynamic)` holds eight routes: `/hut-leader-instructions`,
   * `/join/[code]`, `/join/verify/[token]`, and the two form pages
   * `/booking-requests` and `/school-bookings` with their token flows (#2818
   * decision 2). They carry a per-request CSP nonce instead of the fixed
   * per-release one, and that is the ONLY thing the group changes about them. They
   * are public website addresses, so the holding screen still stands in for them
   * before setup is complete — and treating the new group as "some other route
   * group" here would have demanded exactly the opposite, that
   * `hut-leader-instructions`, `join` and the two form pages be added to the
   * exemption list.
   */
  const PUBLIC_WEBSITE_GROUPS = ["(website)", "(website-dynamic)"];

  it("exempts every top-level route that lives outside the public website groups", () => {
    const appDir = path.join(process.cwd(), "src/app");
    const directories = (dir: string) =>
      readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

    const missing: string[] = [];
    const websiteSegments: string[] = [];

    for (const entry of directories(appDir)) {
      // Route groups are transparent to the URL; their children are the real
      // top-level segments. Anything else at the app root already is one.
      const isGroup = entry.startsWith("(") && entry.endsWith(")");
      const segments = isGroup ? directories(path.join(appDir, entry)) : [entry];

      for (const segment of segments) {
        // Test folders, private folders and dynamic segments are not fixed
        // top-level URLs.
        if (
          segment === "__tests__" ||
          segment.startsWith("_") ||
          segment.startsWith("[")
        ) {
          continue;
        }

        if (PUBLIC_WEBSITE_GROUPS.includes(entry)) {
          websiteSegments.push(segment);
          continue;
        }

        if (!NON_WEBSITE_ROOT_SEGMENTS.has(segment)) {
          missing.push(segment);
        }
      }
    }

    expect(missing).toEqual([]);

    // Sanity check on the walk itself: if this came back empty the assertion
    // above would pass vacuously.
    expect(websiteSegments.length).toBeGreaterThan(0);
    for (const segment of websiteSegments) {
      expect(NON_WEBSITE_ROOT_SEGMENTS.has(segment)).toBe(false);
    }
  });

  /**
   * The walk above only sees DIRECTORIES, so Next's FILE-based root routes were
   * invisible to it (#2420 review finding F6a). `src/app/sitemap.ts` is a real
   * URL — `/sitemap.xml` — held out of the gate only by the hand-maintained
   * `NON_WEBSITE_EXACT_PATHS`, and dropping in `robots.ts`, `manifest.ts`,
   * `icon.tsx` or `opengraph-image.tsx` later would start 503-ing a machine
   * address during setup with nothing failing to say so.
   *
   * Each convention is mapped to the URL Next serves it at, and every one must
   * be outside the gate. An UNKNOWN root file fails loudly rather than being
   * skipped, so a convention this map has not learned yet cannot slip past.
   */
  it("exempts every file-based route convention at the app root", () => {
    const appDir = path.join(process.cwd(), "src/app");

    // Next's metadata/route file conventions → the URL each one serves.
    const conventionUrls: Record<string, string> = {
      sitemap: "/sitemap.xml",
      robots: "/robots.txt",
      manifest: "/manifest.webmanifest",
      icon: "/icon",
      "apple-icon": "/apple-icon",
      "opengraph-image": "/opengraph-image",
      "twitter-image": "/twitter-image",
    };

    // Files that are NOT routes: the segment conventions and plain assets.
    const notRoutes = new Set([
      "layout",
      "template",
      "error",
      "global-error",
      "not-found",
      "loading",
      "default",
      "page",
      "route",
      "globals.css",
      "favicon.ico",
    ]);

    const rootFiles = readdirSync(appDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);

    const unrecognised: string[] = [];

    for (const file of rootFiles) {
      const base = file.replace(/\.(?:tsx?|jsx?|css|ico)$/, "");

      if (notRoutes.has(base) || notRoutes.has(file)) {
        continue;
      }

      const url = conventionUrls[base];

      if (!url) {
        unrecognised.push(file);
        continue;
      }

      expect(
        isPublicWebsitePath(url),
        `${file} serves ${url}; a machine address must not be gated`,
      ).toBe(false);
    }

    expect(
      unrecognised,
      "unknown root route file — map it to its URL and confirm the gate's answer",
    ).toEqual([]);
    // Guards the walk: sitemap.ts exists today, so this can never be vacuous.
    expect(rootFiles).toContain("sitemap.ts");
  });
});

describe("with setup incomplete (ClubTheme.completedAt IS NULL)", () => {
  beforeEach(() => {
    setupIncomplete();
  });

  it.each(publicWebsiteUrls)("answers 503 for %s", async (url) => {
    const response = await getSetupInProgressResponse(request(url));

    expect(response?.status).toBe(503);
    expect(response?.headers.get("content-type")).toContain("text/html");
  });

  it.each(exemptUrls)("does not gate %s", async (url) => {
    await expect(getSetupInProgressResponse(request(url))).resolves.toBeNull();
  });

  it("serves the holding screen as the body, for a real page and a missing one alike", async () => {
    // Stated choice, not an accident: a published page is 503 too. Answering 200
    // for /about and 503 for /nope would publish the club's page inventory from
    // a half-built install and let a crawler index pages before the club has
    // chosen how they look.
    const real = await getSetupInProgressResponse(request("/about"));
    const missing = await getSetupInProgressResponse(
      request("/definitely-missing"),
    );

    const realBody = await real!.text();

    expect(realBody).toContain(SETUP_IN_PROGRESS_COPY.eyebrow);
    expect(realBody).toContain(SETUP_IN_PROGRESS_COPY.heading(CLUB_NAME));
    expect(realBody).toContain(SETUP_IN_PROGRESS_COPY.body);
    expect(realBody).toContain(`mailto:${CONTACT_EMAIL}`);
    expect(await missing!.text()).toBe(realBody);
  });

  it("tells clients when to come back, and forbids caching the screen", async () => {
    // Retry-After is set deliberately: a bare long-running 503 is a signal to
    // start dropping the club's URLs from an index, whereas 503 + Retry-After is
    // read as a temporary outage. no-store because `/` is otherwise allow-listed
    // as browser-cacheable for 60s, which would outlive setup completion.
    const response = await getSetupInProgressResponse(request("/"));

    expect(response?.headers.get("Retry-After")).toBe(
      String(SETUP_IN_PROGRESS_RETRY_AFTER_SECONDS),
    );
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
  });

  it("gates a form POST as well as a GET", async () => {
    const response = await getSetupInProgressResponse(
      request("/contact", { method: "POST" }),
    );

    expect(response?.status).toBe(503);
  });

  it("answers HEAD with the same status and no body", async () => {
    const response = await getSetupInProgressResponse(
      request("/", { method: "HEAD" }),
    );

    expect(response?.status).toBe(503);
    await expect(response!.text()).resolves.toBe("");
  });

  it("escapes admin-editable values into the document", async () => {
    mocks.clubIdentity.mockResolvedValue({
      name: '<script>alert(1)</script> & Co',
    });
    resetSetupGateCache();

    const body = await (await getSetupInProgressResponse(request("/")))!.text();

    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co");
  });

  it("carries the club's own theme CSS so the screen is not unbranded", async () => {
    const body = await (await getSetupInProgressResponse(request("/")))!.text();

    expect(body).toContain("--brand-gold:#c8a227");
  });
});

describe("with setup complete", () => {
  it.each([...publicWebsiteUrls, ...exemptUrls])(
    "lets %s through untouched",
    async (url) => {
      await expect(getSetupInProgressResponse(request(url))).resolves.toBeNull();
    },
  );

  it("never reads the club identity or contact address", async () => {
    await getSetupInProgressResponse(request("/"));

    expect(mocks.clubIdentity).not.toHaveBeenCalled();
    expect(mocks.emailSettings).not.toHaveBeenCalled();
  });
});

/**
 * Moves the frozen clock past the memo's TTL for the duration of `run`.
 * `alsoFakeTimeouts` puts the read timeout under the test's control as well;
 * `settle()` cannot be used then, so advance the fake timers instead.
 */
async function afterTtl(
  run: () => Promise<void>,
  { alsoFakeTimeouts = false }: { alsoFakeTimeouts?: boolean } = {},
) {
  vi.useFakeTimers({
    toFake: alsoFakeTimeouts ? ["Date", "setTimeout", "clearTimeout"] : ["Date"],
  });
  try {
    vi.setSystemTime(Date.now() + SETUP_STATE_TTL_MS + 1);
    await run();
  } finally {
    vi.useRealTimers();
  }
}

/** Lets a background refresh run to completion (only `Date` is faked). */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A promise the test settles by hand, to hold a read in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("the gate does not add a database read per request", () => {
  it("reads the setup state once and reuses it inside the TTL", async () => {
    await getSetupInProgressResponse(request("/"));
    await getSetupInProgressResponse(request("/about"));
    await getSetupInProgressResponse(request("/contact"));

    expect(mocks.completion).toHaveBeenCalledTimes(1);
  });

  it("shares one read between requests that arrive together on a cold cache", async () => {
    await Promise.all([
      getSetupInProgressResponse(request("/")),
      getSetupInProgressResponse(request("/about")),
      getSetupInProgressResponse(request("/contact")),
    ]);

    expect(mocks.completion).toHaveBeenCalledTimes(1);
  });

  it("re-reads once the TTL lapses, so completing setup opens the site", async () => {
    setupIncomplete();
    expect((await getSetupInProgressResponse(request("/")))?.status).toBe(503);

    await afterTtl(async () => {
      setupComplete();

      // The request that finds the memo expired is answered from it and starts
      // the refresh; a later one gets the refreshed answer.
      expect((await getSetupInProgressResponse(request("/")))?.status).toBe(
        503,
      );
      await settle();
      await expect(
        getSetupInProgressResponse(request("/")),
      ).resolves.toBeNull();
    });

    expect(mocks.completion).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the setup state cannot be read", async () => {
    // A database that does not answer on a cold start is answered with the
    // holding screen — 503 is the literally correct answer for an unreachable
    // database. Failing open would restore the 200-for-everything defect under
    // exactly the conditions that make it hardest to notice.
    mocks.completion.mockResolvedValue({ readFailed: true });
    mocks.themeState.mockResolvedValue({
      isComplete: false,
      readFailed: true,
      css: "",
    });

    const response = await getSetupInProgressResponse(request("/"));

    expect(response?.status).toBe(503);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
  });

  it("still answers 503 with a readable screen if resolving the state throws", async () => {
    // A Prisma client that never constructed, say — a realistic first-boot state
    // for exactly the install this screen exists for. An unhandled throw in the
    // proxy would be a 500; the config-derived fallback keeps it a 503.
    mocks.completion.mockRejectedValue(new Error("no database client"));

    const response = await getSetupInProgressResponse(request("/"));

    expect(response?.status).toBe(503);
    await expect(response!.text()).resolves.toContain(
      SETUP_IN_PROGRESS_COPY.eyebrow,
    );
  });
});

describe("a live club's refill is one completedAt read (#5264)", () => {
  // The stall: every 15 seconds the request that found the memo expired waited
  // while the whole theme loaded and its CSS was generated, hundreds of
  // milliseconds of CPU. Pinned by call count, never by wall time.
  it("never loads the theme, the identity or the contact address", async () => {
    await getSetupInProgressResponse(request("/"));
    await afterTtl(async () => {
      await getSetupInProgressResponse(request("/"));
      await getSetupInProgressResponse(request("/"));
    });

    expect(mocks.completion).toHaveBeenCalledTimes(2);
    expect(mocks.themeState).not.toHaveBeenCalled();
    expect(mocks.clubIdentity).not.toHaveBeenCalled();
    expect(mocks.emailSettings).not.toHaveBeenCalled();
  });
});

describe("an expired answer is served while it refreshes (#5264)", () => {
  it("answers at once from the expired memo, without waiting for the read", async () => {
    setupIncomplete();
    await getSetupGateState();

    const read = deferred<{ readFailed: false; isComplete: boolean }>();
    mocks.completion.mockReturnValue(read.promise);

    await afterTtl(async () => {
      // Resolves although the read is still pending.
      await expect(getSetupGateState()).resolves.toMatchObject({
        isComplete: false,
      });

      read.resolve({ readFailed: false, isComplete: true });
      await settle();
      await expect(getSetupGateState()).resolves.toEqual({
        isComplete: true,
      });
    });
  });

  it("starts one refresh however many requests find the memo expired", async () => {
    await getSetupGateState();
    const read = deferred<{ readFailed: false; isComplete: boolean }>();
    mocks.completion.mockReturnValue(read.promise);

    await afterTtl(async () => {
      await Promise.all([
        getSetupGateState(),
        getSetupGateState(),
        getSetupGateState(),
      ]);
      read.resolve({ readFailed: false, isComplete: true });
      await settle();
    });

    expect(mocks.completion).toHaveBeenCalledTimes(2);
  });

  it("keeps a known 'complete' when the database does not answer", async () => {
    // A blip must not close a live club's website for 15 seconds.
    await getSetupGateState();
    mocks.completion.mockResolvedValue({ readFailed: true });
    mocks.themeState.mockResolvedValue({
      isComplete: false,
      readFailed: true,
      css: "",
    });

    await afterTtl(async () => {
      await getSetupGateState();
      await settle();
      await expect(getSetupGateState()).resolves.toEqual({ isComplete: true });
      // Stamped fresh, so the database is retried once per TTL, not per request.
      expect(mocks.completion).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps the last answer when a refresh throws", async () => {
    await getSetupGateState();
    mocks.completion.mockRejectedValue(new Error("connection reset"));

    await afterTtl(async () => {
      await getSetupGateState();
      await settle();
      await expect(getSetupGateState()).resolves.toEqual({ isComplete: true });
      // Stamped fresh, so the database is retried once per TTL, not per request.
      expect(mocks.completion).toHaveBeenCalledTimes(2);
    });
  });

  it("closes the site on a positive 'not complete' even if the theme read then fails", async () => {
    await getSetupGateState();
    mocks.completion.mockResolvedValue({ readFailed: false, isComplete: false });
    mocks.themeState.mockResolvedValue({
      isComplete: false,
      readFailed: true,
      css: "",
    });

    await afterTtl(async () => {
      await getSetupGateState();
      await settle();
      await expect(getSetupGateState()).resolves.toMatchObject({
        isComplete: false,
      });
    });
  });

  it("closes the site on a positive 'not complete' even if building the screen throws", async () => {
    // A positive answer must not fall into the refresh's failure arm, which
    // keeps the stale "complete".
    await getSetupGateState();
    mocks.completion.mockResolvedValue({ readFailed: false, isComplete: false });
    mocks.themeState.mockRejectedValue(new Error("palette generator failed"));

    await afterTtl(async () => {
      await getSetupGateState();
      await settle();
      const state = await getSetupGateState();
      expect(state.isComplete).toBe(false);
      expect(state).toMatchObject({
        document: expect.stringContaining(SETUP_IN_PROGRESS_COPY.eyebrow),
      });
    });
  });

  it("abandons a hung read after the timeout, so the next expiry retries", async () => {
    // Prisma has no query timeout: a query on a half-open connection can hang
    // for ever, which would pin the single-flight promise and stop all retries.
    await getSetupGateState();
    mocks.completion.mockReturnValue(new Promise(() => {}));

    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      vi.setSystemTime(Date.now() + SETUP_STATE_TTL_MS + 1);
      await expect(getSetupGateState()).resolves.toEqual({ isComplete: true });
      expect(mocks.completion).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(SETUP_STATE_READ_TIMEOUT_MS);
      // Timed out: kept "complete", stamped fresh, single-flight cleared.
      await expect(getSetupGateState()).resolves.toEqual({ isComplete: true });
      expect(mocks.completion).toHaveBeenCalledTimes(2);

      setupIncomplete();
      vi.setSystemTime(Date.now() + SETUP_STATE_TTL_MS + 1);
      await getSetupGateState();
      expect(mocks.completion).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(0);
      await expect(getSetupGateState()).resolves.toMatchObject({
        isComplete: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed on a cold start whose read hangs", async () => {
    mocks.completion.mockReturnValue(new Promise(() => {}));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = getSetupGateState();
      await vi.advanceTimersByTimeAsync(SETUP_STATE_READ_TIMEOUT_MS);
      await expect(pending).resolves.toMatchObject({ isComplete: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does close the site when the database positively says setup is incomplete", async () => {
    // The counterpart: only a FAILED read is ignored. A real answer — an
    // operator resetting setup, say — still takes effect.
    await getSetupGateState();
    setupIncomplete();

    await afterTtl(async () => {
      await getSetupGateState();
      await settle();
      await expect(getSetupGateState()).resolves.toMatchObject({
        isComplete: false,
      });
    });
  });
});

describe("an expired 'not complete' stays closed when its refresh does not answer (#5352)", () => {
  // Every refresh-failure case above starts from "complete" and proves a live
  // site stays open. These start from "not complete": a refresh that fails,
  // throws or hangs must never open a site that was last known to be
  // unconfigured. Each asserts the 503 while the refresh is in flight and
  // again once it has settled.
  async function expectClosed() {
    const response = await getSetupInProgressResponse(request("/"));
    expect(response?.status).toBe(503);
    await expect(response!.text()).resolves.toContain(
      SETUP_IN_PROGRESS_COPY.eyebrow,
    );
  }

  it("stays closed when the database does not answer", async () => {
    setupIncomplete();
    await expectClosed();
    mocks.completion.mockResolvedValue({ readFailed: true });
    mocks.themeState.mockResolvedValue({
      isComplete: false,
      readFailed: true,
      css: "",
    });

    await afterTtl(async () => {
      await expectClosed();
      await settle();
      await expectClosed();
      // The refresh ran and was stamped fresh: no second refresh before it expires.
      expect(mocks.completion).toHaveBeenCalledTimes(2);
    });
  });

  it("stays closed when the refresh throws", async () => {
    setupIncomplete();
    await expectClosed();
    mocks.completion.mockRejectedValue(new Error("connection reset"));

    await afterTtl(async () => {
      await expectClosed();
      await settle();
      await expectClosed();
      expect(mocks.completion).toHaveBeenCalledTimes(2);
    });
  });

  it("stays closed when the refresh hangs, and retries at the next expiry", async () => {
    setupIncomplete();
    await expectClosed();
    mocks.completion.mockReturnValue(new Promise(() => {}));

    await afterTtl(
      async () => {
        // The read is in flight and will never answer.
        await expectClosed();
        expect(mocks.completion).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(SETUP_STATE_READ_TIMEOUT_MS);
        // Timed out: still closed, stamped fresh, single-flight cleared.
        await expectClosed();
        expect(mocks.completion).toHaveBeenCalledTimes(2);

        vi.setSystemTime(Date.now() + SETUP_STATE_TTL_MS + 1);
        await expectClosed();
        expect(mocks.completion).toHaveBeenCalledTimes(3);
      },
      { alsoFakeTimeouts: true },
    );
  });
});

describe("the proxy applies the gate end to end", () => {
  it("returns the 503 with the security headers still attached", async () => {
    setupIncomplete();

    const response = await proxy(request("/definitely-missing"));

    expect(response.status).toBe(503);
    expect(response.headers.get(CSP_HEADER)).toBeTruthy();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  it("never lets the holding screen carry the anonymous page cache headers", async () => {
    // `/` is allow-listed as browser-cacheable for 60s (300s stale) for
    // anonymous visitors (#2322). A holding screen must never be stored under
    // that entry — it would go on claiming the club is unlaunched long after the
    // admin finished setup. The gate returns before the allow list is consulted
    // and sets `no-store` of its own (#2420 review F4).
    setupIncomplete();

    const response = await proxy(request("/"));

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vary") ?? "").not.toContain("Cookie");
  });

  it("passes an admin request through while the gate is closed", async () => {
    setupIncomplete();

    const response = await proxy(request("/admin/site-style"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("does nothing once setup is complete", async () => {
    const response = await proxy(request("/definitely-missing"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("the shared chrome's fallback screen says the same thing", () => {
  it("renders its pre-setup branch from the shared copy", () => {
    // The render-time fallback still has to hold a copy of this screen: the gate
    // answers only for a path it CLAIMS, and it refuses asset-extension paths on
    // purpose, so such a URL that no route serves reaches the render directly. It
    // cannot set a status, so its copy is 200 — but it must never say something
    // different from the 503 body. Checked structurally because the branch only
    // renders inside a request scope.
    //
    // It lives in the shared chrome since the D1 narrowing (3 Aug 2026), which is
    // what makes ONE copy cover both public route groups — every per-request
    // route gets the same holding screen as the five approved ones, from the same
    // strings. `scripts/ci/check-website-render-modes.mjs` fails the build if
    // either layout stops composing this component.
    const source = readFileSync(
      path.join(process.cwd(), "src/components/website/website-chrome.tsx"),
      "utf8",
    );

    expect(source).toContain(
      'import { SETUP_IN_PROGRESS_COPY } from "@/lib/setup-in-progress-screen"',
    );
    expect(source).toContain("SETUP_IN_PROGRESS_COPY.eyebrow");
    expect(source).toContain("SETUP_IN_PROGRESS_COPY.heading(");
    expect(source).toContain("SETUP_IN_PROGRESS_COPY.body");
    expect(source).toContain("SETUP_IN_PROGRESS_COPY.contactPrefix");
  });
});

/**
 * #2689 review: `setup-in-progress-screen.ts` keeps its OWN copy of the HTML
 * escaper rather than importing the leaf, deliberately — it is bundled into the
 * proxy and its whole point is to carry no edge into the email layer. That is a
 * defensible choice, but two copies of an escaper are exactly the pair that
 * drifts silently, and only one of them has a rendered-output gate behind it.
 * So pin them equal on every character the leaf maps.
 */
describe("setup-in-progress screen escaper parity (#2689)", () => {
  it("escapes club name and contact email exactly as the shared leaf does", () => {
    const nasty = `R&D <b>"quoted"</b> O'Brien`;
    const document = buildSetupInProgressDocument({
      clubName: nasty,
      contactEmail: nasty,
      themeCss: "",
    });

    const expected = escapeHtml(nasty);
    expect(expected).toBe(
      "R&amp;D &lt;b&gt;&quot;quoted&quot;&lt;/b&gt; O&#39;Brien",
    );
    // Both interpolation sites carry the leaf's exact output...
    expect(document).toContain(expected);
    // ...and the raw characters never reach the document.
    expect(document).not.toContain(nasty);
    expect(document).not.toContain("<b>");
  });
});
