/*
 * Radix custom-palette generator — SHIPPING PORT.
 *
 * Origin : radix-ui/website — components/generate-radix-colors.tsx
 * Commit : bb424082fd33fadc244a6dd276d3ced55caa6234
 * License: MIT (see scripts/theme/vendor/LICENSE-radix-website)
 *
 * This is a faithful TS→ESM port of the vendored upstream generator kept at
 * scripts/theme/vendor/generate-radix-colors.tsx. It produces Radix-style 12-step
 * light/dark scales from an accent + gray seed against a background colour. The
 * algorithm is UNCHANGED from upstream save for two documented colorjs.io >= 0.6
 * adaptations (#2303): the missing-coordinate handling described below
 * `Appearance`, and the achromatic-reference-ramp chroma guard in
 * `getScaleFromColor`. Otherwise only the module shape (typed public signature,
 * ESM export) differs. The golden-value tests in
 * ./__tests__/generator-goldens.test.ts pin parity for the shipping default
 * seeds, which never reach that guard; ./__tests__/colorjs-coords.test.ts pins
 * the guard itself, for both the low-chroma seeds that do reach it and the
 * chromatic ones that must not. Both run on Node 24 (the production image,
 * node:24.17-alpine) in CI.
 *
 * DO NOT hand-tune output here. The theme substrate (src/lib/theme/tokens.ts) and
 * the guarantee sweep depend on this producing byte-identical hexes across runs.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as RadixColors from "@radix-ui/colors";
import Color from "colorjs.io";
import BezierEasing from "bezier-easing";
import { must as mustDefined } from "./index-guards";

export type Appearance = "light" | "dark";

/*
 * colorjs.io >= 0.6 types every colour coordinate as `number | null`, where
 * `null` is a CSS Color 4 "none" (missing) component. Inside this generator the
 * only coordinate that is ever actually missing is the HUE of an achromatic
 * colour: 0.5.x surfaced that as `NaN`, 0.7.x surfaces it as `null`.
 *
 * CSS Color 4 defines a missing component as 0 wherever it is consumed as a
 * number, JavaScript already coerces `null` to 0 in arithmetic, and colorjs
 * renders `oklch(L C none)` byte-identically to `oklch(L C 0)` — so coalescing a
 * missing coordinate to 0 is the behaviour-preserving read at every arithmetic
 * site below, not a convenience cast. The golden-value tests pin that claim: no
 * coalescing site moves a single hex across the 0.5.2 -> 0.7.1 bump.
 *
 * Two sites must NOT simply coalesce. `getButtonHoverColor` asks "is the hue
 * defined at all?" — see `hueIsMissing`. `getScaleFromColor` would divide BY a
 * chroma that is now exactly 0 for any low-chroma seed — see the chroma guard
 * there, the one place the bump needs a real adaptation.
 */
const num = (coord: number | null | undefined): number => coord ?? 0;

/** Every coordinate of a colour as a plain number, missing components as 0. */
const numericCoords = (color: Color): number[] => color.coords.map(num);

/** `must` (shared in `./index-guards`) with this module's own error prefix. */
function must<T>(value: T | undefined, message: string): T {
  return mustDefined(value, `generate-radix-colors: ${message}`);
}

/**
 * True when a hue is absent rather than zero — colorjs 0.5.x said `NaN`, 0.7.x
 * says `null`, and both mean "this colour has no hue" (it is achromatic).
 */
const hueIsMissing = (hue: number | null | undefined): boolean =>
  hue === null || hue === undefined || Number.isNaN(hue);

export interface GenerateRadixColorsOptions {
  appearance: Appearance;
  /** Accent seed (any CSS colour string). */
  accent: string;
  /** Gray/neutral seed (any CSS colour string). */
  gray: string;
  /** Page background (any CSS colour string). */
  background: string;
}

export interface GeneratedRadixColors {
  accentScale: string[];
  accentScaleAlpha: string[];
  accentScaleWideGamut: string[];
  accentScaleAlphaWideGamut: string[];
  accentContrast: string;
  grayScale: string[];
  grayScaleAlpha: string[];
  grayScaleWideGamut: string[];
  grayScaleAlphaWideGamut: string[];
  graySurface: string;
  graySurfaceWideGamut: string;
  accentSurface: string;
  accentSurfaceWideGamut: string;
  background: string;
}

