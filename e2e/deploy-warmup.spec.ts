import { expect, test, type APIRequestContext } from "./helpers/accessibility";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "../prisma/e2e-fixtures";

/**
 * The pre-cutover warm-up gate against a REAL release (#2566).
 *
 * The owner's decision is explicit that unit coverage of the route list is not
 * enough: "Run production-mode integration tests against the actual target-service
 * and ISR configuration." Everything here therefore needs the staging stack, and
 * each case says what only a real server can show:
 *
 *  • the ISR verification is a genuine `x-nextjs-cache` round trip against the
 *    release's own in-memory store — a mocked fetch can only prove the rule, not
 *    that the header exists and says what the rule expects;
 *  • route discovery reads `prerender-manifest.json` and
 *    `app-path-routes-manifest.json` out of the built artifact, so this is the only
 *    place that proves those files ship in the standalone image and carry the shape
 *    the classifier reads;
 *  • the critical routes are classified from that same artifact, so a release whose
 *    render modes drifted from `CRITICAL_PUBLIC_ROUTES` fails HERE rather than in
 *    production;
 *  • the warm-up asks the release's own loopback origin from inside the container,
 *    which no unit test can observe.
 *
 * The stack is a single app service rather than a blue/green pair, which changes
 * nothing that matters: the gate always warms the container it runs in.
 */

const WARMUP_PATH = "/api/deploy/warmup";

interface WarmupReport {
  verdict: "pass" | "pass-with-warning" | "blocked" | "skipped";
  serviceRole: string;
  releaseIdentity: string;
  publicHost: string;
  origin: string;
  cmsSnapshotAt: string;
  counts: {
    criticalDiscovered: number;
    criticalRendered: number;
    criticalCacheApplicable: number;
    criticalCacheVerified: number;
    criticalUnpublishedDuringWarmup: number;
    cmsDiscovered: number;
    cmsRendered: number;
    cmsCacheApplicable: number;
    cmsCacheVerified: number;
    cmsFailed: number;
    cmsUnpublishedDuringWarmup: number;
  };
  failures: Array<{ path: string; tier: string; kind: string; detail: string }>;
  excluded: Array<{ path: string; reason: string }>;
  warnings: string[];
  blockingReasons: string[];
}

const cronSecret = process.env.CRON_SECRET;

async function runGate(
  request: APIRequestContext,
  query = "",
): Promise<WarmupReport> {
  const response = await request.get(`${WARMUP_PATH}?format=json${query}`, {
    headers: { "x-cron-secret": cronSecret as string },
    // A cold render of every public page, one to four at a time, on a CI runner.
    timeout: 180_000,
  });

  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as WarmupReport;
}

