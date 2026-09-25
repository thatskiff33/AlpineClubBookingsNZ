import path from "node:path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import { CLUB_FORMAT_GUARD_ARMS, MANDATORY_SRC_RESTRICTIONS } from "../../../eslint.config.mjs";

/**
 * The club's format stays a REQUIRED parameter (#3566 review, finding B7).
 *
 * The `@ts-expect-error` locks in `house-shapes.test.ts` and
 * `club-format-kernel.test.ts` prove the kernel's own renderings require a
 * format, but a WRAPPER — `seasonMonthsLabel`, `formatPayloadCalendarDay`, any
 * of the ninety that thread one — could quietly regain a default and let its
 * callers forget the club's format again. The eslint arm refuses a default or
 * an optional marker on any `ClubDateFormat` / `ClubFormat` parameter in
 * `src/`; this lints real snippets at real paths through the shipping config.
 */
const ROOT = process.cwd();
const PREFIX = "INV-CONFIG-006 / #3566: a `ClubDateFormat`";

let eslint: ESLint;

beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT, warnIgnored: false });
  await eslint.lintText("export const x = 1;\n", {
    filePath: path.join(ROOT, "src/lib/warmup.ts"),
  });
}, 120_000);

async function hits(code: string, file = "src/lib/season-label.ts"): Promise<number> {
  const results = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  return results
    .flatMap((result) => result.messages)
    .filter(
      (message) =>
        message.ruleId === "no-restricted-syntax" &&
        (message.message ?? "").startsWith(PREFIX),
    ).length;
}

const HEADER =
  'import type { ClubDateFormat } from "@/lib/club-time";\nimport type { ClubFormat } from "@/lib/club-format";\nimport * as ct from "@/lib/club-time";\n';

describe("#3566: a club format parameter cannot regain a default", () => {
  it("is on the mandatory set, so no block can lift it", () => {
    const mandatory = new Set(
      MANDATORY_SRC_RESTRICTIONS.map((r: { selector: string }) => r.selector),
    );
    expect(CLUB_FORMAT_GUARD_ARMS.requiredParameter.length).toBeGreaterThan(0);
    for (const selector of CLUB_FORMAT_GUARD_ARMS.requiredParameter) {
      expect(mandatory.has(selector), selector).toBe(true);
    }
  });

  it("refuses a default value on a ClubDateFormat or ClubFormat parameter", async () => {
    expect(
      await hits(`${HEADER}export function a(y: number, format: ClubDateFormat = { locale: "en-NZ" }) { return [y, format]; }`),
    ).toBe(1);
    expect(
      await hits(`${HEADER}declare const D: ClubFormat;\nexport const b = (format: ClubFormat = D) => format;`),
    ).toBe(1);
    expect(
      await hits(`${HEADER}declare const D: ct.ClubDateFormat;\nexport function c(format: ct.ClubDateFormat = D) { return format; }`),
    ).toBe(1);
  });

  it("refuses an optional ClubDateFormat or ClubFormat parameter", async () => {
    expect(await hits(`${HEADER}export function d(y: number, format?: ClubDateFormat) { return [y, format]; }`)).toBe(1);
    expect(await hits(`${HEADER}export const e = (format?: ClubFormat) => format;`)).toBe(1);
  });

  it("reaches every src/ surface, not only src/lib", async () => {
    const code = `${HEADER}export function f(format: ClubDateFormat = { locale: "en-NZ" }) { return format; }`;
    for (const file of [
      "src/app/(admin)/admin/x/page.tsx",
      "src/components/x.tsx",
      "src/lib/date-only.ts",
      "src/lib/email-templates/chores.ts",
    ]) {
      expect(await hits(code, file), file).toBe(1);
    }
  });

  it("leaves a required parameter, and an unrelated default, alone", async () => {
    expect(await hits(`${HEADER}export function g(format: ClubDateFormat) { return format; }`)).toBe(0);
    expect(await hits(`${HEADER}export function h(format: ClubFormat, fallback = "-") { return [format, fallback]; }`)).toBe(0);
  });
});