const arrayOf12 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const grayScaleNames = ["gray", "mauve", "slate", "sage", "olive", "sand"];
const scaleNames = [
  ...grayScaleNames,
  "tomato",
  "red",
  "ruby",
  "crimson",
  "pink",
  "plum",
  "purple",
  "violet",
  "iris",
  "indigo",
  "blue",
  "cyan",
  "teal",
  "jade",
  "green",
  "grass",
  "brown",
  "orange",
  "sky",
  "mint",
  "lime",
  "yellow",
  "amber",
];

const radix = RadixColors as unknown as Record<string, Record<string, string>>;

/**
 * `scaleNames`/`grayScaleNames` above are hand-copied from the vendored
 * `@radix-ui/colors` package's own export names — every key looked up here is
 * one this module lists itself, so a miss can only mean that dependency's
 * exports changed shape underneath it, not a per-request condition to recover
 * from silently.
 */
function requiredRadixScale(key: string): Record<string, string> {
  return must(radix[key], `no "${key}" export in the vendored @radix-ui/colors package`);
}

const lightColors = Object.fromEntries(
  scaleNames.map((scaleName) => [
    scaleName,
    Object.values(requiredRadixScale(`${scaleName}P3`)).map((str) => new Color(str).to("oklch")),
  ]),
);
const darkColors = Object.fromEntries(
  scaleNames.map((scaleName) => [
    scaleName,
    Object.values(requiredRadixScale(`${scaleName}DarkP3`)).map((str) => new Color(str).to("oklch")),
  ]),
);
const lightGrayColors = Object.fromEntries(
  grayScaleNames.map((scaleName) => [
    scaleName,
    Object.values(requiredRadixScale(`${scaleName}P3`)).map((str) => new Color(str).to("oklch")),
  ]),
);
const darkGrayColors = Object.fromEntries(
  grayScaleNames.map((scaleName) => [
    scaleName,
    Object.values(requiredRadixScale(`${scaleName}DarkP3`)).map((str) => new Color(str).to("oklch")),
  ]),
);