test.describe("pre-cutover warm-up gate", () => {
  // A beforeEach guard rather than a describe-scope `test.skip(boolean, …)`,
  // which Playwright only supports inside a test or a hook.
  test.beforeEach(() => {
    test.skip(
      !cronSecret,
      "needs the staging CRON_SECRET (scripts/e2e-stack.sh exports it)",
    );
  });

  test("refuses to run for anyone without the deploy secret", async ({
    request,
  }) => {
    expect((await request.get(`${WARMUP_PATH}?format=json`)).status()).toBe(
      401,
    );
    expect(
      (
        await request.get(`${WARMUP_PATH}?format=json`, {
          headers: { "x-cron-secret": "not-the-secret" },
        })
      ).status(),
    ).toBe(401);
  });

  test("warms the public pages and verifies the store on a production build", async ({
    request,
  }) => {
    const report = await runGate(request, "&concurrency=2");

    expect(
      report.verdict,
      `blocked reasons: ${report.blockingReasons.join(" | ")}; failures: ${report.failures
        .map((failure) => `${failure.path} ${failure.kind} ${failure.detail}`)
        .join(" | ")}`,
    ).toBe("pass");

    // Every critical route the release declares was discovered and rendered.
    expect(report.counts.criticalDiscovered).toBeGreaterThanOrEqual(4);
    expect(report.counts.criticalRendered).toBe(
      report.counts.criticalDiscovered,
    );

    // And the seeded CMS pages were not merely 200s: the release reported them
    // back out of its own store. This is the assertion the whole issue exists for.
    expect(report.counts.cmsDiscovered).toBeGreaterThan(0);
    expect(report.counts.cmsCacheApplicable).toBe(report.counts.cmsDiscovered);
    expect(report.counts.cmsCacheVerified).toBe(report.counts.cmsDiscovered);
    expect(report.counts.cmsFailed).toBe(0);
    expect(report.failures).toEqual([]);
  });

  test("asks the release's own origin, and renders for the configured public host", async ({
    request,
  }) => {
    const report = await runGate(request);

    expect(report.origin).toBe("http://127.0.0.1:3000");
    expect(report.publicHost).toBe(
      new URL(process.env.NEXTAUTH_URL ?? "http://localhost:3001").host,
    );
    expect(report.serviceRole.length).toBeGreaterThan(0);
    expect(Date.parse(report.cmsSnapshotAt)).not.toBeNaN();
  });

  test("returns the operator summary the deploy script gates on", async ({
    request,
  }) => {
    const response = await request.get(`${WARMUP_PATH}?format=text`, {
      headers: { "x-cron-secret": cronSecret as string },
      timeout: 180_000,
    });

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");

    const text = await response.text();
    expect(text).toContain("Pre-cutover warm-up gate:");
    expect(text).toContain("published CMS pages");
    // The exact line `run_warmup_gate_for_service` greps for. If this changes, the
    // deploy script refuses every cutover.
    expect(text.trimEnd().endsWith("WARMUP-GATE-VERDICT: pass")).toBe(true);
  });

  test("refuses a malformed tolerance rather than widening it", async ({
    request,
  }) => {
    const response = await request.get(
      `${WARMUP_PATH}?format=json&maxFailedCmsPercent=1000`,
      { headers: { "x-cron-secret": cronSecret as string } },
    );

    expect(response.status()).toBe(400);

    const report = (await response.json()) as WarmupReport;
    expect(report.verdict).toBe("blocked");
    expect(report.blockingReasons.join(" ")).toContain("maxFailedCmsPercent");
  });

  test("names the refused setting in the text form the deploy script reads", async ({
    request,
  }) => {
    // The text form answers 200 on a refusal, deliberately: the deploy script asks it
    // with busybox `wget`, which discards the body of any non-2xx response. A 400
    // therefore reached the deploy script as an empty report and the operator was told
    // "the warm-up gate could not be read" — pointing them at the container, the
    // network and the cron secret rather than at the setting they had just mistyped.
    const response = await request.get(
      `${WARMUP_PATH}?format=text&concurrency=0`,
      { headers: { "x-cron-secret": cronSecret as string } },
    );

    expect(response.status()).toBe(200);

    const text = await response.text();
    expect(text).toContain("concurrency must be between 1 and 8");
    // The refusal itself is unchanged: the script gates on this line, not the status.
    expect(text.trimEnd().endsWith("WARMUP-GATE-VERDICT: blocked")).toBe(true);
  });

  test("proves the store from x-nextjs-cache, which a MISS cannot satisfy", async ({
    request,
  }) => {
    // A real ISR response carries `x-nextjs-prerender: 1` whether it hit or missed, so
    // this is the assertion that separates "the page was reused" from "a
    // prerender-capable route replied". Read off the release directly, because the gate
    // reporting a pass is exactly what must not be trusted here.
    const first = await request.get("/", { maxRedirects: 0 });
    expect(first.status()).toBe(200);

    const cmsPath = "/about";
    await request.get(cmsPath, { maxRedirects: 0 });
    const second = await request.get(cmsPath, { maxRedirects: 0 });

    expect(second.status()).toBe(200);
    const cache = second.headers()["x-nextjs-cache"];
    expect(
      cache,
      "the ISR catch-all must report its cache result, or the gate has nothing to read",
    ).toBeDefined();
    expect(["HIT", "STALE"]).toContain(cache);
    // And the header that is NOT proof is present alongside it, which is the whole
    // reason it cannot be accepted as an equivalent.
    expect(second.headers()["x-nextjs-prerender"]).toBe("1");
  });
});

/**
 * Drafts are excluded at the SOURCE, shown on a real database.
 *
 * The probe page is created rather than borrowed for the reason
 * `e2e/static-cms-pages.spec.ts` records: `canUnpublishPage()` refuses to hide a
 * seeded system slug, so an admin-created page is the only kind the product allows
 * hiding — and the only kind an operator actually meets.
 */
test.describe("warm-up discovery and unpublished pages", () => {
  test.use({ storageState: storageStatePath(E2E_ADMIN.email) });
  test.beforeEach(() => {
    test.skip(!cronSecret, "needs the staging CRON_SECRET");
  });

  const PROBE_SLUG = "e2e-warmup-discovery-probe";
  const PROBE_PATH = `/${PROBE_SLUG}`;

  async function probePageId(request: APIRequestContext): Promise<string> {
    const created = await request.post("/api/admin/page-content", {
      data: {
        slug: PROBE_SLUG,
        caption: "Warm-up probe",
        menuTitle: "",
        title: "Warm-up probe",
        headerText: "",
        sortOrder: 9001,
      },
    });

    if (created.status() === 201) {
      return ((await created.json()) as { page: { id: string } }).page.id;
    }

    expect(
      created.status(),
      "the probe page must be creatable or present",
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

  test("warms a published page and stops warming it once it is hidden", async ({
    request,
  }) => {
    const id = await probePageId(request);

    try {
      await setPublished(request, id, true);
      const published = await runGate(request, "&concurrency=2");
      expect(published.verdict).toBe("pass");
      expect(
        published.counts.cmsCacheVerified,
        "a page created after the build must still be generated on demand and stored",
      ).toBe(published.counts.cmsDiscovered);
      const withProbe = published.counts.cmsDiscovered;

      await setPublished(request, id, false);
      const hidden = await runGate(request, "&concurrency=2");
      expect(hidden.verdict).toBe("pass");
      expect(
        hidden.counts.cmsDiscovered,
        "a hidden page must drop out of discovery, not be warmed and tolerated",
      ).toBe(withProbe - 1);
      expect(hidden.failures).toEqual([]);
    } finally {
      await setPublished(request, id, false);
    }
  });
});
