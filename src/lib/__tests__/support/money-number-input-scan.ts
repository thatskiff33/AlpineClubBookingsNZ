import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * THE ONE SCANNER for money boxes spelled `type="number"` (#2932,
 * `INV-MONEY-003`).
 *
 * `INV-MONEY-003` says a money box is `type="text"` with `inputMode="decimal"`
 * — `MONEY_INPUT_PROPS` from `@/lib/money-input` — because HTML's
 * value-sanitization algorithm strips a `type="number"` control's value to `""`
 * the moment it does not parse as a floating-point number. `"50abc"`,
 * `"$45.00"` and `"1,000.00"` therefore reach the change handler as `""`,
 * indistinguishable from a deliberately cleared box, and the exact parser this
 * repository routes every typed amount through never sees what was typed.
 *
 * The rule was written and the then-current surfaces converted in #2685/#2712.
 * Nothing stopped a new one appearing, and seven had: the credit adjustment
 * box, the refund-request approval amount, both joining-fee overrides, the
 * whole-lodge price override, the school quote total and the per-guest-night
 * rate. All seven already CALLED the exact parser; the browser had thrown the
 * text away before it ran.
 *
 * The hard part is discrimination, not detection. Counts, percentages and
 * durations are legitimately `type="number"` — there are around eighty such
 * boxes in this tree — and a guard that flagged all of them would be switched
 * off within a week. So this scanner classifies each control from ITS OWN
 * source text, which is where the state name, the id, the placeholder and the
 * change handler all live:
 *
 * - a NON-MONEY unit named anywhere in the control wins outright: a percentage,
 *   or a duration in days/weeks/months/years/hours/minutes/seconds. That
 *   precedence is what keeps "Card Refund %" (`rule.refundPercentage`) and
 *   "Invoice due days" (`dueDays`) out, even though "refund" and "invoice" are
 *   money words;
 * - otherwise a money word — amount, price, dollar, cent, fee, rate, cost,
 *   charge, refund, currency, or a literal `$` — makes it a money box.
 *
 * Reading the control's own text rather than a nearby label is deliberate. The
 * percentage columns in `cancellation-rules-editor.tsx` carry no label of their
 * own: their headings sit in a `<TableHead>` list well above, next to
 * "Card Fixed Fee ($)", so any proximity-based identity would read the fee
 * heading onto the percentage box and report a false positive in the one file
 * that already does this correctly.
 */
const REPO = process.cwd();
const SKIPPED_DIRECTORIES = new Set([
  ".artifacts",
  ".git",
  ".next",
  "__tests__",
  "coverage",
  "node_modules",
]);
const TEST_FILE = /(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * A unit that is not money, named anywhere in the control. Checked FIRST and
 * wins: a percentage OFF a price, or a deadline measured in days, is not a
 * money box however many money words surround it.
 */
const NON_MONEY_UNIT =
  /percent|%|\bdays?\b|\bweeks?\b|\bmonths?\b|\byears?\b|\bhours?\b|\bminutes?\b|\bseconds?\b|ttl/i;

/** A money word. Only consulted once `NON_MONEY_UNIT` has not matched. */
const MONEY_WORD =
  /amount|price|dollar|\bcents?\b|\bfees?\b|\brates?\b|\bcosts?\b|charge|refund|currency|\$/i;

/**
 * A template-literal interpolation opener. Stripped before classification: an
 * `id={`count-${tier}-${request.id}`}` is a guest count, and leaving its `$`
 * in made a literal dollar sign match every templated id in the tree - six
 * false positives on counts and durations, measured on this tree.
 */
const TEMPLATE_INTERPOLATION = /\$\{/g;

export type MoneyNumberInput = {
  /** Repository-relative, forward-slashed. */
  file: string;
  /** 1-based line of the opening tag. */
  line: number;
  /** The tag name, e.g. `Input`. */
  tag: string;
  /** The money word that classified it. */
  matched: string;
};

/**
 * The escape hatch, and the only one — never an inline comment or a disable.
 * Each entry names a repository-relative file and states in writing why a money
 * box there may stay a browser number control. It is EMPTY, and an empty list
 * is the claim: every money box in this tree is spelled `MONEY_INPUT_PROPS`.
 */
export const MONEY_NUMBER_INPUT_EXEMPTIONS: ReadonlyArray<{
  file: string;
  reason: string;
}> = [];

/** Every `.tsx` file that can hold JSX, outside tests. */
export function jsxSourceFiles(root: string = REPO): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full);
      } else if (entry.name.endsWith(".tsx") && !TEST_FILE.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(join(root, "src"));
  return files;
}

