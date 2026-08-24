import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The warm-up endpoint the deploy script calls (#2566).
 *
 * Everything below the handler is unit-tested in `src/lib/deploy/__tests__`; this
 * file covers the handler's own responsibilities — the guard, the parameters, the
 * pre-setup skip, the two response formats, and the refusal to run twice at once.
 */

const mocks = vi.hoisted(() => ({
  readPublicSiteOpenState: vi.fn(),
  discoverWarmupRoutes: vi.fn(),
  runWarmup: vi.fn(),
  isCmsPagePathPublished: vi.fn(),
}));

vi.mock("@/lib/health-check", () => ({
  getRuntimeStatus: () => ({
    cronEnabled: false,
    role: "web-green",
    // Kept complete against RuntimeStatusReport, as above.
    environmentRole: "production",
  }),
}));

vi.mock("@/lib/page-content-html", () => ({
  isCmsPagePathPublished: mocks.isCmsPagePathPublished,
}));

vi.mock("@/lib/deploy/warmup-discovery", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/deploy/warmup-discovery")
  >("@/lib/deploy/warmup-discovery");

  return {
    ...actual,
    readPublicSiteOpenState: mocks.readPublicSiteOpenState,
    discoverWarmupRoutes: mocks.discoverWarmupRoutes,
  };
});

vi.mock("@/lib/deploy/warmup-run", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/deploy/warmup-run")
  >("@/lib/deploy/warmup-run");

  return { ...actual, runWarmup: mocks.runWarmup };
});

import { GET } from "@/app/api/deploy/warmup/route";

const HOME = {
  path: "/",
  tier: "critical" as const,
  cacheClass: "render-only" as const,
  source: "critical-list" as const,
  why: "the home page",
};

function request(query = "", secret: string | null = "cron-secret") {
  return new NextRequest(`https://example.test/api/deploy/warmup${query}`, {
    headers: secret === null ? undefined : { "x-cron-secret": secret },
  });
}

function warmedHome() {
  return {
    route: HOME,
    rendered: true,
    cacheApplicable: false,
    cacheVerified: false,
    outcome: "warmed" as const,
    httpStatus: 200,
    cacheHeader: null,
    requests: 1,
    durationMs: 30,
  };
}

