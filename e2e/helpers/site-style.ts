import { type APIRequestContext, expect } from "@playwright/test";

import type { ClubThemeValues } from "@/lib/club-theme-schema";

/**
 * Reading and writing the club theme (Admin > Site Appearance) over the real
 * admin API, for specs that need the club's Raw CSS to be something in
 * particular. Use an admin-authenticated request context.
 *
 * `PUT /api/admin/site-style` is strict, so a caller reads the whole theme,
 * changes what it needs and puts the whole thing back — and restores it
 * afterwards, because the theme is club-wide state every other spec renders
 * through.
 */

/** What `GET /api/admin/site-style` answers with, beyond the theme values. */
export type AdminClubTheme = ClubThemeValues & {
  completedAt: string | null;
};

export async function readClubTheme(
  request: APIRequestContext,
): Promise<AdminClubTheme> {
  const res = await request.get("/api/admin/site-style");
  expect(res.ok(), `GET /api/admin/site-style (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as { theme: AdminClubTheme };
  return body.theme;
}

/**
 * Put `base` back with a different `rawCss`. The empty-string fallbacks match the
 * schema, which accepts `""` or `null` for both logo fields and stores `null`.
 */
export async function writeClubRawCss(
  request: APIRequestContext,
  base: AdminClubTheme,
  rawCss: string,
): Promise<void> {
  const res = await request.put("/api/admin/site-style", {
    data: {
      brandGold: base.brandGold,
      brandDeep: base.brandDeep,
      brandSafety: base.brandSafety,
      headingFontKey: base.headingFontKey,
      bodyFontKey: base.bodyFontKey,
      logoUrl: base.logoUrl ?? "",
      logoDataUrl: base.logoDataUrl ?? "",
      rawCss,
    },
  });
  expect(res.ok(), `PUT /api/admin/site-style (${res.status()})`).toBeTruthy();
}
