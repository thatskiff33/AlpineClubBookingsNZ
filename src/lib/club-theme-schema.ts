import { z } from "zod";

export const CLUB_THEME_ID = "default";
export const MAX_LOGO_DATA_URL_BYTES = 900_000;

export const CLUB_THEME_COLOUR_FIELDS = [
  { key: "brandGold", label: "Gold" },
  { key: "brandCharcoal", label: "Charcoal" },
  { key: "brandDeep", label: "Deep" },
  { key: "brandRidge", label: "Ridge" },
  { key: "brandMist", label: "Mist" },
  { key: "brandSnow", label: "Snow" },
  { key: "brandSafety", label: "Safety" },
] as const;

export type ClubThemeColourKey = (typeof CLUB_THEME_COLOUR_FIELDS)[number]["key"];

export const CLUB_THEME_FONT_KEYS = [
  "INTER",
  "LEAGUE_SPARTAN",
  "LORA",
  "SOURCE_SERIF_4",
  "NUNITO_SANS",
] as const;

export type ClubThemeFontKey = (typeof CLUB_THEME_FONT_KEYS)[number];

export const CLUB_THEME_FONT_OPTIONS: Array<{
  key: ClubThemeFontKey;
  label: string;
  role: "Body" | "Heading" | "Flexible";
  cssVariable: string;
}> = [
  {
    key: "INTER",
    label: "Inter",
    role: "Body",
    cssVariable: "--font-theme-inter",
  },
  {
    key: "LEAGUE_SPARTAN",
    label: "League Spartan",
    role: "Heading",
    cssVariable: "--font-theme-league-spartan",
  },
  {
    key: "LORA",
    label: "Lora",
    role: "Heading",
    cssVariable: "--font-theme-lora",
  },
  {
    key: "SOURCE_SERIF_4",
    label: "Source Serif 4",
    role: "Heading",
    cssVariable: "--font-theme-source-serif-4",
  },
  {
    key: "NUNITO_SANS",
    label: "Nunito Sans",
    role: "Flexible",
    cssVariable: "--font-theme-nunito-sans",
  },
];

export type ClubThemeValues = Record<ClubThemeColourKey, string> & {
  headingFontKey: ClubThemeFontKey;
  bodyFontKey: ClubThemeFontKey;
  logoDataUrl: string | null;
};

export const DEFAULT_CLUB_THEME_VALUES: ClubThemeValues = {
  brandGold: "#7a8f6a",
  brandCharcoal: "#30343b",
  brandDeep: "#1f2933",
  brandRidge: "#65717b",
  brandMist: "#d7dde1",
  brandSnow: "#f8faf8",
  brandSafety: "#c2562c",
  headingFontKey: "LEAGUE_SPARTAN",
  bodyFontKey: "INTER",
  logoDataUrl: null,
};

export const TOKOROA_CLUB_THEME_VALUES: ClubThemeValues = {
  brandGold: "#ffcb05",
  brandCharcoal: "#4d4d46",
  brandDeep: "#2f2f2b",
  brandRidge: "#6a6a63",
  brandMist: "#d9d5c2",
  brandSnow: "#f7f5ed",
  brandSafety: "#ff7c12",
  headingFontKey: "LEAGUE_SPARTAN",
  bodyFontKey: "INTER",
  logoDataUrl: null,
};

const HEX_COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const OKLCH_NUMBER = "(?:0|[1-9]\\d*)(?:\\.\\d{1,4})?";
const OKLCH_LIGHTNESS = `(?:${OKLCH_NUMBER}|(?:0|[1-9]\\d|100)(?:\\.\\d{1,2})?%)`;
const OKLCH_CHROMA = OKLCH_NUMBER;
const OKLCH_HUE = "(?:0|[1-9]\\d{0,2}|3[0-5]\\d|360)(?:\\.\\d{1,2})?";
const OKLCH_COLOUR_PATTERN = new RegExp(
  `^oklch\\(${OKLCH_LIGHTNESS} ${OKLCH_CHROMA} ${OKLCH_HUE}\\)$`,
  "i",
);
const LOGO_DATA_URL_PATTERN =
  /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