export const generateRadixColors = ({
  appearance,
  ...args
}: GenerateRadixColorsOptions): GeneratedRadixColors => {
  const allScales = appearance === "light" ? lightColors : darkColors;
  const grayScales = appearance === "light" ? lightGrayColors : darkGrayColors;
  const backgroundColor = new Color(args.background).to("oklch");
  const grayBaseColor = new Color(args.gray).to("oklch");
  const grayScaleColors = getScaleFromColor(grayBaseColor, grayScales, backgroundColor);
  const accentBaseColor = new Color(args.accent).to("oklch");
  let accentScaleColors = getScaleFromColor(accentBaseColor, allScales, backgroundColor);
  const backgroundHex = backgroundColor.to("srgb").toString({ format: "hex" });
  const accentBaseHex = accentBaseColor.to("srgb").toString({ format: "hex" });
  if (accentBaseHex === "#000" || accentBaseHex === "#fff") {
    accentScaleColors = grayScaleColors.map((color: any) => color.clone());
  }
  const [accent9Color, accentContrastColor] = getStep9Colors(accentScaleColors, accentBaseColor);
  accentScaleColors[8] = accent9Color;
  accentScaleColors[9] = getButtonHoverColor(accent9Color, [accentScaleColors]);
  accentScaleColors[10].coords[1] = Math.min(
    Math.max(accentScaleColors[8].coords[1], accentScaleColors[7].coords[1]),
    accentScaleColors[10].coords[1],
  );
  accentScaleColors[11].coords[1] = Math.min(
    Math.max(accentScaleColors[8].coords[1], accentScaleColors[7].coords[1]),
    accentScaleColors[11].coords[1],
  );
  const accentScaleHex = accentScaleColors.map((color: any) =>
    color.to("srgb").toString({ format: "hex" }),
  );
  const accentScaleWideGamut = accentScaleColors.map(toOklchString);
  const accentScaleAlphaHex = accentScaleHex.map((color: any) =>
    getAlphaColorSrgb(color, backgroundHex),
  );
  const accentScaleAlphaWideGamutString = accentScaleHex.map((color: any) =>
    getAlphaColorP3(color, backgroundHex),
  );
  const accentContrastColorHex = accentContrastColor.to("srgb").toString({ format: "hex" });
  const grayScaleHex = grayScaleColors.map((color: any) =>
    color.to("srgb").toString({ format: "hex" }),
  );
  const grayScaleWideGamut = grayScaleColors.map(toOklchString);
  const grayScaleAlphaHex = grayScaleHex.map((color: any) =>
    getAlphaColorSrgb(color, backgroundHex),
  );
  const grayScaleAlphaWideGamutString = grayScaleHex.map((color: any) =>
    getAlphaColorP3(color, backgroundHex),
  );
  const accentSurfaceHex =
    appearance === "light"
      ? getAlphaColorSrgb(accentScaleHex[1], backgroundHex, 0.8)
      : getAlphaColorSrgb(accentScaleHex[1], backgroundHex, 0.5);
  const accentScaleWideGamutStep1 = must(
    accentScaleWideGamut[1],
    "accentScaleWideGamut has no step 1 — every scale here has exactly 12 steps",
  );
  const accentSurfaceWideGamutString =
    appearance === "light"
      ? getAlphaColorP3(accentScaleWideGamutStep1, backgroundHex, 0.8)
      : getAlphaColorP3(accentScaleWideGamutStep1, backgroundHex, 0.5);
  return {
    accentScale: accentScaleHex,
    accentScaleAlpha: accentScaleAlphaHex,
    accentScaleWideGamut,
    accentScaleAlphaWideGamut: accentScaleAlphaWideGamutString,
    accentContrast: accentContrastColorHex,
    grayScale: grayScaleHex,
    grayScaleAlpha: grayScaleAlphaHex,
    grayScaleWideGamut,
    grayScaleAlphaWideGamut: grayScaleAlphaWideGamutString,
    graySurface: appearance === "light" ? "#ffffffcc" : "rgba(0, 0, 0, 0.05)",
    graySurfaceWideGamut:
      appearance === "light"
        ? "color(display-p3 1 1 1 / 80%)"
        : "color(display-p3 0 0 0 / 5%)",
    accentSurface: accentSurfaceHex,
    accentSurfaceWideGamut: accentSurfaceWideGamutString,
    background: backgroundHex,
  };
};

function getStep9Colors(scale: any[], accentBaseColor: any): [any, any] {
  const referenceBackgroundColor = scale[0];
  const distance = accentBaseColor.deltaEOK(referenceBackgroundColor) * 100;
  if (distance < 25) {
    return [scale[8], getTextColor(scale[8])];
  }
  return [accentBaseColor, getTextColor(accentBaseColor)];
}

function getButtonHoverColor(source: any, scales: any[][]): any {
  const [L, C, H] = source.coords;
  const newL = L > 0.4 ? L - 0.03 / (L + 0.1) : L + 0.03 / (L + 0.1);
  // Upstream wrote `!isNaN(H)` — "only damp the chroma when the hue is actually
  // defined". Under colorjs 0.7 an achromatic hue is `null`, and `isNaN(null)`
  // is false, so the literal port would silently start damping the chroma of
  // greys. `hueIsMissing` keeps the original meaning under both spellings.
  const newC = L > 0.4 && !hueIsMissing(H) ? C * 0.93 + 0 : C;
  const buttonHoverColor = new Color("oklch", [newL, newC, H]);
  let closestColor = buttonHoverColor;
  let minDistance = Infinity;
  scales.forEach((scale) => {
    for (const color of scale) {
      const distance = buttonHoverColor.deltaEOK(color);
      if (distance < minDistance) {
        minDistance = distance;
        closestColor = color;
      }
    }
  });
  buttonHoverColor.coords[1] = closestColor.coords[1];
  buttonHoverColor.coords[2] = closestColor.coords[2];
  return buttonHoverColor;
}

