import { prisma } from "@/lib/prisma";
import {
  buildClubThemeCss,
  CLUB_THEME_ID,
  DEFAULT_CLUB_THEME_VALUES,
  getContrastWarnings,
  normaliseThemeValues,
  type ClubThemeUpdateInput,
} from "@/lib/club-theme-schema";

export async function ensureClubTheme() {
  return prisma.clubTheme.upsert({
    where: { id: CLUB_THEME_ID },
    create: {
      id: CLUB_THEME_ID,
      ...DEFAULT_CLUB_THEME_VALUES,
    },
    update: {},
  });
}

export async function getClubThemeForAdmin() {
  const theme = await ensureClubTheme();
  const values = normaliseThemeValues(theme);
  return {
    ...values,
    completedAt: theme.completedAt?.toISOString() ?? null,
    contrastWarnings: getContrastWarnings(values),
  };
}

export async function saveClubTheme(input: ClubThemeUpdateInput) {
  const existing = await prisma.clubTheme.findUnique({
    where: { id: CLUB_THEME_ID },
    select: { completedAt: true },
  });
  const completedAt = input.completeSetup
    ? existing?.completedAt ?? new Date()
    : existing?.completedAt ?? null;

  const data = {
    brandGold: input.brandGold,
    brandCharcoal: input.brandCharcoal,
    brandDeep: input.brandDeep,
    brandRidge: input.brandRidge,
    brandMist: input.brandMist,
    brandSnow: input.brandSnow,
    brandSafety: input.brandSafety,
    headingFontKey: input.headingFontKey,
    bodyFontKey: input.bodyFontKey,
    logoDataUrl: input.logoDataUrl,
    completedAt,
  };

  const theme = await prisma.clubTheme.upsert({
    where: { id: CLUB_THEME_ID },
    create: {
      id: CLUB_THEME_ID,
      ...data,
    },
    update: data,
  });

  const values = normaliseThemeValues(theme);
  return {
    ...values,
    completedAt: theme.completedAt?.toISOString() ?? null,
    contrastWarnings: getContrastWarnings(values),
  };
}

export async function getWebsiteThemeRenderState() {
  const theme = await prisma.clubTheme
    .findUnique({
      where: { id: CLUB_THEME_ID },
    })
    .catch(() => null);
  const values = normaliseThemeValues(theme ?? DEFAULT_CLUB_THEME_VALUES);

  return {
    values,
    css: buildClubThemeCss(values),
    logoDataUrl: values.logoDataUrl,
    isComplete: Boolean(theme?.completedAt),
  };
}

export async function isClubThemeComplete() {
  const theme = await prisma.clubTheme
    .findUnique({
      where: { id: CLUB_THEME_ID },
      select: { completedAt: true },
    })
    .catch(() => null);

  return Boolean(theme?.completedAt);
}
