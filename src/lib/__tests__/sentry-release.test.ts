import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SENTRY_INIT_FILES,
  type SentryInitFile,
} from "@/lib/__tests__/helpers/sentry-init-files";
import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { APP_VERSION_ENV_VAR, getAppVersion } from "@/lib/app-version";

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
  "src/instrumentation-client.ts": async () => {
    // The browser initialises only after its runtime DSN arrives (#4982).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ dsn: "https://public@example.ingest.sentry.io/1" })),
      ),
    );
    await import("@/instrumentation-client");
    const { browserSentryReady } = await import("@/lib/observability/browser-sentry-client");
    await browserSentryReady;
  },
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
    const callers = sourceFiles().filter((file) =>
      /\bSentry\.init\s*\(/.test(stripComments(readFileSync(path.join(ROOT, file), "utf8"))),
    );
    expect(callers.sort()).toEqual([...SENTRY_INIT_FILES].sort());
  });
});
