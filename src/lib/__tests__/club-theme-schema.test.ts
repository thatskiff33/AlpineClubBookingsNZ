import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLUB_THEME_VALUES,
  buildClubThemeCss,
  clubThemeUpdateSchema,
  contrastRatio,
  getContrastWarnings,
  isValidLogoDataUrl,
} from "@/lib/club-theme-schema";

const tinyPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

describe("club theme validation", () => {
  it("rejects CSS injection colours at save time", () => {
    const parsed = clubThemeUpdateSchema.safeParse({
      ...DEFAULT_CLUB_THEME_VALUES,
      brandGold: "#fff; background:url(https://example.test/a)",
      completeSetup: true,
    });

    expect(parsed.success).toBe(false);
  });

  it("neutralises unsafe stored values before emitting CSS", () => {
    const css = buildClubThemeCss({
      ...DEFAULT_CLUB_THEME_VALUES,
      brandGold: "red;--brand-deep:url(https://example.test/a)",
      headingFontKey: "INTER",
      bodyFontKey: "NOT_A_FONT",
    });

    expect(css).toContain(`--brand-gold:${DEFAULT_CLUB_THEME_VALUES.brandGold}`);
    expect(css).toContain("--font-website-body:var(--font-theme-inter)");
    expect(css).not.toContain("example.test");
    expect(css).not.toContain("NOT_A_FONT");
  });

  it("accepts capped image data URLs for logos", () => {
    expect(isValidLogoDataUrl(tinyPng)).toBe(true);
    expect(
      clubThemeUpdateSchema.safeParse({
        ...DEFAULT_CLUB_THEME_VALUES,
        logoDataUrl: tinyPng,
      }).success,
    ).toBe(true);
  });

  it("warns rather than blocks when key contrast pairs miss AA", () => {
    const warnings = getContrastWarnings({
      ...DEFAULT_CLUB_THEME_VALUES,
      brandDeep: "#ffffff",
      brandSnow: "#ffffff",
    });

    expect(contrastRatio("#000000", "#ffffff")?.toFixed(2)).toBe("21.00");
    expect(warnings.some((warning) => warning.id === "body-on-snow")).toBe(true);
  });
});
