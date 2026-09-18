import { expect, test, type Page } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";

// Issue #2146 — a finance manager or admin browsing in DARK mode printed or
// exported a report and got a page that looked blank.
//
// Every other guard on this behaviour is a source-text parser: the contract test
// `src/lib/__tests__/print-light-palette-contract.test.ts` reads globals.css and
// the TSX and reasons about the cascade. None of them ever RENDERS the page
// under print + dark and looks at a computed colour, which is the medium the bug
// actually lived in — the fix turns on a specificity subtlety (`text-card-fore-
// ground` on `ui/card.tsx` matching the element directly and so beating the
// print root's inherited `!important`) that no amount of source parsing settles.
//
// This spec closes that gap, and it also closes the gap the CSS parser
// structurally CANNOT see: a Tailwind `dark:` utility written in a class string
// compiles into Tailwind's own generated output, never into globals.css, so no
// `@media not print` wrapper there can exclude it. Here it is simply rendered.
//
// What this spec does NOT cover: the `html2canvas` **Download PDF** path in
// `src/lib/report-pdf.ts`. `emulateMedia` switches the print medium; it does
// not run html2canvas, and nothing here clicks Download PDF. That path's only
// coverage is the jsdom unit test over `forceLightPaletteInClone` plus a
// source-string check that the `onclone` hook is wired — the function and the
// wiring, not the html2canvas contract or the produced PDF. Verify a real
// export by hand in both themes when changing it.
//
// E2E_ADMIN is a Full Admin, so both printable report surfaces are reachable
// from the session saved once in auth.setup.ts (#1779).
test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

// next-themes storage key — `UI_THEME_STORAGE_KEY` in
// src/components/theme-switcher.tsx. Not imported: that module is a "use client"
// React component and pulling it into the Playwright node process would drag in
// next-themes and lucide for the sake of one string. If the key ever drifts, the
// `prefers-color-scheme` emulation below still resolves the app's
// `defaultTheme="system"` to dark, and the explicit `.dark` precondition in
// every case fails loudly rather than passing vacuously.
const UI_THEME_STORAGE_KEY = "alpine-ui-theme";

/**
 * Read the computed foreground and background of `selector` as WCAG relative
 * luminance (0 = black, 1 = white), evaluated in the page so the browser's own
 * media/colour-scheme emulation is what resolves the cascade.
 *
 * `background-color` walks up to the first non-transparent ancestor, because a
 * card's own background may be `transparent` with the paint coming from the
 * print root.
 *
 * The serialization is asserted to be `rgb()`/`rgba()` rather than parsed
 * leniently. `getComputedStyle` does NOT normalise every colour to sRGB: a
 * value specified in `oklch()` serializes back as `oklch(0.985 0 0)`, and this
 * stylesheet's raw `:root` / `.dark` ramps ARE oklch. Scraping `[\d.]+` out of
 * that string reads `0.985, 0, 0` as sRGB 0-255 channels and scores luminance
 * ≈ 0.00006 — so the literal near-white #2146 value would SATISFY the
 * `colorLuminance < 0.3` dark-ink assertion. Only the surfaces asserted today
 * happen to chain to hex `--brand-*`; one token change turns that silent false
 * pass on. Failing loudly with the raw string is the safe direction.
 */
async function readLuminance(page: Page, selector: string) {
  return page.evaluate((target) => {
    /** Numeric channels of an `rgb()`/`rgba()` serialization, else `null`. */
    const parseSrgb = (color: string): number[] | null => {
      const match = /^rgba?\(([^)]*)\)$/i.exec(color.trim());
      if (!match) return null;
      return (match[1] ?? "")
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
    };

    const relativeLuminance = (color: string): number => {
      const channels = parseSrgb(color);
      const [red, green, blue] = channels ?? [];
      if (
        !channels ||
        channels.some(Number.isNaN) ||
        red === undefined ||
        green === undefined ||
        blue === undefined
      ) {
        throw new Error(
          `#2146 luminance probe: expected getComputedStyle to serialize a ` +
            `colour as rgb()/rgba(), got "${color}". Modern colour syntaxes ` +
            `(oklch(), lab(), color()) serialize as-is and their 0-1 ` +
            `components would be misread as sRGB 0-255 channels, silently ` +
            `scoring a near-WHITE print colour as near-black and passing the ` +
            `dark-ink assertion. Teach this helper that syntax before ` +
            `re-enabling the assertion.`,
        );
      }
      const linear = (part: number) => {
        const channel = part / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
    };

    const element = document.querySelector(target);
    if (!element) throw new Error(`No element matched ${target}`);

    let backgroundSource: Element | null = element;
    let background = "rgba(0, 0, 0, 0)";
    while (backgroundSource) {
      const value = getComputedStyle(backgroundSource).backgroundColor;
      // A non-rgb serialization is NOT treated as transparent: it is taken as
      // the background so `relativeLuminance` reports it loudly rather than
      // letting the walk skip past an unparsed painted surface.
      const alpha = parseSrgb(value)?.[3];
      if (value !== "transparent" && alpha !== 0) {
        background = value;
        break;
      }
      backgroundSource = backgroundSource.parentElement;
    }

    return {
      color: getComputedStyle(element).color,
      backgroundColor: background,
      colorLuminance: relativeLuminance(getComputedStyle(element).color),
      backgroundLuminance: relativeLuminance(background),
      darkClassActive: document.documentElement.classList.contains("dark"),
    };
  }, selector);
}

