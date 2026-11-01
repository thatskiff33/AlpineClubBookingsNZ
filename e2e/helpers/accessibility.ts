import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { accessibilityAllowlist } from "./accessibility-allowlist";

export { expect };
// Named, not `export type *`: Semgrep's TypeScript parser skips that form, and
// the coverage gate refuses a partially parsed file. Add a type here when a spec needs it.
export type { APIRequestContext, APIResponse, Browser, BrowserContext, Locator, Page, Response } from "@playwright/test";

// Instrument browser.newContext as well as the default page: many journeys
// create their own contexts in beforeAll (and keep them between tests).
const pages = new Set<Page>();
const reports: Array<{ url: string; result?: Awaited<ReturnType<AxeBuilder["analyze"]>>; error?: string }> = [];
const pendingScans = new WeakMap<Page, Promise<void>>();

async function scan(page: Page) {
  if (page.isClosed() || !/^https?:/.test(page.url())) return;
  const pending = pendingScans.get(page);
  if (pending) return pending;
  const audit = scanPage(page);
  pendingScans.set(page, audit);
  try {
    await audit;
  } finally {
    pendingScans.delete(page);
  }
}

// Let FINITE CSS transitions and animations finish before measuring: a toast
// fading in or a dialog overlay fading out is caught at partial opacity, and
// axe then reports the half-faded colours as a contrast failure the settled
// page does not have. Infinite animations (spinners) are left alone, and the
// wait is capped so it can never hold a journey up. Not a sleep: it resolves
// the moment the last transition ends.
const ANIMATION_SETTLE_CAP_MS = 2_000;
async function settleAnimations(page: Page) {
  await page.evaluate(async (capMs) => {
    const finite = document.getAnimations().filter((animation) =>
      animation.playState === "running" &&
      Number.isFinite(Number(animation.effect?.getComputedTiming().endTime ?? Infinity)));
    if (finite.length === 0) return;
    await Promise.race([
      Promise.all(finite.map((animation) => animation.finished.catch(() => undefined))),
      new Promise((resolve) => setTimeout(resolve, capMs)),
    ]);
  }, ANIMATION_SETTLE_CAP_MS);
}

// Next streams a route's metadata: after an in-app navigation the old <title>
// is removed and the new one arrives a few hundred milliseconds later, so an
// audit in that window reports document-title on a page that has one. Wait,
// capped, for a title; a page that really has none is still audited and fails.
async function settleTitle(page: Page) {
  await page
    .waitForFunction(() => document.title.trim() !== "", undefined, { timeout: ANIMATION_SETTLE_CAP_MS })
    .catch(() => undefined);
}

async function scanPage(page: Page) {
  const url = page.url();
  try {
    await page.waitForLoadState("domcontentloaded");
    await settleTitle(page);
    await settleAnimations(page);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
      .analyze();
    const pathname = new URL(url).pathname;
    const violations = result.violations.filter((violation) =>
      (violation.impact === "serious" || violation.impact === "critical") &&
      !accessibilityAllowlist.some((entry) => entry.rule === violation.id && entry.page === pathname),
    );
    if (violations.length) reports.push({ url, result });
  } catch (error) {
    // A concurrent navigation invalidates axe's execution context. The next
    // settled interaction/teardown audits the destination again.
    if (page.isClosed() || page.url() !== url) return;
    reports.push({ url, error: String(error) });
  }
}

const locatorActions = new Set(["click", "dblclick", "press", "fill", "check", "uncheck", "selectOption", "tap"]);
function instrumentLocator(locator: Locator, page: Page): Locator {
  return new Proxy(locator, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const invoke = () => {
          const result = Reflect.apply(value, target, args);
          return result && typeof result === "object" && "allTextContents" in result
            ? instrumentLocator(result as Locator, page) : result;
        };
        // Scan BEFORE the next action, after the preceding assertions have
        // settled streaming content. Do not introduce sleeps or networkidle.
        return locatorActions.has(String(key)) ? scan(page).then(invoke) : invoke();
      };
    },
  });
}

function instrumentPage(page: Page) {
  if (pages.has(page)) return;
  pages.add(page);
  page.on("close", () => pages.delete(page));
  for (const key of ["goto", "reload", "goBack", "goForward"] as const) {
    const navigate = page[key].bind(page);
    Object.defineProperty(page, key, {
      configurable: true,
      value: async (...args: unknown[]) => {
        await scan(page);
        const result = await Reflect.apply(navigate, page, args);
        // The next action or teardown checks the destination once the journey's
        // assertions have settled it, rather than auditing a Suspense placeholder.
        return result;
      },
    });
  }
  const close = page.close.bind(page);
  page.close = async (...args) => {
    await scan(page);
    await close(...args);
    pages.delete(page);
  };
  for (const key of ["locator", "getByRole", "getByText", "getByLabel", "getByTestId", "getByPlaceholder", "getByTitle", "getByAltText"] as const) {
    const original = page[key].bind(page);
    // All these factories return a Locator; their argument overloads differ.
    Object.defineProperty(page, key, {
      configurable: true,
      value: (...args: unknown[]) => instrumentLocator(Reflect.apply(original, page, args), page),
    });
  }
}

function instrumentContext(context: BrowserContext) {
  context.pages().forEach(instrumentPage);
  context.on("page", instrumentPage); // Includes popups and manually created pages.
  const close = context.close.bind(context);
  context.close = async (...args) => {
    for (const page of context.pages()) await scan(page);
    await close(...args);
  };
}

export const test = base.extend<{ accessibilityAudit: void }, { browser: Browser }>({
  browser: [async ({ browser }, use) => {
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
      const context = await newContext(...args);
      instrumentContext(context);
      return context;
    };
    await use(browser);
    browser.newContext = newContext;
  }, { scope: "worker" }],
  accessibilityAudit: [async ({}, use, testInfo) => {
    await use();
    for (const page of pages) await scan(page);
    const failures = reports.splice(0);
    if (failures.length) {
      await testInfo.attach("axe-report", {
        body: JSON.stringify(failures, null, 2),
        contentType: "application/json",
      });
      expect(failures, "Serious/critical WCAG violations or axe errors; see axe-report attachment").toEqual([]);
    }
  }, { auto: true }],
});