function getScaleFromColor(source: any, scales: any, backgroundColor: any): any[] {
  const allColors: Array<{ scale: string; distance: number; color: any }> = [];
  Object.entries(scales).forEach(([name, scale2]) => {
    for (const color of scale2 as any[]) {
      const distance = source.deltaEOK(color);
      allColors.push({ scale: name, distance, color });
    }
  });
  allColors.sort((a2, b2) => a2.distance - b2.distance);
  const closestColors = allColors.filter(
    (color, i, arr) => i === arr.findIndex((value) => value.scale === color.scale),
  );
  const grayScaleNamesStr = grayScaleNames;
  const allAreGrays = closestColors.every((color) => grayScaleNamesStr.includes(color.scale));
  const closestScaleName = () =>
    must(closestColors[0], "no closest colour scale — `scales` supplied nothing to interpolate from").scale;
  const secondClosestScaleName = () =>
    must(closestColors[1], "fewer than two candidate scales remain after de-duplication").scale;
  if (!allAreGrays && grayScaleNamesStr.includes(closestScaleName())) {
    while (grayScaleNamesStr.includes(secondClosestScaleName())) {
      closestColors.splice(1, 1);
    }
  }
  const colorA = must(closestColors[0], "no closest colour scale after de-duplication");
  const colorB = must(closestColors[1], "fewer than two candidate colour scales after de-duplication");
  const a = colorB.distance;
  const b = colorA.distance;
  const c = colorA.color.deltaEOK(colorB.color);
  const cosA = (b ** 2 + c ** 2 - a ** 2) / (2 * b * c);
  const radA = Math.acos(cosA);
  const sinA = Math.sin(radA);
  const cosB = (a ** 2 + c ** 2 - b ** 2) / (2 * a * c);
  const radB = Math.acos(cosB);
  const sinB = Math.sin(radB);
  const tanC1 = cosA / sinA;
  const tanC2 = cosB / sinB;
  const ratio = Math.max(0, tanC1 / tanC2) * 0.5;
  const scaleA = scales[colorA.scale];
  const scaleB = scales[colorB.scale];
  const scale = arrayOf12.map((i) => new Color(Color.mix(scaleA[i], scaleB[i], ratio)).to("oklch"));
  const baseColor = must(
    scale.slice().sort((a2, b2) => source.deltaEOK(a2) - source.deltaEOK(b2))[0],
    "sorted an empty scale — the generator always builds 12 steps",
  );
  /*
   * #2303 — the one place the 0.5.2 -> 0.7.x bump needs a real adaptation, not
   * just a coalesce. Upstream rescales the reference ramp's chroma so its
   * closest step carries the seed's chroma, capped at 1.5x the seed's chroma:
   *
   *     coords[1] = Math.min(sourceC * 1.5, stepC * (sourceC / baseC))
   *
   * Radix's `gray` ramp is perfectly achromatic. Whenever it is the closest
   * reference ramp — which is any LOW-CHROMA seed, not only an exactly grey one
   * — every `stepC` and the divisor `baseC` are zero. colorjs 0.5.2 did not
   * quite say zero: its OKLab->OKLCh conversion left ~1e-16 of float noise on
   * each step, so the division produced a ~1e14 ratio, the right-hand term
   * dwarfed the cap, and `Math.min` returned the cap — `sourceC * 1.5` — for
   * every step. 0.7.x reports a true 0, so `baseC` is 0, the ratio is Infinity,
   * `0 * Infinity` is NaN, and the ramp serialises to the literal string
   * "#NaNNaNNaN", which throws when it is re-parsed.
   *
   * So the cap IS the behaviour 0.5.2 delivered here, and taking it directly is
   * both the numerically correct limit and the behaviour-preserving read. Note
   * what it does NOT do: it does not flatten the ramp to grey. A seed with a
   * small but real chroma (including the neutral seed the substrate derives at
   * PINS.neutralSeed.C) keeps its tint, exactly as before the bump; only a seed
   * whose chroma is genuinely 0 yields a genuinely grey ramp — which is also
   * what makes the "#NaNNaNNaN" case impossible.
   *
   * Deliberate divergence from the vendored upstream source: upstream has no
   * such guard because under colorjs 0.5.x it never needed one.
   */
  const baseChroma = num(baseColor.coords[1]);
  const sourceChromaCap = num(source.coords[1]) * 1.5;
  const ratioC = baseChroma === 0 ? 1 : source.coords[1] / baseChroma;
  scale.forEach((color) => {
    color.coords[1] =
      baseChroma === 0
        ? sourceChromaCap
        : Math.min(source.coords[1] * 1.5, num(color.coords[1]) * ratioC);
    // The hue is copied across verbatim, missing or not: a missing hue on the
    // source means the whole scale is achromatic, exactly as under 0.5.x.
    color.coords[2] = source.coords[2];
  });
  // `scale` is always the 12 steps `arrayOf12` built it from; every numeric
  // index used below names one of those 12 positions.
  const stepAt = (i: number) => must(scale[i], `getScaleFromColor: scale has no step ${i} of its 12`);
  if (num(stepAt(0).coords[0]) > 0.5) {
    const lightnessScale2 = scale.map(({ coords }) => num(coords[0]));
    const backgroundL2 = Math.max(0, Math.min(1, backgroundColor.coords[0]));
    const newLightnessScale2 = transposeProgressionStart(
      backgroundL2,
      [1, ...lightnessScale2],
      lightModeEasing,
    );
    newLightnessScale2.shift();
    newLightnessScale2.forEach((lightness, i) => {
      stepAt(i).coords[0] = lightness;
    });
    return scale;
  }
  const ease: [number, number, number, number] = [...darkModeEasing];
  const referenceBackgroundColorL = num(stepAt(0).coords[0]);
  const backgroundColorL = Math.max(0, Math.min(1, backgroundColor.coords[0]));
  const ratioL = backgroundColorL / referenceBackgroundColorL;
  if (ratioL > 1) {
    const maxRatio = 1.5;
    for (let i = 0; i < ease.length; i++) {
      const metaRatio = (ratioL - 1) * (maxRatio / (maxRatio - 1));
      const current = must(ease[i], `getScaleFromColor: ease has no index ${i} of its fixed 4`);
      ease[i] = ratioL > maxRatio ? 0 : Math.max(0, current * (1 - metaRatio));
    }
  }
  const lightnessScale = scale.map(({ coords }) => num(coords[0]));
  const backgroundL = backgroundColor.coords[0];
  const newLightnessScale = transposeProgressionStart(backgroundL, lightnessScale, ease);
  newLightnessScale.forEach((lightness, i) => {
    stepAt(i).coords[0] = lightness;
  });
  return scale;
}

