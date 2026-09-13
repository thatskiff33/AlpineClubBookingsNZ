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
 * durations are legitimately `type="number"` — SEVENTY-THREE such boxes remain
 * in this tree, measured rather than estimated — and a guard that flagged them
 * would be switched off within a week.
 *
 * ## What identifies a control
 *
 * FOUR THINGS, and deliberately nothing else: its `id`, its `value`, its
 * `placeholder`, and the text of the label bound to it — a `<Label htmlFor>`
 * naming its literal id, or its own `aria-label`.
 *
 * The whole opening element is NOT read, and that is a fix rather than an
 * oversight (#2932 review). Class names, inline styles, `aria-describedby` ids
 * and change-handler bodies all bleed identity that is not the control's: a
 * guest-count box sharing a hint id that contains "amount" reads as money, and
 * — the other direction, and worse — a `className` or style holding a literal
 * `%` silences the guard on a real money box, with nothing on screen to say
 * that a layout attribute had disarmed it.
 *
 * Identity comes from the control rather than from proximity for a separate
 * reason. The percentage columns in `cancellation-rules-editor.tsx` carry no
 * label of their own: their headings sit in a `<TableHead>` list well above,
 * next to "Card Fixed Fee ($)", so any nearest-text identity reads the fee
 * heading onto the percentage box and reports a false positive in the one file
 * that already does this correctly.
 *
 * ## How that text is read
 *
 * Identifiers here are overwhelmingly camelCase and kebab-case, so the text is
 * SPLIT ON CASE before any word is matched: `nightlyRate` becomes
 * `nightly Rate`, `rateInputs` becomes `rate Inputs`, `dueDays` becomes
 * `due Days`. Without that split a `\b`-anchored word never matches this
 * repository's dominant naming convention at all — `\brates?\b` misses every
 * one of `nightlyRate`, `rateInputs` and `unitCost`, which was most of what
 * this scanner claimed to read (#2932 review). Splitting is also what lets the
 * short, ambiguous words keep their boundaries: `\bcents?\b` still refuses to
 * fire on "percent".
 *
 * Template-literal interpolation is stripped first. Leaving it in made a
 * literal `$` match every templated id in the tree — six false positives on
 * counts and durations, measured.
 *
 * ## The precedence
 *
 * 1. A PERCENTAGE wins outright. A percentage off a price is not money however
 *    many money words surround it, and "Card Refund %"
 *    (`rule.refundPercentage`) is exactly that.
 * 2. A DURATION — days, weeks, months, years, hours, minutes, seconds, a TTL —
 *    wins UNLESS the control also carries a literal currency symbol. That is
 *    the narrowed form (#2932 review): a blanket duration win classified
 *    "Price per year ($)" as not-money, so the override written to keep
 *    "Invoice due days" out was also a hole a real money box could sit in. The
 *    currency symbol is what tells the two apart.
 * 3. Otherwise a money word decides — amount, price, dollar, cent, fee, rate,
 *    cost, charge, refund, currency, deposit, balance, discount, donation,
 *    levy, tax, payment, budget, or a literal `$`.
 * 4. Failing all of those, `step="0.01"` alone is enough. Cent precision on a
 *    number control is a money claim in its own right, and it is the one signal
 *    renaming a state variable or a helper cannot erase. Measured on this tree:
 *    no `type="number"` control uses a cent-precision step for anything but
 *    money, and the single 0.01 step elsewhere is the photo editor's zoom — a
 *    `type="range"` slider this scanner never looks at.
 *
 * ## What it cannot see, stated because the rest of this reads as complete
 *
 * - Only a LITERAL `type="number"` attribute is matched. A spread
 *   (`{...someProps}`) or a computed type is invisible to it.
 * - A label is associated only through a literal `htmlFor`. A money box whose
 *   id is computed — `id={key}` with `<Label htmlFor={key}>` — must therefore
 *   carry its identity in its own `id`, `value`, `placeholder` or `aria-label`;
 *   the label text beside it is not read.
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

/** A percentage. Checked first, and wins outright. */
const PERCENTAGE = /percent|%/i;

/**
 * A duration. Wins unless a currency symbol is also present — precedence step 2
 * in the docblock above.
 */
const DURATION_UNIT =
  /\b(?:days?|weeks?|months?|years?|hours?|minutes?|seconds?|ttls?)\b/i;

/** A literal currency symbol, after template interpolation has been stripped. */
const CURRENCY_SYMBOL = /\$/;

/**
 * A money word.
 *
 * The long, distinctive ones match as substrings, so "pricing", "surcharge" and
 * "prepayment" all count. The short ones — cent, fee, rate, cost, tax, levy —
 * keep `\b` boundaries, because unbounded they fire on "percent", "coffee",
 * "generate" and "costume". Case-splitting the text before matching is what
 * makes those boundaries reachable on camelCase names at all.
 *
 * "total" is deliberately NOT here, and it is the one word the #2932 review
 * proposed that this tree refutes: `maxRedemptionsTotal` ("Total redemptions
 * allowed") is a count, and admitting the word flags it. The school-quote box
 * the word was wanted for is identified twice over without it — by its `price-`
 * id and by its cent-precision step.
 */
const MONEY_WORD =
  /amount|price|dollar|charge|refund|currency|deposit|balance|discount|donation|payment|budget|\b(?:cents?|fees?|rates?|costs?|taxe?s?|lev(?:y|ies))\b|\$/i;

/**
 * A template-literal interpolation opener. Stripped before classification: an
 * `id={`count-${tier}-${request.id}`}` is a guest count, and leaving its `$`
 * in made a literal dollar sign match every templated id in the tree - six
 * false positives on counts and durations, measured on this tree.
 */
const TEMPLATE_INTERPOLATION = /\$\{/g;

/** The `step` values that assert cent precision. */
const CENT_PRECISION_STEP = new Set(["0.01", ".01"]);

/** The attributes that carry a control's own identity. Nothing else is read. */
const IDENTITY_ATTRIBUTES = new Set([
  "id",
  "value",
  "placeholder",
  "aria-label",
]);

/**
 * Every directory the walk must actually reach for its silence to mean
 * anything, and the reason this is a list of names rather than a total.
 *
 * A total only says the walk was big. These say it went to the right places:
 * add any one of `app`, `admin`, `components`, `booking-policies`,
 * `booking-requests`, `ui` or `edit-booking` to `SKIPPED_DIRECTORIES` and the
 * guard fails naming the subtree it stopped reading, instead of quietly
 * scanning a fraction of the tree and reporting clean. Two of the seven boxes
 * this guard was written for live under `src/components/admin/booking-requests`,
 * which is why that one is named at its own depth.
 *
 * A total would also have to be re-measured by every sibling lane editing an
 * admin or booking surface. These prefixes do not move.
 */
export const REQUIRED_SCANNED_SUBTREES = [
  "src/app/(admin)/admin",
  "src/app/(authenticated)",
  "src/app/(public)",
  "src/app/(website-dynamic)",
  "src/components/admin",
  "src/components/admin/booking-policies",
  "src/components/admin/booking-requests",
  "src/components/edit-booking",
  "src/components/ui",
] as const;

export type MoneyNumberInput = {
  /** Repository-relative, forward-slashed. */
  file: string;
  /** 1-based line of the opening tag. */
  line: number;
  /** The tag name, e.g. `Input`. */
  tag: string;
  /** The money signal that classified it. */
  matched: string;
};

/**
 * The escape hatch, and the only one — never an inline comment or a disable.
 * Each entry names a repository-relative file and states in writing why a money
 * box there may stay a browser number control.
 *
 * It is EMPTY, and here is exactly what that proves and what it does not. It
 * proves that NO CONTROL THIS SCANNER READS AS MONEY IS A BROWSER NUMBER INPUT.
 * It does NOT prove that every money box in this tree is spelled
 * `MONEY_INPUT_PROPS`: a money box the classifier cannot identify is silence,
 * not an exemption, and the limits in the docblock above say where that silence
 * lives. The weaker claim is the true one, and a guard sold as proving more than
 * it proves is a defect this repository has shipped before.
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

function attributeName(attribute: ts.JsxAttributeLike): string | null {
  return ts.isJsxAttribute(attribute) ? attribute.name.getText() : null;
}

/** The literal string an attribute holds, or `null` when it is not a literal. */
function literalAttributeValue(attribute: ts.JsxAttributeLike): string | null {
  if (!ts.isJsxAttribute(attribute) || !attribute.initializer) return null;
  const value = attribute.initializer;
  if (ts.isStringLiteral(value)) return value.text;
  if (
    ts.isJsxExpression(value) &&
    value.expression &&
    ts.isStringLiteralLike(value.expression)
  ) {
    return value.expression.text;
  }
  return null;
}

function isNumberTypeAttribute(attribute: ts.JsxAttributeLike): boolean {
  return (
    attributeName(attribute) === "type" &&
    literalAttributeValue(attribute) === "number"
  );
}

/** `step="0.01"`, `step=".01"` or `step={0.01}` — cent precision, however spelled. */
function hasCentPrecisionStep(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
): boolean {
  for (const attribute of node.attributes.properties) {
    if (attributeName(attribute) !== "step") continue;
    const literal = literalAttributeValue(attribute);
    if (literal !== null && CENT_PRECISION_STEP.has(literal)) return true;
    if (
      ts.isJsxAttribute(attribute) &&
      attribute.initializer &&
      ts.isJsxExpression(attribute.initializer) &&
      attribute.initializer.expression &&
      ts.isNumericLiteral(attribute.initializer.expression) &&
      CENT_PRECISION_STEP.has(attribute.initializer.expression.text)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Split identifier text on case and underscore so `\b`-anchored words can reach
 * camelCase and snake_case names. `nightlyRate` -> `nightly Rate`,
 * `XEROFeeCents` -> `XERO Fee Cents`, `unit_cost` -> `unit cost`.
 */
function splitIdentifierWords(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/_/g, " ");
}

/**
 * Classify one control from its identity text. Exported so the guard can drive
 * it with fixtures in both directions without touching the filesystem.
 *
 * `identityText` is the control's `id`, `value`, `placeholder` and bound label
 * — NOT its whole opening element. `centPrecisionStep` is the structural signal
 * from `step`, which is not text at all.
 */
export function classifyNumberInput(
  identityText: string,
  centPrecisionStep = false,
): string | null {
  const text = splitIdentifierWords(
    identityText.replace(TEMPLATE_INTERPOLATION, " "),
  );
  if (PERCENTAGE.test(text)) return null;
  if (DURATION_UNIT.test(text) && !CURRENCY_SYMBOL.test(text)) return null;
  const money = MONEY_WORD.exec(text);
  if (money) return money[0];
  return centPrecisionStep ? 'step="0.01"' : null;
}

/** `<Label htmlFor="literal">…</Label>` text, keyed by the id it names. */
function collectLabelText(parsed: ts.SourceFile): Map<string, string> {
  const labels = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName.getText();
      if (tag === "Label" || tag === "label") {
        for (const attribute of node.openingElement.attributes.properties) {
          if (attributeName(attribute) !== "htmlFor") continue;
          const key = literalAttributeValue(attribute);
          if (key === null) continue;
          labels.set(
            key,
            `${labels.get(key) ?? ""} ${node.children.map((child) => child.getText()).join(" ")}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return labels;
}

/**
 * The control's own identity text: `id`, `value`, `placeholder`, `aria-label`,
 * plus the text of a label that explicitly names its literal id. Nothing else
 * from the element is read — see the docblock above for why.
 */
function identityText(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  labels: Map<string, string>,
): string {
  const parts: string[] = [];
  let literalIdValue: string | null = null;
  for (const attribute of node.attributes.properties) {
    const name = attributeName(attribute);
    if (name === null || !IDENTITY_ATTRIBUTES.has(name)) continue;
    if (!ts.isJsxAttribute(attribute) || !attribute.initializer) continue;
    parts.push(attribute.initializer.getText());
    if (name === "id") literalIdValue = literalAttributeValue(attribute);
  }
  if (literalIdValue !== null) parts.push(labels.get(literalIdValue) ?? "");
  return parts.join(" ");
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
        const matched = classifyNumberInput(
          identityText(node, labels),
          hasCentPrecisionStep(node),
        );
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
