import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AA_TEXT_CONTRAST_RATIO,
  contrastRatio,
  mixSrgb,
} from "@/lib/club-theme-schema";

import { stripCssComments } from "./support/strip-comments";

// #4553 — `text-destructive` is the app's error ink (inline field errors,
// `bg-destructive/10` alert boxes, destructive menu items). #4534 measured the
// light value short of AA and moved it to red-700; dark mode kept a red-900
// that read 1.23–1.80:1 on the dark surfaces. This contract reads every token
// FROM `globals.css` and measures it, so a regression in the stylesheet fails
// here: no colour is copied into this file.

// Comments are dropped first: several of them quote selectors and braces.
const GLOBALS = stripCssComments(readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8"));

/** The declarations of the first rule whose selector is exactly `selector`. */
function block(selector: string): Map<string, string> {
  const opener = new RegExp(`^\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{$`, "m");
  const match = opener.exec(GLOBALS);
  if (!match) throw new Error(`globals.css has no "${selector} {" rule`);
  const body = GLOBALS.slice(match.index + match[0].length, GLOBALS.indexOf("}", match.index));
  const declarations = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(name!, value!.trim());
  }
  return declarations;
}

/**
 * A token's value in a scope. Custom properties containing `var()` resolve on
 * the element that declares them, so a reference is looked up in the same
 * scope chain; `var(--gen-…, <fallback>)` takes the fallback, the static
 * default-palette value (the generated stylesheet is per club).
 */
function resolve(token: string, scopes: Map<string, string>[]): string {
  const value = scopes.find((scope) => scope.has(token))?.get(token);
  if (value === undefined) throw new Error(`${token} is not declared in this scope`);
  const reference = /^var\((--[\w-]+)(?:\s*,\s*([^)]+\)?))?\)$/.exec(value);
  if (!reference) return value;
  const [, name, fallback] = reference;
  if (scopes.some((scope) => scope.has(name!))) return resolve(name!, scopes);
  if (fallback) return fallback.trim();
  throw new Error(`${token} -> ${name} does not resolve`);
}

/** Every `bg-destructive/<n>` alpha the app paints error boxes with. */
function destructiveFillAlphas(): number[] {
  const alphas = new Set<number>();
  for (const entry of readdirSync(join(process.cwd(), "src"), { recursive: true, encoding: "utf8" })) {
    if (!/\.tsx?$/.test(entry) || /__tests__|\.test\./.test(entry)) continue;
    const text = readFileSync(join(process.cwd(), "src", entry), "utf8");
    for (const [, alpha] of text.matchAll(/\bbg-destructive\/(\d+)\b/g)) alphas.add(Number(alpha));
  }
  return [...alphas].sort((a, b) => a - b);
}

const ROOT = block(":root");
const DARK = block(".dark");
const WEBSITE = block(".website-theme");
const APP = block(".app-theme-scope");
const DARK_APP = block(".dark .app-theme-scope");

// The surfaces error text lands on: the page, card and popover, and the
// muted, secondary and accent surfaces (a hovered destructive menu item sits on
// `--accent`). `--danger-muted` is added where a scope declares it.
const SURFACES = ["--background", "--card", "--popover", "--muted", "--secondary", "--accent"];
// The surfaces an error BOX (`bg-destructive/<n>`) is laid on: a page, card or
// dialog. Dark mode is held to every surface; light mode is not, because its
// red-700 (#4534) is 4.49:1 in a /10 box laid on `--muted` and 4.40:1 on
// `--danger-muted`, so this contract does not claim a light box on those.
const PAGE_SURFACES = ["--background", "--card", "--popover"];

// Each list is the cascade an element in that theme sees, nearest first: a
// `.dark .app-theme-scope` element matches both app-scope rules (the dark one
// wins where both declare a token), then inherits `.dark`, then `:root`. The
// ink is read through the same list, so a `--destructive` declared inside an
// app scope is measured, not skipped.
type Theme = {
  name: string;
  ink: Map<string, string>[];
  surfaces: Map<string, string>[];
  textSurfaces: string[];
  boxSurfaces: string[];
};

const THEMES: Theme[] = [
  { name: "light :root", ink: [ROOT], surfaces: [ROOT], textSurfaces: [...SURFACES, "--danger-muted"], boxSurfaces: PAGE_SURFACES },
  { name: "light app scope", ink: [APP, ROOT], surfaces: [APP, ROOT], textSurfaces: SURFACES, boxSurfaces: PAGE_SURFACES },
  { name: "website", ink: [WEBSITE, ROOT], surfaces: [WEBSITE, ROOT], textSurfaces: SURFACES, boxSurfaces: PAGE_SURFACES },
  { name: "dark .dark", ink: [DARK, ROOT], surfaces: [DARK, ROOT], textSurfaces: [...SURFACES, "--danger-muted"], boxSurfaces: [...SURFACES, "--danger-muted"] },
  { name: "dark app scope", ink: [DARK_APP, APP, DARK, ROOT], surfaces: [DARK_APP, APP, DARK, ROOT], textSurfaces: SURFACES, boxSurfaces: SURFACES },
];

describe("destructive token contrast (#4553)", () => {
  const alphas = destructiveFillAlphas();

  it("finds the error-box fills it measures", () => {
    // A census that matched nothing would make every box check below vacuous.
    expect(alphas).toContain(10);
  }, 60_000);

  for (const theme of THEMES) {
    it(`${theme.name}: text-destructive clears AA on every surface it lands on`, () => {
      const ink = resolve("--destructive", theme.ink);
      for (const surfaceToken of theme.textSurfaces) {
        const surface = resolve(surfaceToken, theme.surfaces);
        expect(contrastRatio(ink, surface), `${theme.name}: ${ink} on ${surfaceToken} ${surface}`).toBeGreaterThanOrEqual(
          AA_TEXT_CONTRAST_RATIO,
        );
      }
    });

    it(`${theme.name}: text-destructive clears AA inside its own bg-destructive error box`, () => {
      const ink = resolve("--destructive", theme.ink);
      for (const surfaceToken of theme.boxSurfaces) {
        const surface = resolve(surfaceToken, theme.surfaces);
        for (const alpha of alphas) {
          const box = mixSrgb(ink, surface, alpha / 100);
          const label = `${theme.name}: ${ink} in bg-destructive/${alpha} on ${surfaceToken} ${surface}`;
          expect(box, label).not.toBeNull();
          expect(contrastRatio(ink, box!), label).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST_RATIO);
        }
      }
    });

    it(`${theme.name}: --destructive-foreground clears AA on solid --destructive`, () => {
      const ink = resolve("--destructive", theme.ink);
      const foreground = resolve("--destructive-foreground", theme.ink);
      expect(contrastRatio(foreground, ink), `${foreground} on ${ink}`).toBeGreaterThanOrEqual(
        AA_TEXT_CONTRAST_RATIO,
      );
    });
  }
});