/** Put the page in dark mode deterministically, before any navigation. */
async function useDarkTheme(page: Page) {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [UI_THEME_STORAGE_KEY, "dark"] as const,
  );
  await page.emulateMedia({ colorScheme: "dark" });
}

// Each surface is the same hazard: a `.reports-print-root` whose descendants set
// their own colour token directly. `/admin/reports` is asserted on a real
// `.reports-print-card`; `/finance` is asserted on its layout header card, which
// renders unconditionally (no report data required) and carries the exact
// `bg-card text-card-foreground` pairing that produced the blank export.
const SURFACES = [
  {
    name: "/admin/reports",
    path: "/admin/reports",
    // Rendered once the auto-fetch on mount resolves.
    selector: ".reports-print-card",
  },
  {
    name: "/finance",
    path: "/finance",
    selector: "main.reports-print-root > div:first-child",
  },
] as const;

for (const surface of SURFACES) {
  test(`${surface.name} prints the light palette while the app is in dark mode`, async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await useDarkTheme(page);
    await page.goto(surface.path);
    await expect(page.locator(surface.selector).first()).toBeVisible({
      timeout: 60_000,
    });

    // ── Anti-vacuity: dark mode must genuinely be ON for screen ──
    // Without this the whole spec could pass because the theme never applied.
    await page.emulateMedia({ media: "screen", colorScheme: "dark" });
    const onScreen = await readLuminance(page, surface.selector);
    expect(
      onScreen.darkClassActive,
      "next-themes must have applied the dark class",
    ).toBe(true);
    expect(
      onScreen.colorLuminance,
      `dark mode must render LIGHT text on screen (got ${onScreen.color})`,
    ).toBeGreaterThan(0.5);
    expect(
      onScreen.backgroundLuminance,
      `dark mode must render a DARK surface on screen (got ${onScreen.backgroundColor})`,
    ).toBeLessThan(0.3);

    // ── The regression itself: same page, print media, still dark mode ──
    await page.emulateMedia({ media: "print", colorScheme: "dark" });
    const onPaper = await readLuminance(page, surface.selector);
    expect(
      onPaper.darkClassActive,
      "the dark class must still be on <html> — print must win despite it, " +
        "not because the theme was switched off",
    ).toBe(true);
    expect(
      onPaper.colorLuminance,
      `#2146: printing in dark mode must give DARK ink (got ${onPaper.color}). ` +
        `Near-white text here is the blank-PDF bug.`,
    ).toBeLessThan(0.3);
    expect(
      onPaper.backgroundLuminance,
      `printing must give a LIGHT surface (got ${onPaper.backgroundColor})`,
    ).toBeGreaterThan(0.7);

    // ── The stated invariant: print NEVER sees dark mode ──
    // The printed page must look identical whichever theme the operator happens
    // to be browsing in. Dropping the theme class in place (rather than
    // re-emulating `prefers-color-scheme`, which would leave `.dark` on <html>
    // and make the comparison vacuous) is exactly the light-mode operator, so
    // any surviving difference IS a theme-dependent print rule.
    await page.evaluate(() =>
      document.documentElement.classList.remove("dark"),
    );
    const onPaperLight = await readLuminance(page, surface.selector);
    expect(onPaperLight.darkClassActive).toBe(false);
    expect(
      onPaper.color,
      "the same page must print the same ink in either theme",
    ).toBe(onPaperLight.color);
    expect(
      onPaper.backgroundColor,
      "the same page must print the same surface in either theme",
    ).toBe(onPaperLight.backgroundColor);
  });
}
