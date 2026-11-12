import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SENTRY_BROWSER_CONFIG_PATH } from "@/lib/privacy-retention-replay";

const sentry = vi.hoisted(() => ({ init: vi.fn(), breadcrumbsIntegration: vi.fn(), captureRouterTransitionStart: vi.fn() }));
vi.mock("@sentry/nextjs", () => sentry);
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function boot() {
  const hooks = await import("@/instrumentation-client");
  const { browserSentryReady } = await import("@/lib/observability/browser-sentry-client");
  return { hooks, ready: browserSentryReady };
}

describe("browser Sentry runtime initialization", () => {
  it("waits for runtime config, initializes before replay can proceed, and keeps privacy options", async () => {
    let respond!: (value: Response) => void;
    const fetchConfig = vi.fn(() => new Promise<Response>(resolve => { respond = resolve; }));
    vi.stubGlobal("fetch", fetchConfig);
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", ""); // A generic image has no build-time destination.
    const { hooks, ready } = await boot();
    expect(sentry.init).not.toHaveBeenCalled();
    expect(fetchConfig).toHaveBeenCalledExactlyOnceWith(SENTRY_BROWSER_CONFIG_PATH, { cache: "no-store" });
    const dsn = "https://public@example.ingest.sentry.io/1";
    respond(new Response(JSON.stringify({ dsn })));
    expect(await ready).toBe(dsn);
    expect(sentry.init).toHaveBeenCalledOnce();
    const { SENTRY_PRIVACY_INIT_OPTIONS } = await import("@/lib/sentry-privacy-options");
    const options = sentry.init.mock.calls[0]![0];
    expect(options).toMatchObject({ ...SENTRY_PRIVACY_INIT_OPTIONS, dsn, replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0 });
    expect(options.beforeSend({ message: "hello" })).toEqual({ message: "hello" });
    expect(options.beforeSend({ message: "person@example.com" }).message).not.toContain("person@example.com");
    expect(options.beforeBreadcrumb).toEqual(expect.any(Function));
    expect(hooks.onRouterTransitionStart).toBe(sentry.captureRouterTransitionStart);
  });

  it.each([null, "", "   ", 123, undefined])("stays off for an absent or malformed DSN (%s)", async dsn => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ dsn }))));
    const { hooks, ready } = await boot();
    expect(await ready).toBeNull();
    expect(sentry.init).not.toHaveBeenCalled();
    expect(() => hooks.onRouterTransitionStart("/", "push")).not.toThrow();
  });

  it.each(["network", "http", "json"])("fails closed on a %s failure", async failure => {
    const fetchConfig = vi.fn();
    if (failure === "network") fetchConfig.mockRejectedValue(new Error("offline"));
    if (failure === "http") fetchConfig.mockResolvedValue(new Response("{}", { status: 503 }));
    if (failure === "json") fetchConfig.mockResolvedValue(new Response("not json"));
    vi.stubGlobal("fetch", fetchConfig);
    const { ready } = await boot();
    expect(await ready).toBeNull();
    expect(sentry.init).not.toHaveBeenCalled();
  });
});
