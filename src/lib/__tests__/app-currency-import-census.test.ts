import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import { MANDATORY_SRC_RESTRICTIONS, RETIRED_FORMAT_CONSTANT_ARMS } from "../../../eslint.config.mjs";
import { stripComments } from "./support/strip-comments";

/**
 * `src/config/operational.ts` is gone, with all four of its constants
 * (#3567, the last stage of programme #3205), and nothing may import it again.
 * #3566 banned importing `APP_LOCALE` / `APP_CURRENCY` (review finding B9);
 * #3567 moved the seven `APP_STRIPE_CURRENCY` importers onto the club format
 * `stripe.ts` already requires and the two `APP_TIME_ZONE` readers onto the
 * club's stored zone, then deleted the file.
 *
 * The lint arm is the enforcement; this suite lints real snippets through the
 * shipping config at real paths, and walks `src/` — tests included — for any
 * of the four names. Disk-scanning: run by name.
 */
const ROOT = process.cwd();
const PREFIX = "INV-CONFIG-006 / #3567: do not import @/config/operational";

let eslint: ESLint;

beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT, warnIgnored: false });
  await eslint.lintText("export const x = 1;\n", {
    filePath: path.join(ROOT, "src/lib/warmup.ts"),
  });
}, 120_000);

async function hits(code: string, file: string): Promise<number> {
  const results = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  return results
    .flatMap((result) => result.messages)
    .filter(
      (message) =>
        message.ruleId === "no-restricted-syntax" &&
        (message.message ?? "").startsWith(PREFIX),
    ).length;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      walk(full, out);
    } else if (/\.[cm]?[jt]sx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("#3567: @/config/operational is deleted, and no import of it lints clean", () => {
  it("no longer exists", () => {
    expect(existsSync(path.join(ROOT, "src/config/operational.ts"))).toBe(false);
  });

  it("is on the mandatory set, so no block can lift it", () => {
    const mandatory = new Set(
      MANDATORY_SRC_RESTRICTIONS.map((r: { selector: string }) => r.selector),
    );
    expect(RETIRED_FORMAT_CONSTANT_ARMS.length).toBeGreaterThan(0);
    for (const selector of RETIRED_FORMAT_CONSTANT_ARMS) {
      expect(mandatory.has(selector), selector).toBe(true);
    }
  });

  it("refuses every spelling, on every src surface including the Xero modules", async () => {
    const spellings = [
      'import { APP_LOCALE } from "@/config/operational";\nexport const x = APP_LOCALE;',
      'import { APP_CURRENCY as C } from "@/config/operational";\nexport const x = C;',
      'import { APP_LOCALE } from "../config/operational";\nexport const x = APP_LOCALE;',
      'import * as operational from "@/config/operational";\nexport const x = operational;',
      'export { APP_CURRENCY } from "@/config/operational";',
      'export * from "@/config/operational";',
      'export const x = () => import("@/config/operational");',
      // Round 2 of the #3628 review: the path however spelled, and the
      // dynamic forms.
      'import { APP_LOCALE } from "@/config/./operational";\nexport const x = APP_LOCALE;',
      'import { APP_LOCALE } from "@/config//operational";\nexport const x = APP_LOCALE;',
      'import { APP_CURRENCY } from "@/config/operational.js";\nexport const x = APP_CURRENCY;',
      'import { APP_CURRENCY } from "../../config/./operational.ts";\nexport const x = APP_CURRENCY;',
      "export const x = () => import(`@/config/operational`);",
      'const name = "operational";\nexport const x = () => import(`@/config/${name}`);',
      'export const x = () => require("@/config/operational");',
      'export const x = () => require("@/config/./operational.js");',
      "export const x = () => require(`@/config/operational`);",
      'import operational = require("@/config/operational");\nexport const x = operational;',
    ];
    for (const file of [
      "src/lib/season-label.ts",
      "src/lib/xero-invoices.ts",
      "src/app/(admin)/admin/x/page.tsx",
      "src/components/x.tsx",
    ]) {
      for (const code of spellings) {
        expect(await hits(code, file), `${file}: ${code}`).toBe(1);
      }
    }
  });

  it("leaves other modules, and a local require, alone", async () => {
    for (const code of [
      'import { APP_TIME_ZONE } from "@/config/operational-hours";\nexport const x = APP_TIME_ZONE;',
      'import { thing } from "@/config/modules";\nexport const x = thing;',
      'export const x = () => import(`@/lib/${"club-format"}`);',
      'function require(ok: boolean, field: string) { return ok ? field : ""; }\nexport const x = require(true, "lodgeId");',
    ]) {
      expect(await hits(code, "src/lib/season-label.ts"), code).toBe(0);
    }
  });

  it("refuses the two constants #3567 retired too, which the #3566 arm used to leave alone", async () => {
    for (const code of [
      'import { APP_TIME_ZONE } from "@/config/operational";\nexport const x = APP_TIME_ZONE;',
      'import { APP_STRIPE_CURRENCY } from "@/config/operational";\nexport const x = APP_STRIPE_CURRENCY;',
      'import "@/config/operational";',
      'export { APP_TIME_ZONE as z } from "@/config/operational";',
    ]) {
      expect(await hits(code, "src/lib/season-label.ts"), code).toBe(1);
    }
  });
});

/** Any of the four retired names as a whole word, comments stripped. */
export function findRetiredFormatConstantTokens(source: string): string[] {
  return [
    ...stripComments(source).matchAll(/\bAPP_(?:LOCALE|CURRENCY|STRIPE_CURRENCY|TIME_ZONE)\b/g),
  ].map((match) => match[0]);
}

/**
 * Where a retired name may still be written in CODE: the lint fixtures and
 * censuses that must spell it to prove it is refused. Each is a string literal
 * handed to ESLint or a regex, never a reference.
 */
const FIXTURE_FILES = new Set([
  "src/lib/__tests__/app-currency-import-census.test.ts",
  "src/lib/__tests__/cents-display-guard.test.ts",
  "src/lib/__tests__/club-time-boundary-guard.test.ts",
  "src/lib/__tests__/ssot-authority-default-guard.test.ts",
  "src/lib/__tests__/client-server-boundary-census.test.ts",
]);

describe("#3567 backstop: none of the four retired names in src code, tests included", () => {
  it("counts the tokens it looks for", () => {
    expect(findRetiredFormatConstantTokens("const x = mod.APP_LOCALE;")).toHaveLength(1);
    expect(findRetiredFormatConstantTokens('const x = mod["APP_CURRENCY"];')).toHaveLength(1);
    expect(findRetiredFormatConstantTokens("const { APP_LOCALE: l, APP_CURRENCY: c } = req(p);")).toHaveLength(2);
    expect(findRetiredFormatConstantTokens("const x = APP_STRIPE_CURRENCY;")).toHaveLength(1);
    expect(findRetiredFormatConstantTokens("const x = APP_TIME_ZONE;")).toHaveLength(1);
    expect(findRetiredFormatConstantTokens("const x = MY_APP_LOCALE_X;")).toHaveLength(0);
    expect(findRetiredFormatConstantTokens("// was APP_LOCALE\n/* and APP_TIME_ZONE */")).toHaveLength(0);
  });

  it("finds none — a spelling no lint selector follows still names the constant", () => {
    const offenders = walk(path.join(ROOT, "src"))
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
      .filter((file) => !FIXTURE_FILES.has(file))
      .filter((file) => findRetiredFormatConstantTokens(readFileSync(path.join(ROOT, file), "utf8")).length > 0)
      .sort();
    expect(
      offenders,
      "The environment constants are retired (#3567): take the club's locale and currency from clubFormatValues() / clubFormat() on the server or useClubFormat() in the browser, the card-charge currency from stripe.ts's own derivation, and the club's time zone from clubTimeZone() or readClubTimeZoneOutsideRequest(). A test pins a fixed value instead (CLUB_FORMAT_TEST, CLUB_TIME_TEST_ZONE).",
    ).toEqual([]);
  });
});