function getTextColor(background: any): any {
  const white = new Color("oklch", [1, 0, 0]);
  if (Math.abs(white.contrastAPCA(background)) < 40) {
    const [, C, H] = background.coords;
    // A missing chroma contributes nothing to the floor; a missing hue is passed
    // through untouched (colorjs renders `none` exactly like 0).
    return new Color("oklch", [0.25, Math.max(0.08 * num(C), 0.04), H]);
  }
  return white;
}

function getAlphaColor(
  targetRgb: number[],
  backgroundRgb: number[],
  rgbPrecision: number,
  alphaPrecision: number,
  targetAlpha?: number,
): [number, number, number, number] {
  const [tr, tg, tb] = targetRgb.map((c) => Math.round(c * rgbPrecision));
  const [br, bg, bb] = backgroundRgb.map((c) => Math.round(c * rgbPrecision));
  if (
    tr === undefined ||
    tg === undefined ||
    tb === undefined ||
    br === undefined ||
    bg === undefined ||
    bb === undefined
  ) {
    throw Error("Color is undefined");
  }
  let desiredRgb = 0;
  if (tr > br) {
    desiredRgb = rgbPrecision;
  } else if (tg > bg) {
    desiredRgb = rgbPrecision;
  } else if (tb > bb) {
    desiredRgb = rgbPrecision;
  }
  const alphaR = (tr - br) / (desiredRgb - br);
  const alphaG = (tg - bg) / (desiredRgb - bg);
  const alphaB = (tb - bb) / (desiredRgb - bb);
  const isPureGray = [alphaR, alphaG, alphaB].every((alpha) => alpha === alphaR);
  if (!targetAlpha && isPureGray) {
    const V = desiredRgb / rgbPrecision;
    return [V, V, V, alphaR];
  }
  const clampRgb = (n: number) => (isNaN(n) ? 0 : Math.min(rgbPrecision, Math.max(0, n)));
  const clampA = (n: number) => (isNaN(n) ? 0 : Math.min(alphaPrecision, Math.max(0, n)));
  const maxAlpha = targetAlpha ?? Math.max(alphaR, alphaG, alphaB);
  const A = clampA(Math.ceil(maxAlpha * alphaPrecision)) / alphaPrecision;
  let R = clampRgb(((br * (1 - A) - tr) / A) * -1);
  let G = clampRgb(((bg * (1 - A) - tg) / A) * -1);
  let B = clampRgb(((bb * (1 - A) - tb) / A) * -1);
  R = Math.ceil(R);
  G = Math.ceil(G);
  B = Math.ceil(B);
  const blendedR = blendAlpha(R, A, br);
  const blendedG = blendAlpha(G, A, bg);
  const blendedB = blendAlpha(B, A, bb);
  if (desiredRgb === 0) {
    if (tr <= br && tr !== blendedR) {
      R = tr > blendedR ? R + 1 : R - 1;
    }
    if (tg <= bg && tg !== blendedG) {
      G = tg > blendedG ? G + 1 : G - 1;
    }
    if (tb <= bb && tb !== blendedB) {
      B = tb > blendedB ? B + 1 : B - 1;
    }
  }
  if (desiredRgb === rgbPrecision) {
    if (tr >= br && tr !== blendedR) {
      R = tr > blendedR ? R + 1 : R - 1;
    }
    if (tg >= bg && tg !== blendedG) {
      G = tg > blendedG ? G + 1 : G - 1;
    }
    if (tb >= bb && tb !== blendedB) {
      B = tb > blendedB ? B + 1 : B - 1;
    }
  }
  R = R / rgbPrecision;
  G = G / rgbPrecision;
  B = B / rgbPrecision;
  return [R, G, B, A];
}

