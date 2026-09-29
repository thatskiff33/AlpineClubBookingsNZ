import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import ts from "typescript";
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
 *
 * The one shape a selector cannot see — a type ALIAS of a club format, which
 * would need type resolution — is backed by the census at the bottom, which
 * walks `src/` and allows exactly the kernel's own `ClubDateFormat`.
 * Disk-scanning: run by name.
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

  it("refuses the widened shapes (#3628 re-review, round 2)", async () => {
    const shapes: Record<string, string> = {
      "destructured default": `declare const D: ClubDateFormat;\nexport function a({ format = D }: { format: ClubDateFormat }) { return format; }`,
      "destructured clubFormat default": `declare const D: ClubFormat;\nexport const a2 = ({ clubFormat = D }: { clubFormat: ClubFormat }) => clubFormat;`,
      "optional union with null": `export function b(format?: ClubDateFormat | null) { return format; }`,
      "defaulted union with undefined": `declare const D: ClubDateFormat;\nexport function c(format: ClubDateFormat | undefined = D) { return format; }`,
      "optional Readonly": `export function d(format?: Readonly<ClubDateFormat>) { return format; }`,
      "defaulted Readonly": `declare const D: ClubFormat;\nexport function e(format: Readonly<ClubFormat> = D) { return format; }`,
      "optional Readonly of a union": `export function e2(format?: Readonly<ClubDateFormat | null>) { return format; }`,
      "optional qualified union": `export function f(format?: ct.ClubDateFormat | null) { return format; }`,
      "optional array": `export function f2(formats?: ClubFormat[]) { return formats; }`,
      "options-object optional field": `export function g(opts: { format?: ClubDateFormat }) { return opts; }`,
      "interface optional field": `export interface Options { format?: ClubFormat }`,
      "type-literal alias optional field": `export type Options = { label: string; format?: ClubDateFormat };`,
      "class optional field": `export class K { format?: ClubFormat; }`,
      "interface method optional param": `export interface Renderer { render(y: number, format?: ClubDateFormat): string }`,
      "function-type optional param": `export type Render = (format?: ClubFormat) => string;`,
      "optional param inside an optional function property": `export interface Deps { send?: (format?: ClubFormat) => void }`,
      "rest tuple, optional element": `export function h(...rest: [ClubDateFormat?]) { return rest; }`,
      "rest tuple, optional named element": `export function i(...rest: [format?: ClubDateFormat]) { return rest; }`,
    };
    for (const [name, code] of Object.entries(shapes)) {
      expect(await hits(`${HEADER}${code}`), name).toBe(1);
    }
  });

  it("leaves a function-typed property that REQUIRES its format alone", async () => {
    // xero-credit-sync-checker.ts: the property is optional, the format is not.
    const nearMisses: Record<string, string> = {
      "optional function property, required format param": `export interface Deps { sendAlert?: (report: string, format: ClubFormat) => Promise<void> }`,
      "union with a function type (config/modules.ts)": `export type ModuleDependency = string | ((format: ClubFormat) => string);`,
      "required options-object field": `export function j(opts: { format: ClubDateFormat }) { return opts; }`,
      "required interface field": `export interface Options { format: ClubFormat }`,
      "unrelated destructured default": `export function k({ label = "-" }: { label?: string }) { return label; }`,
      "required interface method param": `export interface Renderer { render(format: ClubDateFormat): string }`,
    };
    for (const [name, code] of Object.entries(nearMisses)) {
      expect(await hits(`${HEADER}${code}`), name).toBe(0);
    }
  });

  it("cannot see a type alias — which is why the census below exists", async () => {
    expect(
      await hits(`${HEADER}type F = ClubDateFormat;\nexport function l(format?: F) { return format; }`),
    ).toBe(0);
  });

  it("leaves a required parameter, and an unrelated default, alone", async () => {
    expect(await hits(`${HEADER}export function g(format: ClubDateFormat) { return format; }`)).toBe(0);
    expect(await hits(`${HEADER}export function h(format: ClubFormat, fallback = "-") { return [format, fallback]; }`)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The alias census: the shape no selector can see.
// ---------------------------------------------------------------------------

const CLUB_FORMAT_NAME = /^Club(?:Date)?Format$/;

/** The only alias of a club format `src/` may declare: the kernel's own. */
const ALLOWED_CLUB_FORMAT_ALIASES = ["src/lib/club-time/types.ts:ClubDateFormat"];

function walkSource(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walkSource(full, out);
    } else if (/\.[cm]?tsx?$/.test(name) && !/\.(test|spec)\./.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function referenceName(node: ts.TypeReferenceNode): string {
  return ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text;
}

/**
 * Whether a type IS a club format by the same reading as the lint arm: the
 * reference itself, a union / intersection member, an array element, a
 * generic argument (`Readonly<ClubFormat>`), or a readonly / parenthesised
 * wrapper. A function type that TAKES a format (`(format: ClubFormat) =>
 * string`) is not one.
 */
function isClubFormatType(node: ts.TypeNode): boolean {
  if (ts.isTypeReferenceNode(node)) {
    if (CLUB_FORMAT_NAME.test(referenceName(node))) return true;
    return (node.typeArguments ?? []).some(isClubFormatType);
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.some(isClubFormatType);
  }
  if (ts.isArrayTypeNode(node)) return isClubFormatType(node.elementType);
  if (ts.isTypeOperatorNode(node) || ts.isParenthesizedTypeNode(node)) {
    return isClubFormatType(node.type);
  }
  return false;
}

function extendsClubFormat(heritage: ts.ExpressionWithTypeArguments): boolean {
  const target = heritage.expression;
  if (ts.isIdentifier(target) && CLUB_FORMAT_NAME.test(target.text)) return true;
  if (ts.isPropertyAccessExpression(target) && CLUB_FORMAT_NAME.test(target.name.text)) return true;
  return (heritage.typeArguments ?? []).some(isClubFormatType);
}

/**
 * `file:Name` for every alias of a club format in `source`: a type alias, an
 * extending interface, or an import / re-export that RENAMES one
 * (`import type { ClubDateFormat as F }`) — a rename is an alias the lint arm,
 * matching by name, would not follow.
 */
export function findClubFormatAliases(file: string, source: string): string[] {
  if (!/\bClub(?:Date)?Format\b/.test(source)) return [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && isClubFormatType(node.type)) {
      found.push(`${file}:${node.name.text}`);
    }
    if (
      ts.isInterfaceDeclaration(node) &&
      (node.heritageClauses ?? []).some((clause) => clause.types.some(extendsClubFormat))
    ) {
      found.push(`${file}:${node.name.text}`);
    }
    if (
      (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) &&
      node.propertyName !== undefined &&
      CLUB_FORMAT_NAME.test(node.propertyName.text) &&
      node.propertyName.text !== node.name.text
    ) {
      found.push(`${file}:${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe("#3566: no alias of a club format outside the kernel (the census for what lint cannot see)", () => {
  it("counts the shapes it looks for", () => {
    const find = (code: string) => findClubFormatAliases("x.ts", code).length;
    expect(find("type F = ClubDateFormat;")).toBe(1);
    expect(find("type F = ClubFormat | null;")).toBe(1);
    expect(find("type F = Readonly<ClubFormat>;")).toBe(1);
    expect(find("type F = ct.ClubDateFormat & { extra: 1 };")).toBe(1);
    expect(find("type F = Readonly<ClubDateFormat | undefined>[];")).toBe(1);
    expect(find("interface F extends ClubDateFormat {}")).toBe(1);
    expect(find("interface F extends Partial<ClubFormat> {}")).toBe(1);
    expect(find("interface F extends ct.ClubFormat {}")).toBe(1);
    expect(find('import type { ClubDateFormat as F } from "@/lib/club-time";')).toBe(1);
    expect(find('export type { ClubFormat as F } from "@/lib/club-format";')).toBe(1);
    expect(find('import type { ClubDateFormat } from "@/lib/club-time";')).toBe(0);
    expect(find('import type { ClubDateFormat as ClubDateFormat } from "@/lib/club-time";')).toBe(0);
    // A function type that TAKES a format keeps it required; an object type
    // with a format field is judged by the lint arm, not here.
    expect(find("type Dep = string | ((format: ClubFormat) => string);")).toBe(0);
    expect(find("type Deps = { format: ClubFormat };")).toBe(0);
    expect(find("// type F = ClubDateFormat;")).toBe(0);
  });

  it("finds exactly the kernel's own ClubDateFormat in src/", () => {
    const found: string[] = [];
    for (const full of walkSource(path.join(ROOT, "src"))) {
      const file = path.relative(ROOT, full).split(path.sep).join("/");
      found.push(...findClubFormatAliases(file, readFileSync(full, "utf8")));
    }
    expect(found.sort()).toEqual(ALLOWED_CLUB_FORMAT_ALIASES);
  });
});
