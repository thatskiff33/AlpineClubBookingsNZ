import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadBrowserSentryInit,
  SENTRY_INIT_FILES,
  type SentryInitFile,
} from "@/lib/__tests__/helpers/sentry-init-files";
import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { APP_VERSION_ENV_VAR, getAppVersion } from "@/lib/app-version";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

// Only `init` matters here: the tests read the options each runtime hands it.
const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  nativeNodeFetchIntegration: vi.fn(() => ({ name: "NodeFetch" })),
  breadcrumbsIntegration: vi.fn(() => ({ name: "Breadcrumbs" })),
  captureRouterTransitionStart: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => sentry);

const ROOT = path.resolve(__dirname, "../../..");

/** Imports one runtime's initialisation and resolves once `Sentry.init` has run. */
const LOADERS: Record<SentryInitFile, () => Promise<unknown>> = {
  "sentry.server.config.ts": () => import("../../../sentry.server.config"),
  "sentry.edge.config.ts": () => import("../../../sentry.edge.config"),
  "src/instrumentation-client.ts": loadBrowserSentryInit,
};

async function loadInitOptions(file: SentryInitFile): Promise<{ release?: string }> {
  vi.resetModules();
  await LOADERS[file]();
  expect(sentry.init).toHaveBeenCalledTimes(1);
  return sentry.init.mock.calls[0][0] as { release?: string };
}

describe("every Sentry runtime files its events under the build's version (#4985, #5262)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(SENTRY_INIT_FILES)("%s tags events with the stamped version", async (file) => {
    vi.stubEnv(APP_VERSION_ENV_VAR, "sentry-release-under-test");
    const options = await loadInitOptions(file);
    expect(options.release).toBe(getAppVersion());
    expect(options.release).toBe("sentry-release-under-test");
  });

  it.each(SENTRY_INIT_FILES)(
    "%s uses `unknown`, never a made-up version, when the build was not stamped",
    async (file) => {
      vi.stubEnv(APP_VERSION_ENV_VAR, "");
      const options = await loadInitOptions(file);
      expect(options.release).toBe("unknown");
    },
  );
});

/** Source files that could initialise Sentry: the repo root's own, and `src/` outside tests. */
function sourceFiles(): string[] {
  const rootFiles = readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name))
    .map((entry) => entry.name);
  const srcFiles = (readdirSync(path.join(ROOT, "src"), { recursive: true }) as string[])
    .map((file) => path.posix.join("src", file.split(path.sep).join("/")))
    .filter(
      (file) =>
        /\.(?:ts|tsx|js|mjs)$/.test(file) &&
        !/(?:^|\/)__tests__\//.test(file) &&
        !/\.(?:test|spec)\.[^/]+$/.test(file),
    );
  return [...rootFiles, ...srcFiles];
}

describe("the Sentry initialisation census (#5262)", () => {
  it("lists exactly the files that call Sentry.init, so none goes untested", () => {
    const callers = sourceFiles().filter((file) => {
      const source = stripComments(readFileSync(path.join(ROOT, file), "utf8"));
      // `Sentry.init(...)`, or `init(...)` taken as a named import from a Sentry package.
      const namedInit =
        /\bimport\s*\{[^}]*\binit\b[^}]*\}\s*from\s*["']@sentry\//.test(source) &&
        /(?<![.\w$])init\s*\(/.test(source);
      return /\bSentry\.init\s*\(/.test(source) || namedInit;
    });
    expect(callers.sort()).toEqual([...SENTRY_INIT_FILES].sort());
  }, CENSUS_TIMEOUT_MS);
});

describe("browser Sentry tags releases without session tracking (#5262)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("drops BrowserSession, so a release adds no per-page-load session ping", async () => {
    vi.clearAllMocks();
    const options = (await loadInitOptions("src/instrumentation-client.ts")) as {
      integrations?: unknown;
    };
    expect(typeof options.integrations).toBe("function");
    // Stand-ins for Sentry's browser defaults, named as @sentry/browser 11 names them.
    const defaults = ["InboundFilters", "Breadcrumbs", "BrowserSession", "Dedupe"].map(
      (name) => ({ name }),
    );
    const resolved = (options.integrations as (d: { name: string }[]) => { name: string }[])(
      defaults,
    );
    const names = resolved.map((integration) => integration.name);
    expect(names).not.toContain("BrowserSession");
    expect(names).toEqual(["InboundFilters", "Dedupe", "Breadcrumbs"]);
    expect(sentry.breadcrumbsIntegration).toHaveBeenCalledWith({
      dom: true,
      fetch: true,
      history: true,
    });
  });
});