function isNumberTypeAttribute(attribute: ts.JsxAttributeLike): boolean {
  if (!ts.isJsxAttribute(attribute)) return false;
  if (attribute.name.getText() !== "type") return false;
  const value = attribute.initializer;
  if (!value) return false;
  if (ts.isStringLiteral(value)) return value.text === "number";
  if (
    ts.isJsxExpression(value) &&
    value.expression &&
    ts.isStringLiteralLike(value.expression)
  ) {
    return value.expression.text === "number";
  }
  return false;
}

/**
 * Classify one control's own source text. Exported so the guard can drive it
 * with fixtures in both directions without touching the filesystem.
 */
export function classifyNumberInput(controlText: string): string | null {
  const text = controlText.replace(TEMPLATE_INTERPOLATION, " ");
  if (NON_MONEY_UNIT.test(text)) return null;
  const money = MONEY_WORD.exec(text);
  return money ? money[0] : null;
}

/** `<Label htmlFor="literal">…</Label>` text, keyed by the id it names. */
function collectLabelText(parsed: ts.SourceFile): Map<string, string> {
  const labels = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName.getText();
      if (tag === "Label" || tag === "label") {
        for (const attribute of node.openingElement.attributes.properties) {
          if (
            ts.isJsxAttribute(attribute) &&
            attribute.name.getText() === "htmlFor" &&
            attribute.initializer &&
            ts.isStringLiteral(attribute.initializer)
          ) {
            const key = attribute.initializer.text;
            labels.set(
              key,
              `${labels.get(key) ?? ""} ${node.children.map((child) => child.getText()).join(" ")}`,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return labels;
}

/** A control's own `id`, when it is a plain string rather than a template. */
function literalId(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
): string | null {
  for (const attribute of node.attributes.properties) {
    if (
      ts.isJsxAttribute(attribute) &&
      attribute.name.getText() === "id" &&
      attribute.initializer &&
      ts.isStringLiteral(attribute.initializer)
    ) {
      return attribute.initializer.text;
    }
  }
  return null;
}

/** Every money-classified `type="number"` control in one file's source. */
export function scanSourceForMoneyNumberInputs(
  file: string,
  source: string,
): MoneyNumberInput[] {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const labels = collectLabelText(parsed);
  const found: MoneyNumberInput[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.attributes.properties.some(isNumberTypeAttribute)) {
        const id = literalId(node);
        // The control's own text, plus the text of a label that explicitly
        // names its id. Only an `htmlFor` association counts — proximity does
        // not — so a heading sitting above an unrelated box cannot be read
        // onto it.
        const text = `${node.getText()} ${(id && labels.get(id)) ?? ""}`;
        const matched = classifyNumberInput(text);
        if (matched) {
          found.push({
            file,
            line:
              parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line +
              1,
            tag: node.tagName.getText(),
            matched,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

/** The whole tree, repository-relative. */
export function scanTreeForMoneyNumberInputs(
  root: string = REPO,
): MoneyNumberInput[] {
  return jsxSourceFiles(root).flatMap((absolute) => {
    const file = relative(root, absolute).split("\\").join("/");
    return scanSourceForMoneyNumberInputs(file, readFileSync(absolute, "utf8"));
  });
}