beforeEach(() => {
  process.env.CRON_SECRET = "cron-secret";
  process.env.NEXTAUTH_URL = "https://bookings.example.nz";
  process.env.RELEASE_ID = "9aeef8e8d001122334455667788990011223344";
  mocks.readPublicSiteOpenState.mockResolvedValue({ state: "open" });
  mocks.discoverWarmupRoutes.mockResolvedValue({
    plan: { routes: [HOME], excluded: [], problems: [], notes: [] },
    cmsSnapshotAt: "2026-08-03T09:00:00.000Z",
    cmsPathsInSnapshot: 0,
  });
  mocks.runWarmup.mockResolvedValue({
    results: [warmedHome()],
    deadlineExpired: false,
    durationMs: 1_000,
    peakConcurrency: 1,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.RELEASE_ID;
});

describe("GET /api/deploy/warmup", () => {
  it("refuses every request without the deploy secret", async () => {
    for (const secret of [null, "", "wrong-secret", "short"]) {
      const response = await GET(request("", secret));
      expect(response.status).toBe(401);
    }

    expect(mocks.runWarmup).not.toHaveBeenCalled();
  });

  it("returns the JSON report by default", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.verdict).toBe("pass");
    expect(body.serviceRole).toBe("web-green");
    expect(body.publicHost).toBe("bookings.example.nz");
    expect(body.origin).toBe("http://127.0.0.1:3000");
  });

  it("returns the operator summary, ending in the verdict sentinel, on request", async () => {
    const response = await GET(request("?format=text"));

    expect(response.headers.get("content-type")).toContain("text/plain");
    const text = await response.text();
    expect(text.trimEnd().endsWith("WARMUP-GATE-VERDICT: pass")).toBe(true);
  });

  it("passes the validated parameters through to the run", async () => {
    await GET(
      request(
        "?concurrency=4&requestTimeoutSeconds=30&totalTimeoutSeconds=600&maxFailedCmsRoutes=2&maxFailedCmsPercent=25",
      ),
    );

    expect(mocks.runWarmup).toHaveBeenCalledWith(
      [HOME],
      expect.objectContaining({
        origin: "http://127.0.0.1:3000",
        hostHeader: "bookings.example.nz",
        concurrency: 4,
        requestTimeoutMs: 30_000,
        totalTimeoutMs: 600_000,
      }),
    );

    const response = await GET(request("?maxFailedCmsPercent=25&format=json"));
    const body = await response.json();
    expect(body.tolerance).toEqual({
      maxFailedCmsRoutes: 1,
      maxFailedCmsPercent: 25,
    });
    expect(body.warnings.join(" ")).toContain("tolerance was widened");
  });

  it("refuses a malformed parameter rather than clamping it into something wider", async () => {
    for (const query of [
      "?concurrency=0",
      "?concurrency=99",
      "?concurrency=three",
      "?maxFailedCmsPercent=101",
      "?totalTimeoutSeconds=-5",
      "?expectedRelease=not-a-sha",
    ]) {
      const response = await GET(request(query));
      expect(response.status, query).toBe(400);
    }

    expect(mocks.runWarmup).not.toHaveBeenCalled();
  });

  it("blocks when the release does not match the one being deployed", async () => {
    const response = await GET(
      request("?expectedRelease=1111111111111111111111111111111111111111"),
    );

    const body = await response.json();
    expect(body.verdict).toBe("blocked");
    expect(body.releaseIdentity).toBe("mismatch");
  });

  it("skips rather than blocks while the club is still behind the setup screen", async () => {
    // The first deploy of a new club: every public address answers the 503 holding
    // screen, and the operator completes setup through the deployed site. Blocking
    // here could never be got past.
    mocks.readPublicSiteOpenState.mockResolvedValue({ state: "pre-setup" });

    const response = await GET(request("?format=text"));
    const text = await response.text();

    expect(text).toContain("SKIPPED:");
    expect(text.trimEnd().endsWith("WARMUP-GATE-VERDICT: skipped")).toBe(true);
    expect(mocks.runWarmup).not.toHaveBeenCalled();
  });

  it("blocks when it cannot tell whether the site is open", async () => {
    mocks.readPublicSiteOpenState.mockResolvedValue({ state: "unknown" });

    const body = await (await GET(request())).json();

    expect(body.verdict).toBe("blocked");
    expect(body.blockingReasons.join(" ")).toContain("site-style state");
  });

  it("blocks when the production host is not configured", async () => {
    delete process.env.NEXTAUTH_URL;

    const body = await (await GET(request())).json();

    expect(body.verdict).toBe("blocked");
    expect(body.blockingReasons.join(" ")).toContain("NEXTAUTH_URL");
  });

  it("blocks with a readable reason rather than throwing a 500", async () => {
    mocks.discoverWarmupRoutes.mockRejectedValue(new Error("unexpected"));

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.verdict).toBe("blocked");
    expect(body.blockingReasons.join(" ")).toContain(
      "warm-up gate itself failed",
    );
  });

  it("refuses a second concurrent run instead of doubling the CPU cost", async () => {
    let release: () => void = () => {};
    mocks.runWarmup.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              results: [warmedHome()],
              deadlineExpired: false,
              durationMs: 10,
              peakConcurrency: 1,
            });
        }),
    );

    const first = GET(request());
    const second = await GET(request());

    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.verdict).toBe("blocked");
    expect(body.blockingReasons.join(" ")).toContain("already in progress");

    release();
    expect((await first).status).toBe(200);
  });
});
