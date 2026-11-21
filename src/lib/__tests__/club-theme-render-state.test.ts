import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getWebsiteThemeRenderState()` must distinguish "the club has not finished
 * setup" from "the database did not answer" (#2420 review finding F4).
 *
 * Both used to arrive as `isComplete: false`. That is harmless for the theme
 * VALUES — the fallback palette is right either way — but not for the callers
 * that turn the flag into a statement about the club. `(website)/layout.tsx`
 * paints "Site setup in progress" from it, with a 200, on a page (`/`) that is
 * allow-listed as anonymously cacheable for 60 seconds and stale-servable for
 * 300. A two-second database blip on a club that launched years ago therefore
 * pinned a launch-state lie into every anonymous visitor's cache.
 */

const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { clubTheme: { findUnique: mocks.findUnique } },
}));

vi.mock("@/lib/club-theme-schema", async (importOriginal) => {
  const actual = await importOriginal<typeof ClubThemeSchema>();
  return {
    ...actual,
    buildClubThemeCss: vi.fn(actual.buildClubThemeCss),
    buildClubThemeAppCss: vi.fn(actual.buildClubThemeAppCss),
  };
});

import type * as ClubThemeSchema from "@/lib/club-theme-schema";
import {
  buildClubThemeAppCss,
  buildClubThemeCss,
} from "@/lib/club-theme-schema";
import {
  getWebsiteThemeRenderState,
  readSetupCompletion,
  resetThemeStylesheetCache,
} from "@/lib/club-theme";

beforeEach(() => {
  vi.clearAllMocks();
  resetThemeStylesheetCache();
});

describe("getWebsiteThemeRenderState", () => {
  it("reports a completed setup", async () => {
    mocks.findUnique.mockResolvedValue({ completedAt: new Date() });

    const state = await getWebsiteThemeRenderState();

    expect(state.isComplete).toBe(true);
    expect(state.readFailed).toBe(false);
  });

  it("reports an unfinished setup as a POSITIVE answer, not a failure", async () => {
    // The row exists and says completedAt IS NULL. This is the real pre-setup
    // state, and the one case where the holding screen is the truth.
    mocks.findUnique.mockResolvedValue({ completedAt: null });

    const state = await getWebsiteThemeRenderState();

    expect(state.isComplete).toBe(false);
    expect(state.readFailed).toBe(false);
  });

  it("treats a missing row as a positive answer too", async () => {
    // A club that has never saved a theme. The database answered; there is
    // simply nothing there yet.
    mocks.findUnique.mockResolvedValue(null);

    const state = await getWebsiteThemeRenderState();

    expect(state.isComplete).toBe(false);
    expect(state.readFailed).toBe(false);
  });

  it("flags a THROWN read separately, and still serves usable theme values", async () => {
    mocks.findUnique.mockRejectedValue(new Error("Can't reach database server"));

    const state = await getWebsiteThemeRenderState();

    expect(state.readFailed).toBe(true);
    expect(state.isComplete).toBe(false);
    // Unchanged for every caller that only wants a palette: the default theme
    // still renders, so a blip does not strip a page of its styling.
    expect(state.css).toContain("--brand-gold");
    expect(state.values).toBeTruthy();
  });
});

describe("the theme stylesheets are reused while the values are unchanged (#5264)", () => {
  // Generating them costs hundreds of milliseconds of CPU, and the public
  // chrome's cache refills this state every 15 seconds.
  it("builds each stylesheet once for repeated reads of the same theme", async () => {
    mocks.findUnique.mockResolvedValue({ brandGold: "#2a6f97" });

    const first = await getWebsiteThemeRenderState();
    const second = await getWebsiteThemeRenderState();

    expect(second.css).toBe(first.css);
    expect(second.appCss).toBe(first.appCss);
    expect(buildClubThemeCss).toHaveBeenCalledTimes(1);
    expect(buildClubThemeAppCss).toHaveBeenCalledTimes(1);
  });

  it("rebuilds as soon as any value changes", async () => {
    mocks.findUnique.mockResolvedValue({ brandGold: "#2a6f97" });
    const before = await getWebsiteThemeRenderState();

    mocks.findUnique.mockResolvedValue({
      brandGold: "#2a6f97",
      rawCss: ".site-header{letter-spacing:1px}",
    });
    const after = await getWebsiteThemeRenderState();

    expect(after.css).not.toBe(before.css);
    expect(after.css).toContain("letter-spacing:1px");
  });

  it("does not let a failed read evict the club's stylesheets", async () => {
    mocks.findUnique.mockResolvedValue({ brandGold: "#2a6f97" });
    const real = await getWebsiteThemeRenderState();

    mocks.findUnique.mockRejectedValueOnce(new Error("Can't reach database server"));
    const failed = await getWebsiteThemeRenderState();
    expect(failed.readFailed).toBe(true);

    vi.mocked(buildClubThemeCss).mockClear();
    vi.mocked(buildClubThemeAppCss).mockClear();
    const again = await getWebsiteThemeRenderState();

    expect(again.css).toBe(real.css);
    expect(buildClubThemeCss).not.toHaveBeenCalled();
    expect(buildClubThemeAppCss).not.toHaveBeenCalled();
  });
});

describe("readSetupCompletion (#5264)", () => {
  // The proxy's setup gate calls this on every refresh. On a live club it must
  // stay one narrow read: no logo, which can be 900 KB, and no CSS generation.
  it("selects completedAt alone and builds no CSS", async () => {
    mocks.findUnique.mockResolvedValue({ completedAt: new Date() });

    await expect(readSetupCompletion()).resolves.toEqual({
      readFailed: false,
      isComplete: true,
    });
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.findUnique.mock.calls[0][0]).toMatchObject({
      select: { completedAt: true },
    });
    expect(Object.keys(mocks.findUnique.mock.calls[0][0].select)).toEqual([
      "completedAt",
    ]);
    expect(buildClubThemeCss).not.toHaveBeenCalled();
    expect(buildClubThemeAppCss).not.toHaveBeenCalled();
  });

  it("reports an unfinished setup, or no row, as a positive answer", async () => {
    mocks.findUnique.mockResolvedValueOnce({ completedAt: null });
    await expect(readSetupCompletion()).resolves.toEqual({
      readFailed: false,
      isComplete: false,
    });

    mocks.findUnique.mockResolvedValueOnce(null);
    await expect(readSetupCompletion()).resolves.toEqual({
      readFailed: false,
      isComplete: false,
    });
  });

  it("reports a thrown read as a failure, not as 'not complete'", async () => {
    mocks.findUnique.mockRejectedValue(new Error("Can't reach database server"));

    await expect(readSetupCompletion()).resolves.toEqual({ readFailed: true });
  });
});