export function isValidThemeColour(value: string): boolean {
  const trimmed = value.trim();
  return HEX_COLOUR_PATTERN.test(trimmed) || OKLCH_COLOUR_PATTERN.test(trimmed);
}

export function isHexColour(value: string): boolean {
  return HEX_COLOUR_PATTERN.test(value.trim());
}

export function logoDataUrlByteLength(value: string): number | null {
  const match = value.trim().match(LOGO_DATA_URL_PATTERN);
  if (!match) {
    return null;
  }

  const base64 = match[2];
  if (base64.length % 4 !== 0) {
    return null;
  }

  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

export function isValidLogoDataUrl(value: string): boolean {
  const byteLength = logoDataUrlByteLength(value);
  return byteLength !== null && byteLength <= MAX_LOGO_DATA_URL_BYTES;
}

const colourSchema = z
  .string()
  .trim()
  .refine(isValidThemeColour, "Use a 6-digit hex colour or exact oklch() value.");

const logoDataUrlSchema = z
  .string()
  .trim()
  .max(2_000_000)
  .refine(
    isValidLogoDataUrl,
    "Logo must be a PNG, JPEG, WebP, or GIF data URL no larger than 900KB.",
  );

export const clubThemeUpdateSchema = z
  .object({
    brandGold: colourSchema,
    brandCharcoal: colourSchema,
    brandDeep: colourSchema,
    brandRidge: colourSchema,
    brandMist: colourSchema,
    brandSnow: colourSchema,
    brandSafety: colourSchema,
    headingFontKey: z.enum(CLUB_THEME_FONT_KEYS),
    bodyFontKey: z.enum(CLUB_THEME_FONT_KEYS),
    logoDataUrl: z
      .union([logoDataUrlSchema, z.literal(""), z.null()])
      .transform((value) => value || null),
    completeSetup: z.boolean().optional(),
  })
  .strict();

export type ClubThemeUpdateInput = z.infer<typeof clubThemeUpdateSchema>;

function fontOption(fontKey: ClubThemeFontKey) {
  return CLUB_THEME_FONT_OPTIONS.find((font) => font.key === fontKey);
}

export function fontLabel(fontKey: ClubThemeFontKey): string {
  return fontOption(fontKey)?.label ?? fontKey;
}

export function fontCssVariable(fontKey: ClubThemeFontKey): string {
  return (
    fontOption(fontKey)?.cssVariable ??
    fontOption(DEFAULT_CLUB_THEME_VALUES.bodyFontKey)?.cssVariable ??
    "--font-theme-inter"
  );
}

export function sanitiseThemeColour(
  value: unknown,
  field: ClubThemeColourKey,
): string {
  return typeof value === "string" && isValidThemeColour(value)
    ? value.trim()
    : DEFAULT_CLUB_THEME_VALUES[field];
}

export function sanitiseThemeFont(value: unknown, fallback: ClubThemeFontKey) {
  return CLUB_THEME_FONT_KEYS.includes(value as ClubThemeFontKey)
    ? (value as ClubThemeFontKey)
    : fallback;
}

export function sanitiseLogoDataUrl(value: unknown): string | null {
  return typeof value === "string" && isValidLogoDataUrl(value) ? value.trim() : null;
}

export function normaliseThemeValues(
  value: Partial<Record<keyof ClubThemeValues, unknown>> | null | undefined,
): ClubThemeValues {
  return {
    brandGold: sanitiseThemeColour(value?.brandGold, "brandGold"),
    brandCharcoal: sanitiseThemeColour(value?.brandCharcoal, "brandCharcoal"),
    brandDeep: sanitiseThemeColour(value?.brandDeep, "brandDeep"),
    brandRidge: sanitiseThemeColour(value?.brandRidge, "brandRidge"),
    brandMist: sanitiseThemeColour(value?.brandMist, "brandMist"),
    brandSnow: sanitiseThemeColour(value?.brandSnow, "brandSnow"),
    brandSafety: sanitiseThemeColour(value?.brandSafety, "brandSafety"),
    headingFontKey: sanitiseThemeFont(
      value?.headingFontKey,
      DEFAULT_CLUB_THEME_VALUES.headingFontKey,
    ),
    bodyFontKey: sanitiseThemeFont(
      value?.bodyFontKey,
      DEFAULT_CLUB_THEME_VALUES.bodyFontKey,
    ),
    logoDataUrl: sanitiseLogoDataUrl(value?.logoDataUrl),
  };
}

export function buildClubThemeCss(
  value: Partial<Record<keyof ClubThemeValues, unknown>> | null | undefined,
): string {
  const theme = normaliseThemeValues(value);
  return `:root,.website-theme{--brand-gold:${theme.brandGold};--brand-charcoal:${theme.brandCharcoal};--brand-deep:${theme.brandDeep};--brand-ridge:${theme.brandRidge};--brand-mist:${theme.brandMist};--brand-snow:${theme.brandSnow};--brand-safety:${theme.brandSafety};--font-website-heading:var(${fontCssVariable(theme.headingFontKey)});--font-website-body:var(${fontCssVariable(theme.bodyFontKey)});}`;
}

export type ContrastWarning = {
  id: string;
  label: string;
  ratio: number | null;
  message: string;
};

function hexToRgb(value: string): { r: number; g: number; b: number } | null {
  const trimmed = value.trim();
  if (!HEX_COLOUR_PATTERN.test(trimmed)) {
    return null;
  }

  return {
    r: Number.parseInt(trimmed.slice(1, 3), 16),
    g: Number.parseInt(trimmed.slice(3, 5), 16),
    b: Number.parseInt(trimmed.slice(5, 7), 16),
  };
}

function channelToLinear(value: number) {
  const normalized = value / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(colour: string): number | null {
  const rgb = hexToRgb(colour);
  if (!rgb) {
    return null;
  }

  return (
    0.2126 * channelToLinear(rgb.r) +
    0.7152 * channelToLinear(rgb.g) +
    0.0722 * channelToLinear(rgb.b)
  );
}

export function contrastRatio(foreground: string, background: string): number | null {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  if (foregroundLuminance === null || backgroundLuminance === null) {
    return null;
  }

  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function getContrastWarnings(
  value: Partial<Record<keyof ClubThemeValues, unknown>>,
): ContrastWarning[] {
  const theme = normaliseThemeValues(value);
  const checks: Array<{
    id: string;
    label: string;
    foreground: string;
    background: string;
  }> = [
    {
      id: "body-on-snow",
      label: "Body text on page background",
      foreground: theme.brandDeep,
      background: theme.brandSnow,
    },
    {
      id: "header-on-charcoal",
      label: "Header text on navigation background",
      foreground: theme.brandSnow,
      background: theme.brandCharcoal,
    },
    {
      id: "button-on-gold",
      label: "Button text on primary action",
      foreground: theme.brandCharcoal,
      background: theme.brandGold,
    },
  ];

  const warnings: ContrastWarning[] = [];

  for (const check of checks) {
    const ratio = contrastRatio(check.foreground, check.background);
    if (ratio === null) {
      warnings.push({
        id: check.id,
        label: check.label,
        ratio,
        message: `${check.label}: check WCAG AA contrast manually for OKLCH colours.`,
      });
      continue;
    }
    if (ratio >= 4.5) {
      continue;
    }
    warnings.push({
      id: check.id,
      label: check.label,
      ratio,
      message: `${check.label}: ${ratio.toFixed(2)}:1 is below the WCAG AA 4.5:1 text target.`,
    });
  }

  return warnings;
}