function blendAlpha(foreground: number, alpha: number, background: number, round = true): number {
  if (round) {
    return Math.round(background * (1 - alpha)) + Math.round(foreground * alpha);
  }
  return background * (1 - alpha) + foreground * alpha;
}

function getAlphaColorSrgb(targetColor: string, backgroundColor: string, targetAlpha?: number): string {
  const [r, g, b, a] = getAlphaColor(
    numericCoords(new Color(targetColor).to("srgb")),
    numericCoords(new Color(backgroundColor).to("srgb")),
    255,
    255,
    targetAlpha,
  );
  return formatHex(new Color("srgb", [r, g, b], a).toString({ format: "hex" }));
}

function getAlphaColorP3(targetColor: string, backgroundColor: string, targetAlpha?: number): string {
  const [r, g, b, a] = getAlphaColor(
    numericCoords(new Color(targetColor).to("p3")),
    numericCoords(new Color(backgroundColor).to("p3")),
    255,
    1e3,
    targetAlpha,
  );
  return new Color("p3", [r, g, b], a)
    .toString({ precision: 4 })
    .replace("color(p3 ", "color(display-p3 ");
}

function formatHex(str: string): string {
  if (!str.startsWith("#")) {
    return str;
  }
  if (str.length === 4) {
    const hash = str.charAt(0);
    const r = str.charAt(1);
    const g = str.charAt(2);
    const b = str.charAt(3);
    return hash + r + r + g + g + b + b;
  }
  if (str.length === 5) {
    const hash = str.charAt(0);
    const r = str.charAt(1);
    const g = str.charAt(2);
    const b = str.charAt(3);
    const a = str.charAt(4);
    return hash + r + r + g + g + b + b + a + a;
  }
  return str;
}

const darkModeEasing: [number, number, number, number] = [1, 0, 1, 0];
const lightModeEasing: [number, number, number, number] = [0, 2, 0, 2];

export function transposeProgressionStart(
  to: number,
  arr: number[],
  curve: [number, number, number, number],
): number[] {
  return arr.map((n, i, arr2) => {
    const lastIndex = arr2.length - 1;
    // `.map` never invokes its callback on an empty array, so whenever this
    // line runs `arr2` has at least one element and index 0 exists.
    const first = must(arr2[0], "transposeProgressionStart: unreachable — map callback ran on an empty array");
    const diff = first - to;
    const fn = BezierEasing(...curve);
    return n - diff * fn(1 - i / lastIndex);
  });
}

function toOklchString(color: any): string {
  const L = +(num(color.coords[0]) * 100).toFixed(1);
  return color
    .to("oklch")
    .toString({ precision: 4 })
    .replace(/(\S+)(.+)/, `oklch(${L}%$2`);
}
