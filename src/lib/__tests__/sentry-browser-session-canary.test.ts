import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBrowserSentryInit } from "@/lib/__tests__/helpers/sentry-init-files";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

/**
 * A canary bound to the INSTALLED Sentry SDK (#5262).
 *
 * `src/instrumentation-client.ts` keeps browser Sentry to release tagging only
 * by dropping one default integration BY NAME. `sentry-release.test.ts` proves
 * the filter against hand-typed stand-in names, so it stays green if a Sentry
 * upgrade renames that integration or starts sessions somewhere else, and the
 * browser would then send a session report on every page load again while the
 * docs still say it is off. This suite reads the real package instead, so that
 * upgrade goes red here and someone re-reads the SDK.
 *
 * Nothing is initialised and nothing is sent: the SDK's default integrations
 * are only constructed and listed, and its build files are only read.
 */

type Integration = { name: string };
type InstalledBrowserSdk = {
  SDK_VERSION: string;
  init: unknown;
  getDefaultIntegrations: (options: object) => Integration[];
  breadcrumbsIntegration: (options?: object) => Integration;
};
type InstalledPackage = { name: string; root: string; version: string; require: NodeJS.Require };

/**
 * What the installed @sentry/browser calls its session integration. Held here,
 * apart from the app's own constant, on purpose: the first test fails if the
 * SDK stops using this name, the second if the app stops dropping it.
 */
const SESSION_INTEGRATION = "BrowserSession";

/** A call that opens a session or sends one (`@sentry/core`'s two entry points). */
const SESSION_CALL = /\b(?:startSession|captureSession)\s*\(/;

/**
 * One installed package, found with Node's own resolver from the file that
 * depends on it. `vi.mock` does not reach a `createRequire` load, and pnpm
 * links only a package's declared dependencies, so each hop lands on the
 * version the hop before it really runs with.
 */
function installedPackage(name: string, from: string): InstalledPackage {
  const entry = createRequire(from).resolve(name);
  let root = path.dirname(entry);
  for (;;) {
    const manifest = path.join(root, "package.json");
    if (existsSync(manifest)) {
      const { name: found, version } = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (found === name && version) return { name, root, version, require: createRequire(entry) };
    }
    const parent = path.dirname(root);
    if (parent === root) throw new Error(`No package.json for ${name} above ${entry}`);
    root = parent;
  }
}

// The chain the browser bundle follows: the app depends on @sentry/nextjs,
// whose client build takes its default integrations from @sentry/react, which
// re-exports @sentry/browser's; @sentry/browser-utils holds the browser hooks.
const nextjs = installedPackage("@sentry/nextjs", import.meta.url);
const react = installedPackage("@sentry/react", path.join(nextjs.root, "package.json"));
const browser = installedPackage("@sentry/browser", path.join(react.root, "package.json"));
const browserUtils = installedPackage("@sentry/browser-utils", path.join(browser.root, "package.json"));

/** The real module the Next client build calls `getDefaultIntegrations` on. */
const installedSdk = () => nextjs.require("@sentry/react") as InstalledBrowserSdk;

// Only `init` is replaced, so no client is created. The app's own breadcrumbs
// integration is built by the installed SDK, as it is in the browser.
const sentryInit = vi.hoisted(() => vi.fn());
vi.mock("@sentry/nextjs", () => ({
  init: sentryInit,
  breadcrumbsIntegration: (options: object) => installedSdk().breadcrumbsIntegration(options),
  captureRouterTransitionStart: () => undefined,
}));

/** The `integrations` function the app hands `Sentry.init` in the browser. */
async function appIntegrations(): Promise<(defaults: Integration[]) => Integration[]> {
  vi.resetModules();
  sentryInit.mockClear();
  await loadBrowserSentryInit();
  expect(sentryInit).toHaveBeenCalledTimes(1);
  const { integrations } = sentryInit.mock.calls[0][0] as { integrations?: unknown };
  expect(typeof integrations).toBe("function");
  return integrations as (defaults: Integration[]) => Integration[];
}

const names = (integrations: Integration[]) => integrations.map((integration) => integration.name);

describe("the installed Sentry SDK still matches the browser's tagging-only filter (#5262)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("loads the real SDK, at the version the app depends on, not the mock", () => {
    const pinned = (
      JSON.parse(readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      }
    ).dependencies["@sentry/nextjs"];
    expect(nextjs.version).toBe(pinned);
    expect([react.version, browser.version, browserUtils.version]).toEqual([pinned, pinned, pinned]);
    const sdk = installedSdk();
    expect(sdk.SDK_VERSION).toBe(pinned);
    expect(vi.isMockFunction(sdk.init)).toBe(false);
    expect(sdk.init).not.toBe(sentryInit);
  });

  it("the SDK's browser defaults still carry the session integration under the name the app drops", () => {
    expect(names(installedSdk().getDefaultIntegrations({}))).toContain(SESSION_INTEGRATION);
  });

  it("the app's own filter removes it from the SDK's real defaults, and removes nothing else", async () => {
    const integrations = await appIntegrations();
    const defaults = names(installedSdk().getDefaultIntegrations({}));
    const resolved = names(integrations(installedSdk().getDefaultIntegrations({})));
    expect(resolved).not.toContain(SESSION_INTEGRATION);
    // Breadcrumbs is replaced by the app's own, so it is in both lists.
    expect(defaults.filter((name) => !resolved.includes(name))).toEqual([SESSION_INTEGRATION]);
  });

  // A session can only start through one of two @sentry/core calls. If a later
  // SDK makes either from another client file, dropping `BrowserSession` no
  // longer turns sessions off, whatever the integration is called. Scanned
  // whole: every build of the four packages the browser bundle draws on.
  // @sentry/core itself is left out (it defines both calls), and so is the
  // server's request-session counting, which goes through neither.
  it("only the session integration's own file starts or sends a session in the client packages", () => {
    const callers: { file: string; source: string }[] = [];
    for (const { name, root } of [nextjs, react, browser, browserUtils]) {
      const build = path.join(root, "build");
      const files = (readdirSync(build, { recursive: true }) as string[]).filter((file) =>
        /\.(?:js|mjs|cjs)$/.test(file),
      );
      expect(files.length, `${name} build files`).toBeGreaterThan(10);
      for (const file of files) {
        const source = readFileSync(path.join(build, file), "utf8");
        if (SESSION_CALL.test(source)) {
          callers.push({ file: `${name}/build/${file.split(path.sep).join("/")}`, source });
        }
      }
    }
    expect(callers.length).toBeGreaterThan(0);
    const sessionFile = /^@sentry\/browser\/build\/.+\/integrations\/browsersession\.js$/;
    expect(callers.map(({ file }) => file).filter((file) => !sessionFile.test(file))).toEqual([]);
    // And that file is the one that names the integration the app drops.
    const namesIt = new RegExp(`name:\\s*["']${SESSION_INTEGRATION}["']`);
    expect(callers.filter(({ source }) => !namesIt.test(source)).map(({ file }) => file)).toEqual([]);
  }, CENSUS_TIMEOUT_MS);
});
