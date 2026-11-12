import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";

const harness = vi.hoisted(() => ({
  pollPending: undefined as undefined | (() => Promise<void>),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({ default: {
  existsSync: harness.existsSync,
  readFileSync: harness.readFileSync,
  mkdirSync: harness.mkdirSync,
  writeFileSync: harness.writeFileSync,
} }));

// Execute the helper's actual branching and form interactions. Only Playwright's
// assertions and Page are replaced: no browser, storage files or auth service.
vi.mock("@playwright/test", () => {
  type Locator = { value: string; isVisible: () => Promise<boolean> };
  const assertion = (actual: unknown) => ({
    toPass: async () => { await (actual as () => Promise<void>)(); },
    toHaveValue: async (value: string) => expect((actual as Locator).value).toBe(value),
    toHaveCount: async (count: number) => expect(count).toBe(1),
    toBeVisible: async () => expect(await (actual as Locator).isVisible()).toBe(true),
    toBeGreaterThan: (value: number) => expect(actual).toBeGreaterThan(value),
    toHaveURL: async (pattern: RegExp) => expect((actual as Page).url()).toMatch(pattern),
    not: { toHaveText: async () => {} },
  });
  return { expect: Object.assign(assertion, {
    poll: (probe: () => Promise<string>, options: { message: string }) => ({
      not: { toBe: async (pending: string) => {
        // Bounded deterministic retries: the test controls when navigation and
        // DOM rendering proceed, instead of relying on elapsed time or sleeps.
        for (let attempt = 0; attempt < 4; attempt++) {
          if (await probe() !== pending) return;
          await harness.pollPending?.();
        }
        throw new Error(options.message);
      } },
    }),
  }) };
});

import { loginPersona, signIn, submitLoginForm } from "../../../e2e/helpers/auth";

const EMAIL = "scoped@demo.alpineclub.test";
const SECRET = "JBSWY3DPEHPK3PXP";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function mockPage(initialPath: string, destination = "/admin/payments") {
  let pathname = "/login";
  let authenticated = false;
  let recovery = false;
  let challengeVisible = true;
  const clicks: string[] = [];
  const fills = new Map<string, string>();
  const locator = (name: string, role?: string) => {
    const result = {
      get value() { return fills.get(name) ?? ""; },
      first: () => result,
      filter: () => result,
      waitFor: async () => {},
      fill: async (value: string) => { fills.set(name, value); },
      innerText: async () => SECRET,
      allInnerTexts: async () => ["recovery-code"],
      isVisible: async () => {
        if (name === "Set up two-factor authentication") return (!role || role === "heading")
          && challengeVisible && new URL(page.url()).pathname === "/login/enroll";
        // Verify uses CardTitle without headingLevel: it is text, not a heading.
        if (name === "Verify your sign-in") return !role
          && challengeVisible && new URL(page.url()).pathname === "/login/verify";
        if (name === "Save your recovery codes") return recovery;
        if (name === ".app-brand-mark, .theme-aware-kiosk") return authenticated;
        return false;
      },
      click: async () => {
        clicks.push(name);
        if (name === "Sign in") pathname = initialPath;
        if (name === "Enroll") recovery = true;
        if (name === "Verify" || name === "Continue") pathname = destination;
      },
    };
    return result;
  };
  const page = {
    setExtraHTTPHeaders: vi.fn(async () => {}),
    context: () => ({ clearCookies: vi.fn(async () => {}) }),
    goto: vi.fn(async (url: string) => { pathname = new URL(url, "http://local.test").pathname; }),
    url: () => `http://local.test${pathname}`,
    locator,
    getByRole: (role: string, options: { name: string }) => locator(options.name, role),
    getByText: (name: string) => locator(name),
    getByLabel: (name: string) => locator(name),
    waitForURL: vi.fn(async (predicate: RegExp | ((url: URL) => boolean), options?: { timeout: number }) => {
      const url = new URL(page.url());
      if (!(typeof predicate === "function" ? predicate(url) : predicate.test(url.href))) {
        throw new Error(`URL did not settle within ${options?.timeout ?? "default"}ms`);
      }
    }),
  };
  return {
    page: page as unknown as Page,
    clicks,
    fills,
    navigate: (path: string) => { pathname = path; },
    renderAuthenticated: () => { authenticated = true; },
    setChallengeVisible: (visible: boolean) => { challengeVisible = visible; },
  };
}

beforeEach(() => {
  harness.pollPending = undefined;
  harness.existsSync.mockReturnValue(true);
  harness.readFileSync.mockReturnValue(JSON.stringify({ secret: SECRET, recoveryCodes: [] }));
});

describe("settled E2E persona sign-in (#4020)", () => {
  it("waits through an intermediate dashboard, answers delayed verification, and waits for the authenticated render", async () => {
    const browser = mockPage("/dashboard");
    const waiting = deferred();
    const challenge = deferred();
    const destinationWaiting = deferred();
    const destination = deferred();
    let polls = 0;
    harness.pollPending = async () => {
      if (++polls === 1) {
        waiting.resolve();
        await challenge.promise;
        browser.navigate("/login/verify?callbackUrl=%2Fadmin%2Fpayments");
      } else {
        destinationWaiting.resolve();
        await destination.promise;
        browser.renderAuthenticated();
      }
    };
    let settled = false;
    const login = loginPersona(browser.page, EMAIL).then(() => { settled = true; });
    // The old one-shot URL branch returns immediately here, so this race fails
    // without hanging the suite when the settling guard is removed.
    expect(await Promise.race([waiting.promise.then(() => "waiting"), login.then(() => "returned")])).toBe("waiting");
    expect(settled).toBe(false);
    expect(browser.clicks).toEqual(["Sign in"]);
    challenge.resolve();
    await destinationWaiting.promise;
    expect(browser.clicks).toEqual(["Sign in", "Verify"]);
    expect(browser.fills.get("#two-factor-code")).toMatch(/^\d{6}$/);
    expect(settled).toBe(false);
    destination.resolve();
    await login;
    expect(browser.page.url()).toBe("http://local.test/admin/payments");
  });

  it.each(["/login/enroll", "/login/verify"])("completes %s before returning", async (path) => {
    const browser = mockPage(path);
    harness.pollPending = async () => { browser.renderAuthenticated(); };
    await loginPersona(browser.page, EMAIL);
    expect(browser.clicks).toEqual(path.endsWith("enroll")
      ? ["Sign in", "Enroll", "Continue"] : ["Sign in", "Verify"]);
    expect(browser.page.url()).toBe("http://local.test/admin/payments");
    if (path.endsWith("enroll")) expect(harness.writeFileSync).toHaveBeenCalledOnce();
  });

  it("re-enters the verified destination through the server gate before accepting a scoped layout", async () => {
    const browser = mockPage("/login/verify", "/dashboard");
    vi.mocked(browser.page.goto).mockImplementation(async (url) => {
      const path = new URL(url, "http://local.test").pathname;
      browser.navigate(path);
      if (path === "/dashboard") {
        // The server gate redirects a lodge-only account; the client shell
        // itself never rendered an authenticated marker.
        browser.navigate("/lodge/kiosk");
        browser.renderAuthenticated();
      }
      return null;
    });
    await loginPersona(browser.page, EMAIL);
    expect(browser.page.goto).toHaveBeenNthCalledWith(2, "http://local.test/dashboard");
    expect(browser.page.url()).toBe("http://local.test/lodge/kiosk");
    expect(browser.clicks).toEqual(["Sign in", "Verify"]);
  });

  it("refuses a destination that the server gate returns to a challenge", async () => {
    const browser = mockPage("/login/verify", "/dashboard");
    vi.mocked(browser.page.goto).mockImplementation(async (url) => {
      const path = new URL(url, "http://local.test").pathname;
      browser.navigate(path === "/dashboard" ? "/login/verify" : path);
      return null;
    });
    await expect(loginPersona(browser.page, EMAIL)).rejects.toThrow("Sign-in did not complete");
    expect(browser.clicks).toEqual(["Sign in", "Verify"]);
  });

  it.each(["/dashboard", "/admin/payments", "/finance", "/lodge/kiosk"])("preserves completed scoped landing %s", async (path) => {
    const browser = mockPage(path);
    browser.renderAuthenticated();
    await loginPersona(browser.page, EMAIL, "10.98.0.1");
    expect(browser.page.url()).toBe(`http://local.test${path}`);
    expect(browser.clicks).toEqual(["Sign in"]);
    expect(browser.page.setExtraHTTPHeaders).toHaveBeenCalledWith({ "x-forwarded-for": "10.98.0.1" });
  });

  it("uses the same settled flow for signIn and retains Alice's destination assertion", async () => {
    const browser = mockPage("/login/verify", "/admin/dashboard");
    harness.pollPending = async () => { browser.renderAuthenticated(); };
    await signIn(browser.page, { email: EMAIL, firstName: "Alice", lastName: "Anderson" });
    expect(browser.clicks).toEqual(["Sign in", "Verify"]);
  });

  it("waits for challenge rendering before selecting its branch", async () => {
    const browser = mockPage("/login/verify");
    browser.setChallengeVisible(false);
    harness.pollPending = async () => {
      expect(browser.clicks).toEqual(["Sign in"]);
      browser.setChallengeVisible(true);
      browser.renderAuthenticated();
    };
    await loginPersona(browser.page, EMAIL);
    expect(browser.clicks).toEqual(["Sign in", "Verify"]);
  });

  it("retains signIn's rejection of a different completed landing", async () => {
    const browser = mockPage("/admin/payments");
    browser.renderAuthenticated();
    await expect(signIn(browser.page, { email: EMAIL, firstName: "Alice", lastName: "Anderson" }))
      .rejects.toThrow();
  });

  it("bounds a login form that never navigates", async () => {
    const browser = mockPage("/login");
    await expect(loginPersona(browser.page, EMAIL)).rejects.toThrow("URL did not settle within 15000ms");
    expect(browser.page.waitForURL).toHaveBeenCalledWith(expect.any(Function), { timeout: 15_000 });
  });

  it("fails when verification has no stored secret", async () => {
    const browser = mockPage("/login/verify");
    harness.existsSync.mockReturnValue(false);
    await expect(loginPersona(browser.page, EMAIL)).rejects.toThrow("no TOTP secret is stored");
    expect(browser.clicks).toEqual(["Sign in"]);
  });

  it.each(["/change-password", "/login/error", "/unexpected"])("does not accept incomplete or unexpected destination %s", async (path) => {
    const browser = mockPage(path);
    await expect(loginPersona(browser.page, EMAIL)).rejects.toThrow(/unexpected destination|never reached/);
    expect(browser.clicks).toEqual(["Sign in"]);
  });

  it("rejects a bounce back to login while the destination is settling", async () => {
    const browser = mockPage("/dashboard");
    harness.pollPending = async () => { browser.navigate("/login"); };
    await expect(loginPersona(browser.page, EMAIL)).rejects.toThrow("unexpected destination");
  });

  it("keeps submitLoginForm usable by forced-password-change specs", async () => {
    const browser = mockPage("/change-password");
    await submitLoginForm(browser.page, EMAIL);
    expect(browser.page.url()).toBe("http://local.test/change-password");
  });
});
