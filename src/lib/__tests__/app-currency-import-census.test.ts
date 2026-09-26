import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import { MANDATORY_SRC_RESTRICTIONS, RETIRED_FORMAT_CONSTANT_ARMS } from "../../../eslint.config.mjs";
import { stripComments } from "./support/strip-comments";

/**
 * No module outside `src/config/operational.ts` imports `APP_LOCALE` or
 * `APP_CURRENCY` (#3566's acceptance criterion, enforced — review finding B9),
 * and `APP_STRIPE_CURRENCY` reaches exactly the seven card-charge modules
 * #3567 has to decide about, and no eighth.
 *
 * The lint arm is the enforcement; this suite lints real snippets through the
 * shipping config at real paths, and walks `src/` for the charge-currency
 * importers. Disk-scanning: run by name.
 */
const ROOT = process.cwd();
const PREFIX = "INV-CONFIG-006 / #3566: do not import APP_LOCALE";

/** The #3567 exception: the modules that charge a card in the server's currency. */
const APP_STRIPE_CURRENCY_IMPORTERS = [
  "src/app/api/payments/create-payment-intent/route.ts",
  "src/lib/booking-modification-settlement.ts",
  "src/lib/group-settlement.ts",
  "src/lib/payment-link-intent.ts",
  "src/lib/payment-recovery.ts",
  "src/lib/payment-transactions.ts",
  "src/lib/saved-card-charge-request.ts",
];

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
      if (name === "__tests__" || name === "node_modules") continue;
      walk(full, out);
    } else if (/\.[cm]?[jt]sx?$/.test(name) && !/\.(test|spec)\./.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("#3566: APP_LOCALE and APP_CURRENCY are not imported outside operational.ts", () => {
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

  it("leaves the constants the programme has not retired yet alone", async () => {
    expect(
      await hits(
        'import { APP_TIME_ZONE, APP_STRIPE_CURRENCY } from "@/config/operational";\nexport const x = [APP_TIME_ZONE, APP_STRIPE_CURRENCY];',
        "src/lib/season-label.ts",
      ),
    ).toBe(0);
  });
});

describe("#3567 exception: APP_STRIPE_CURRENCY reaches exactly the seven card-charge modules", () => {
  it("names every importer, and no other module imports it", () => {
    const importers = walk(path.join(ROOT, "src"))
      .filter((file) =>
        /\bAPP_STRIPE_CURRENCY\b/.test(stripComments(readFileSync(file, "utf8"))),
      )
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
      .filter((file) => file !== "src/config/operational.ts")
      .sort();
    expect(
      importers,
      "APP_STRIPE_CURRENCY is the card-charge currency, still derived from the server's CURRENCY until #3567 decides where it comes from. A new importer is a new card path charging in a currency the club's setting does not control; add it to this list only with that decision in hand.",
    ).toEqual([...APP_STRIPE_CURRENCY_IMPORTERS].sort());
  });
});

/** `APP_LOCALE` / `APP_CURRENCY` as a whole word — never `APP_STRIPE_CURRENCY`. */
export function findRetiredFormatConstantTokens(source: string): string[] {
  return [...stripComments(source).matchAll(/\bAPP_(?:LOCALE|CURRENCY)\b/g)].map((match) => match[0]);
}

describe("#3566 backstop: no APP_LOCALE / APP_CURRENCY token in src code outside operational.ts", () => {
  it("counts the tokens it looks for", () => {
    expect(findRetiredFormatConstantTokens("const x = mod.APP_LOCALE;")).toHaveLength(1);
    expect(findRetiredFormatConstantTokens('const x = mod["APP_CURRENCY"];')).toHaveLength(1);
    expect(findRetiredFormatConstantTokens("const { APP_LOCALE: l, APP_CURRENCY: c } = req(p);")).toHaveLength(2);
    expect(findRetiredFormatConstantTokens("const x = APP_STRIPE_CURRENCY;")).toHaveLength(0);
    expect(findRetiredFormatConstantTokens("const x = MY_APP_LOCALE_X;")).toHaveLength(0);
    expect(findRetiredFormatConstantTokens("// was APP_LOCALE\n/* and APP_CURRENCY */")).toHaveLength(0);
  });

  it("finds none — a spelling no lint selector follows still names the constant", () => {
    const offenders = walk(path.join(ROOT, "src"))
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
      .filter((file) => file !== "src/config/operational.ts")
      .filter((file) => findRetiredFormatConstantTokens(readFileSync(path.join(ROOT, file), "utf8")).length > 0)
      .sort();
    expect(
      offenders,
      "APP_LOCALE / APP_CURRENCY are retired from reading (#3566): take the club's locale and currency from clubFormatValues() / clubFormat() on the server or useClubFormat() in the browser.",
    ).toEqual([]);
  });
});
