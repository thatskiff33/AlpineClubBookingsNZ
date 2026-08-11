import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

/*
  Every test here is pure static analysis: parse ~230 admin source files with
  TypeScript's own parser, then walk the ASTs. That is CPU-bound with no I/O to
  wait on, so its wall time scales with how many other vitest workers are
  competing for the box — not with anything about the tree it is checking.

  Standalone the whole file runs in about 3s. Inside a full `npm test` on a
  loaded machine the same work measured 24s for the file and 5.4s for its
  slowest test, which tripped vitest's 5s default: a red suite with no defect
  behind it. The suite-level hoisting further down cut the real cost (6.5s -> 3s
  of test time, slowest test 1.6s -> 1.1s), and this raises the ceiling so the
  margin does not depend on machine load. Matches the convention in
  `src/lib/__tests__/phase-b2.test.ts`.
*/
vi.setConfig({ testTimeout: 30_000 });

/*
  #2160 contract test — the ONE invariant the banner rollout must never break.

  `describeReason={false}` strips a control's own explanation of why it is
  gated: no `title`, no `aria-describedby`, no sr-only line. That is only an
  improvement when the surrounding section states the reason once, in the
  reading order, via `AdminViewOnlySectionBanner`. Opting a control out WITHOUT
  a covering banner deletes the explanation outright, which is strictly worse
  than the per-button affordance it replaced.

  A per-file check is what makes the property mechanically verifiable. Coverage
  is asserted within a single component, because that is the only scope where a
  reader (and this test) can see that the banner really does render above the
  control. A banner in some ancestor page MIGHT cover a child component's
  buttons, but nothing local proves the ancestor always renders it, so the rule
  is deliberately the strict one: opt out only where the banner is in the same
  file.
*/

const SRC = join(process.cwd(), "src");

/**
 * `source` with every comment blanked out — each comment character replaced by
 * a space, newlines kept — so offsets and line numbers still line up with the
 * file on disk.
 *
 * Every check below asks "does this file CONTAIN this text", and raw text can
 * not tell a call site from prose ABOUT a call site. That distinction has now
 * bitten this branch twice, both times inflating the published counts by one:
 * `view-only-action.tsx`'s JSDoc quotes `describeReason={false}` while
 * documenting when to pass it, and `public-booking-requests-section.tsx`
 * carries a JSX comment narrating the #2142 conversion that quotes it too.
 *
 * Excluding those two files by name would only postpone the third instance, so
 * the strip is structural instead. It uses TypeScript's own PARSER — a full
 * `createSourceFile`, then every comment range attached to every token — rather
 * than a regex or a bare scanner.
 *
 * A regex can not reliably tell a comment from a `/*` inside a string, a
 * template literal, or a regex literal, and a naive JSX-comment pattern
 * (`\{\s*\/\*[\s\S]*?\*\/\s*\}`) silently swallows an object type that merely
 * OPENS with a JSDoc member comment, taking the real call sites inside it along
 * with the prose.
 *
 * A bare `ts.createScanner` is not enough either, and #2166 caught it being
 * wrong. The scanner is a LEXER, not a parser: it cannot resume a template
 * literal after a `${…}` substitution, because that resumption is the parser's
 * job (`rescanTemplateToken`). So in
 * `booking-policies/public-booking-requests-section.tsx`, the closing
 * `` `} `` of a `className={`…${…}`}` template opened a BOGUS template literal
 * that ran forward until the next backtick — 700-odd characters later, inside
 * the `#2142` JSX comment. The comment therefore never opened as far as the
 * lexer was concerned, its prose was lexed as ordinary code, and the
 * `describeReason={false}` it QUOTES was counted as a real opt-out. That is
 * precisely the miscount this helper exists to prevent, in its third incarnation.
 *
 * Both leading AND trailing comment ranges are collected. A JSX comment
 * (`{/* … *\/}`) sits on the same line as the `{` that opens it, and
 * `getLeadingCommentRanges` by design only reports comments that follow a line
 * break — so a leading-only sweep misses exactly the JSX-comment form this file
 * family keeps hitting.
 */
function stripComments(source: string): string {
  const sourceFile = ts.createSourceFile(
    "in-memory.tsx",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  const chars = source.split("");
  const blank = (start: number, end: number) => {
    for (let i = start; i < end; i += 1) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  };

  const visit = (node: ts.Node): void => {
    const children = node.getChildren(sourceFile);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    for (const range of ts.getLeadingCommentRanges(
      source,
      node.getFullStart(),
    ) ?? []) {
      blank(range.pos, range.end);
    }
    for (const range of ts.getTrailingCommentRanges(source, node.getEnd()) ??
      []) {
      blank(range.pos, range.end);
    }
  };
  visit(sourceFile);

  return chars.join("");
}

// Plain recursive walk rather than a glob library: this is the only place in
// the repo that would need one, and knip rightly flags a dependency added for a
// single test. (`typescript` is already a devDependency — the parser above
// reuses it rather than adding anything.)
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walk(full, out);
    } else if (
      entry.name.endsWith(".tsx") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Resolve an import specifier to the file it names, for the two forms this repo
 * uses for components: the `@/` alias and a relative path. Anything else (a
 * bare package specifier) resolves to null and is ignored — a node_module can
 * not render our banner.
 */
function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith("."))
    base = resolve(dirname(fromFile), specifier);
  else return null;

  for (const candidate of [`${base}.tsx`, join(base, "index.tsx")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Whether the specific exported component `name` in `source` renders a banner,
 * as opposed to merely living in a file that contains one. File granularity is
 * too coarse: `page-content-panel.tsx` exports both `PageContentPanel` (which
 * renders a banner) and `WysiwygEditor` (a plain editor widget that does not),
 * and treating every import from that file as banner-bearing would flag two
 * innocent panels. This slices the named export's body — from its declaration
 * to the next top-level `export` — and looks for the banner inside it.
 */
function componentRendersBanner(source: string, name: string): boolean {
  const declRe = new RegExp(`^export\\s+(?:function|const)\\s+${name}\\b`, "m");
  const start = source.search(declRe);
  if (start === -1) return false;

  const rest = source.slice(start + 1);
  const nextExport = rest.search(/^export\s+(?:function|const|default)\b/m);
  const body = nextExport === -1 ? rest : rest.slice(0, nextExport);
  return body.includes("<AdminViewOnlySectionBanner");
}

/**
 * The opening tag of EVERY `<Name` element in `source`, e.g.
 * `<AssignmentForm ... />`. Attribute values routinely contain `>` (arrow
 * functions: `onChanged={() => …}`), so a tag can not be matched with a
 * regex — this walks the text tracking brace depth and string literals, and
 * ends each tag at the first `>` that is outside both.
 *
 * Every render site is returned, not just the first. Checking only the first
 * made the nesting rule below evadable in exactly the likeliest direction: a
 * second, un-opted-out `<Child>` added BELOW an existing compliant one — the
 * shape you get by copying a working render site and dropping the prop — was
 * never looked at, so the earlier compliant site kept the suite green.
 */
function openingTags(source: string, name: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(new RegExp(`<${name}\\b`, "g"))) {
    const start = match.index;
    let depth = 0;
    let quote: string | null = null;
    for (let i = start; i < source.length; i += 1) {
      const char = source[i];
      if (quote) {
        if (char === quote && source[i - 1] !== "\\") quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (char === ">" && depth === 0) {
        tags.push(source.slice(start, i + 1));
        break;
      }
    }
  }
  return tags;
}

function adminSourceFiles(): string[] {
  return walk(SRC).filter((file) =>
    relative(SRC, file).split(sep).join("/").includes("admin"),
  );
}

/* ------------------------------------------------------------------------ *
   #2168 — the parent-vouching mechanism, and the AST it is checked with.

   The per-file rule above is deliberately strict: opt a control out only where
   the banner is in the SAME file. `/admin/members/[id]` cannot satisfy it. Nine
   per-record cards render on that one page, so a banner in each of them stacks
   three identical banners in the Family group and nine on the page; the owner's
   decision (#2168) is ONE banner per page. That puts the banner in the PARENT
   file and the opt-outs in CHILD files.

   The rule is NOT relaxed to allow that. Relaxing it — "a child may opt out if
   some ancestor might render a banner" — reopens exactly the hazard the rule
   exists to prevent: an opt-out with no covering banner deletes the explanation
   outright, which is strictly worse than the per-button reason it replaces.

   Instead a parent gets an explicit, greppable way to VOUCH for a child, and
   the vouch is verified rather than trusted:

     - the child declares an optional prop `ancestorRendersViewOnlyBanner`,
       DEFAULTING TO FALSE, and writes `describeReason={!ancestorRenders…}`;
     - a parent that really does render the banner above the child passes the
       literal `true` AT the render site.

   The default is what makes this safe rather than merely documented: the
   opt-out cannot happen unless someone asks for it, at the place a reader sees
   it. A child rendered standalone, in a dialog, or by a new parent keeps its
   per-button reason automatically.

   The checks below then close each way the vouch could be a lie. They run over
   the TypeScript AST, not text. That is not only for precision: an attribute in
   the AST is a node, and prose about an attribute is trivia, so these checks
   are immune BY CONSTRUCTION to the comment/prose miscount that has bitten the
   text-based assertions in this file repeatedly.
 * ------------------------------------------------------------------------ */

const VOUCH_PROP = "ancestorRendersViewOnlyBanner";
const BANNER = "AdminViewOnlySectionBanner";
const NOTICE = "AdminViewOnlyNotice";

/* ------------------------------------------------------------------------ *
   #2324 — the THIRD coverage rule: the wizard shell vouching for its steps.

   #2168 gave a parent an explicit way to vouch for a child, verified at the
   child's JSX render site. The shared guided-setup shell (`IntegrationWizard`,
   #2080 — the frame behind the Xero, Stripe, Google, backup and Lodge Display
   setups) cannot use it, and not by oversight: a step is supplied by the
   provider's config as a `render(context, helpers)` callback and CALLED from
   the shell's file, so nowhere in the source does a parent element sit above a
   step's control. Both #2160 rules (banner in the same file, or a vouch at the
   render site) are blind to the relationship.

   The result was a shell where the easiest thing to write was the least
   accessible one: the display wizard's steps carried per-button reasons and sat
   in the exception list, while the other four used a plain disabled `Button`
   that said nothing at all.

   The owner's decision on #2324 (option A + A1) closes it WITHOUT inventing a
   third spelling of `describeReason`. There are still exactly two — the closed
   world below is unchanged, and a third spelling is still a failure. What is
   new is the CHANNEL the existing vouch travels down, and it is narrow:

     - `WizardStepHelpers` carries `ancestorRendersViewOnlyBanner: true`, typed
       as the required LITERAL `true`, so the shell cannot hand a step a false
       vouch and a provider cannot fabricate one from something weaker;
     - the shell sets it because it renders the banner in EVERY branch;
     - a provider config forwards it, at the step's render site, as
       `ancestorRendersViewOnlyBanner={helpers.ancestorRendersViewOnlyBanner}`
       — where `helpers` is that `WizardStepConfig.render` callback's OWN second
       parameter;
     - the step body then reads it in the ordinary #2168 shape: a prop
       defaulting to false, used only as `describeReason={!prop}`.

   `wizardVouchExpression` recognises that one spelling; `wizardStepRenderArrow`
   is what makes it un-spreadable to ordinary pages, because it insists the
   render site really is inside a `WizardStepConfig.render`. The test itself then
   re-proves the shell's half rather than trusting it — the flag's type, the
   shell setting it, and the banner appearing unconditionally in every branch the
   shell can return.

   Scope stays the reviewer's job, as it is for #2168: the banner states ONE
   permission area (whatever the provider passed as `canEdit`), so a control
   gated on a narrower one must NOT be handed the vouch. Xero's, Stripe's,
   Google's and the backups' credential writes need Full Admin on top of the
   wizard's area and keep their own reason for that reason; the display wizard's
   `support`-gated module switch does too. That is the same judgement that keeps
   `member-credit-card.tsx` un-vouched, and it is not statically decidable.
 * ------------------------------------------------------------------------ */

/*
  The published census, in ONE place.

  Three documents and one JSDoc block quote these numbers as fact, and they have
  drifted twice — once by being counted from raw text (a `describeReason={false}`
  inside a comment counted as a call site), and once by a doc being updated while
  a sibling doc was not. The census test below measures them; the
  "figures the docs publish" test below reads those sources and fails
  when any of them no longer states the measured value. So a rollout change
  cannot land with the prose out of step: both tests fail, and the fix is always
  to re-measure and update every place together — never to loosen an assertion.
*/
const FIGURES = {
  /** Every `<ViewOnlyActionButton>` render site in the admin tree. */
  callSites: 319,
  /** Those that hand their explanation to a banner, by either rule. */
  optOuts: 268,
  /** `describeReason={false}` — needs a banner in the SAME file. */
  staticOptOuts: 237,
  /** `describeReason={!ancestorRendersViewOnlyBanner}` — needs a vouch. */
  vouchedOptOuts: 31,
  /** …of the vouched: proved at a parent's own JSX render site (#2168). */
  renderSiteVouchedOptOuts: 26,
  /** …of the vouched: proved through the wizard shell's channel (#2324). */
  shellVouchedOptOuts: 5,
  /** Controls that KEEP the per-button reason, and the files holding them. */
  exceptions: 51,
  exceptionFiles: 28,
  /** The remainder bucket: neither a member detail card nor dialog-only. */
  leafControls: 37,
  leafFiles: 22,
  /** Components that render an `AdminViewOnlySectionBanner`. */
  bannerComponents: 84,
} as const;

const WIZARD_SHELL = "IntegrationWizard";
const WIZARD_HELPERS_TYPE = "WizardStepHelpers";
const WIZARD_SHELL_REL =
  "components/admin/integration-wizard/integration-wizard.tsx";
const WIZARD_TYPES_REL = "components/admin/integration-wizard/types.ts";

interface AdminFile {
  file: string;
  rel: string;
  ast: ts.SourceFile;
}

function parseAdminFiles(): AdminFile[] {
  return adminSourceFiles().map((file) => ({
    file,
    rel: relative(SRC, file).split(sep).join("/"),
    ast: ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TSX,
    ),
  }));
}

function eachNode(root: ts.Node, visit: (node: ts.Node) => void): void {
  visit(root);
  root.forEachChild((child) => eachNode(child, visit));
}

type JsxTag = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function isJsxTag(node: ts.Node): node is JsxTag {
  return ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node);
}

function tagName(node: JsxTag): string {
  return node.tagName.getText(node.getSourceFile());
}

function jsxTags(ast: ts.SourceFile, name?: string): JsxTag[] {
  const out: JsxTag[] = [];
  eachNode(ast, (node) => {
    if (isJsxTag(node) && (name === undefined || tagName(node) === name)) {
      out.push(node);
    }
  });
  return out;
}

function attr(node: JsxTag, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (p): p is ts.JsxAttribute =>
      ts.isJsxAttribute(p) && p.name.getText(node.getSourceFile()) === name,
  );
}

function hasSpread(node: JsxTag): boolean {
  return node.attributes.properties.some(ts.isJsxSpreadAttribute);
}

/** The expression inside `attr={…}`, or null for a bare `attr`. */
function attrExpression(a: ts.JsxAttribute): ts.Expression | null {
  if (!a.initializer) return null;
  if (ts.isJsxExpression(a.initializer))
    return a.initializer.expression ?? null;
  return a.initializer;
}

/**
 * The nearest enclosing render root of `node`: the `return` statement it is
 * returned from, or the arrow function it is the concise body of. A callback
 * boundary (`items.map((x) => <Child … />)`) therefore roots at the arrow, not
 * at the outer return — which is what makes "the banner and the child are in
 * the same rendered tree" mean it.
 */
function renderRoot(node: ts.Node): ts.Node | null {
  let cur: ts.Node = node;
  while (cur.parent) {
    if (ts.isReturnStatement(cur.parent)) return cur.parent;
    if (
      (ts.isArrowFunction(cur.parent) || ts.isFunctionExpression(cur.parent)) &&
      cur.parent.body === cur
    ) {
      return cur.parent;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * Whether `node` is reached UNCONDITIONALLY from `root` — no `? :`, no `&&`/
 * `||`, no callback in between. A banner rendered under a condition proves
 * nothing about the branch that renders the child.
 */
function unconditionalFrom(node: ts.Node, root: ts.Node): boolean {
  let cur: ts.Node = node;
  while (cur !== root) {
    const parent: ts.Node | undefined = cur.parent;
    if (!parent) return false;
    if (ts.isConditionalExpression(parent)) return false;
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return false;
    }
    if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
      return false;
    }
    cur = parent;
  }
  return true;
}

function unwrapParens(node: ts.Expression): ts.Expression {
  let cur = node;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

/**
 * Every place `ast` renders the banner: the element itself, plus `{someConst}`
 * where `someConst` is a `const x = <AdminViewOnlySectionBanner …>` hoisted
 * above a loading early-return. The hoisted-const form is the house idiom for
 * keeping the live region mounted in every branch (see the early-return test
 * below), so a check that only recognised the literal element would reject
 * exactly the files that get this right. A const whose initializer is itself
 * conditional (`cond ? <Banner/> : null`) is NOT counted: it does not prove the
 * banner renders.
 */
function bannerRenderSites(ast: ts.SourceFile): ts.Node[] {
  const hoisted = new Set<string>();
  eachNode(ast, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return;
    if (!ts.isIdentifier(node.name)) return;
    const init = unwrapParens(node.initializer);
    const isBannerElement =
      (ts.isJsxElement(init) && tagName(init.openingElement) === BANNER) ||
      (ts.isJsxSelfClosingElement(init) && tagName(init) === BANNER);
    if (isBannerElement) hoisted.add(node.name.text);
  });

  const sites: ts.Node[] = [];
  eachNode(ast, (node) => {
    if (isJsxTag(node) && tagName(node) === BANNER) {
      sites.push(node);
      return;
    }
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isIdentifier(node.expression) &&
      hoisted.has(node.expression.text)
    ) {
      sites.push(node);
    }
  });
  return sites;
}

/**
 * The banner's opening tag behind a render site: the tag itself, or the tag
 * inside the initializer of the hoisted const the site names. Used to read the
 * vouching banner's own `canEdit`, which the render site alone does not show.
 */
function bannerTagOf(ast: ts.SourceFile, site: ts.Node): JsxTag | null {
  if (isJsxTag(site)) return site;
  if (
    !ts.isJsxExpression(site) ||
    !site.expression ||
    !ts.isIdentifier(site.expression)
  ) {
    return null;
  }
  const name = site.expression.text;
  let found: JsxTag | null = null;
  eachNode(ast, (node) => {
    if (found) return;
    if (!ts.isVariableDeclaration(node) || !node.initializer) return;
    if (!ts.isIdentifier(node.name) || node.name.text !== name) return;
    const init = unwrapParens(node.initializer);
    if (ts.isJsxElement(init) && tagName(init.openingElement) === BANNER) {
      found = init.openingElement;
    } else if (ts.isJsxSelfClosingElement(init) && tagName(init) === BANNER) {
      found = init;
    }
  });
  return found;
}

/**
 * Every place `ast` MOUNTS the banner, for the live-region check below.
 *
 * Deliberately more permissive than `bannerRenderSites`, and the difference is
 * the point. That helper answers "does this parent provably RENDER a banner
 * above the child it vouches for", so it insists on a bare banner element and
 * refuses a conditional const. This one answers a different question — "is the
 * same wrapper mounted in every branch this component can return" — and for
 * that:
 *
 *   - a const that wraps the banner in a layout element
 *     (`const b = <div id={…}><AdminViewOnlySectionBanner …/></div>`) counts.
 *     Four panels use that form to hang `aria-describedby` off the wrapper;
 *     refusing it would flag the files that get this right.
 *   - a const whose initializer is conditional
 *     (`renderViewOnlyBanner ? <Banner …/> : null`) counts too. If it resolves
 *     to null, NO branch shows a banner, which is consistent — the defect this
 *     guards is a banner that appears in some branches and not others.
 *
 * Neither relaxation touches the vouching checks, which keep the strict helper.
 */
function bannerMountSites(ast: ts.SourceFile): ts.Node[] {
  const hoisted = new Set<string>();
  eachNode(ast, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return;
    if (!ts.isIdentifier(node.name)) return;
    let wrapsBanner = false;
    eachNode(node.initializer, (inner) => {
      if (isJsxTag(inner) && tagName(inner) === BANNER) wrapsBanner = true;
    });
    if (wrapsBanner) hoisted.add(node.name.text);
  });

  const sites: ts.Node[] = [];
  eachNode(ast, (node) => {
    if (isJsxTag(node) && tagName(node) === BANNER) {
      sites.push(node);
      return;
    }
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isIdentifier(node.expression) &&
      hoisted.has(node.expression.text)
    ) {
      sites.push(node);
    }
  });
  return sites;
}

/** The nearest enclosing function of any kind, or null at the file top level. */
function enclosingFunction(node: ts.Node): ts.Node | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur)
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  eachNode(node, (inner) => {
    if (
      ts.isJsxElement(inner) ||
      ts.isJsxSelfClosingElement(inner) ||
      ts.isJsxFragment(inner)
    ) {
      found = true;
    }
  });
  return found;
}

/**
 * The `return`s that make up `fn`'s own rendered output, in source order: those
 * that return JSX and belong to `fn` DIRECTLY, not to a callback inside it.
 *
 * Both filters carry weight. Returning JSX excludes the handler and effect
 * preconditions (`if (loading || !member) return;`) that a text search cannot
 * tell from a render early-return — that confusion is exactly what made the
 * previous version of the guard below vacuous. Ownership by `fn` excludes the
 * `items.map((x) => <Row …/>)` callbacks, which render rows, not branches.
 */
function renderReturns(fn: ts.Node): ts.ReturnStatement[] {
  const out: ts.ReturnStatement[] = [];
  eachNode(fn, (node) => {
    if (!ts.isReturnStatement(node) || !node.expression) return;
    if (enclosingFunction(node) !== fn) return;
    if (!containsJsx(node.expression)) return;
    out.push(node);
  });
  return out.sort((a, b) => a.getStart() - b.getStart());
}

/** The `if (…)` condition guarding `ret` inside `fn`, if it has one. */
function guardCondition(ret: ts.Node, fn: ts.Node): ts.Expression | null {
  let cur: ts.Node = ret;
  while (cur.parent && cur.parent !== fn) {
    if (ts.isIfStatement(cur.parent) && cur.parent.thenStatement === cur) {
      return cur.parent.expression;
    }
    cur = cur.parent;
  }
  return null;
}

/** `describeReason` forms, classified. */
type OptOutKind = "explicit-true" | "static" | "vouched" | "unrecognised";

function classifyDescribeReason(a: ts.JsxAttribute): OptOutKind {
  const expr = attrExpression(a);
  // Bare `describeReason` and `describeReason={true}` are the default: the
  // control explains itself. Not an opt-out at all.
  if (expr === null) return "explicit-true";
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return "explicit-true";
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return "static";
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isIdentifier(expr.operand) &&
    expr.operand.text === VOUCH_PROP
  ) {
    return "vouched";
  }
  return "unrecognised";
}

function describeReasonAttrs(ast: ts.SourceFile): ts.JsxAttribute[] {
  return jsxTags(ast, "ViewOnlyActionButton")
    .map((tag) => attr(tag, "describeReason"))
    .filter((a): a is ts.JsxAttribute => a !== undefined);
}

/** Exported component names in `ast` that destructure `VOUCH_PROP`. */
function vouchChildExports(ast: ts.SourceFile): string[] {
  const names: string[] = [];
  eachNode(ast, (node) => {
    if (!ts.isBindingElement(node)) return;
    if (!ts.isIdentifier(node.name) || node.name.text !== VOUCH_PROP) return;
    // Climb to the function this parameter belongs to and take its name.
    let cur: ts.Node = node;
    while (cur.parent && !ts.isParameter(cur.parent)) cur = cur.parent;
    const param = cur.parent;
    if (!param || !ts.isParameter(param)) return;
    const fn = param.parent;
    if (ts.isFunctionDeclaration(fn) && fn.name) names.push(fn.name.text);
    else if (
      (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      fn.parent &&
      ts.isVariableDeclaration(fn.parent) &&
      ts.isIdentifier(fn.parent.name)
    ) {
      names.push(fn.parent.name.text);
    }
  });
  return names;
}

/**
 * The `X.ancestorRendersViewOnlyBanner` form (#2324), or null. This is the ONLY
 * shape the wizard channel is recognised in: a property access off a plain
 * identifier. Whether that identifier really is a `WizardStepConfig.render`
 * callback's own `helpers` parameter is settled by `wizardStepRenderArrow` plus
 * the parameter-name check in the #2324 test — this helper only tells the two
 * vouch channels apart, so the #2168 render-site rule can hand its wizard sites
 * over instead of rejecting them as "non-literal".
 */
function wizardVouchExpression(
  expr: ts.Expression,
): ts.PropertyAccessExpression | null {
  if (!ts.isPropertyAccessExpression(expr)) return null;
  if (expr.name.text !== VOUCH_PROP) return null;
  if (!ts.isIdentifier(expr.expression)) return null;
  return expr;
}

/**
 * The `WizardStepConfig.render` callback `node` sits inside, or null.
 *
 * "A `render` property whose object literal also declares `id` and `isVerified`"
 * is what pins this to a real step config rather than to any object with a
 * `render` key. Both of those are REQUIRED members of `WizardStepConfig`, so a
 * step cannot avoid them, and an unrelated `{ render: … }` cannot fake its way
 * in without also claiming to be a wizard step.
 */
function wizardStepRenderArrow(
  node: ts.Node,
): ts.ArrowFunction | ts.FunctionExpression | null {
  let cur: ts.Node | undefined = node;
  while (cur) {
    const fn = cur;
    if (
      (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      fn.parent &&
      ts.isPropertyAssignment(fn.parent) &&
      fn.parent.initializer === fn &&
      fn.parent.name.getText(fn.getSourceFile()) === "render" &&
      ts.isObjectLiteralExpression(fn.parent.parent)
    ) {
      const keys = fn.parent.parent.properties.map((p) =>
        p.name ? p.name.getText(fn.getSourceFile()) : "",
      );
      if (keys.includes("id") && keys.includes("isVerified")) return fn;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * The nearest enclosing function that DECLARES `VOUCH_PROP` among its own
 * destructured parameters, and whether it defaults it to `false`.
 *
 * Per-ATTRIBUTE rather than per-file, which #2324 forced and which is stronger
 * anyway. One file can hold several vouched components — `display-wizard-steps`
 * exports six wizard step bodies and three of them take the vouch — so the
 * file-level "destructured exactly once" count this replaces would have read
 * three correct components as a violation. Tying each opt-out to the component
 * that declares it also catches the shape the old count could not see: an
 * opt-out written in a component that never declared the prop at all, taking it
 * from an outer scope.
 */
function vouchDeclarer(
  node: ts.Node,
): { defaultsFalse: boolean } | null {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur)
    ) {
      for (const param of cur.parameters) {
        if (!ts.isObjectBindingPattern(param.name)) continue;
        for (const element of param.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          if (element.name.text !== VOUCH_PROP) continue;
          return {
            defaultsFalse:
              element.initializer?.kind === ts.SyntaxKind.FalseKeyword,
          };
        }
      }
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * The function node behind the exported component `name` in `ast` — a
 * `function` declaration, or an arrow/function expression assigned to a `const`.
 * Used to bound a check to ONE component's body when a file holds several.
 */
function namedComponentFn(
  ast: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | null {
  const found: (
    | ts.FunctionDeclaration
    | ts.ArrowFunction
    | ts.FunctionExpression
  )[] = [];
  eachNode(ast, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found.push(node);
      return;
    }
    if (!ts.isVariableDeclaration(node) || !node.initializer) return;
    if (!ts.isIdentifier(node.name) || node.name.text !== name) return;
    const init = node.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
      found.push(init);
    }
  });
  return found[0] ?? null;
}

/**
 * The members of a type NAMED in `ast` — a local `interface` (including what it
 * `extends`) or a local `type` alias.
 *
 * Resolution is deliberately syntactic and one file deep. This suite is not a
 * type checker, and it does not need to be: every wizard step declares its own
 * props type in its own file (`StepProps` in `display-wizard-steps.tsx`, inline
 * type literals elsewhere). A props type moved to another module would resolve
 * to nothing here, which fails the check that uses this rather than passing it.
 */
function typeMembersByName(
  ast: ts.SourceFile,
  name: string,
  seen: Set<string>,
): ts.TypeElement[] {
  if (seen.has(name)) return []; // `interface A extends B`, `B extends A`
  seen.add(name);
  const members: ts.TypeElement[] = [];
  eachNode(ast, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      members.push(...node.members);
      for (const clause of node.heritageClauses ?? []) {
        for (const base of clause.types) {
          if (!ts.isIdentifier(base.expression)) continue;
          members.push(
            ...typeMembersByName(ast, base.expression.text, seen),
          );
        }
      }
      return;
    }
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
      members.push(...declaredTypeMembers(ast, node.type, seen));
    }
  });
  return members;
}

/**
 * The members of a type NODE as written, flattening the two composite forms the
 * wizard step props use: an intersection (`StepProps & { … }`,
 * `{ … } & AncestorViewOnlyBannerProps`) and a reference to a local declaration.
 */
function declaredTypeMembers(
  ast: ts.SourceFile,
  type: ts.TypeNode | undefined,
  seen: Set<string> = new Set(),
): ts.TypeElement[] {
  if (!type) return [];
  if (ts.isTypeLiteralNode(type)) return [...type.members];
  if (ts.isIntersectionTypeNode(type)) {
    return type.types.flatMap((t) => declaredTypeMembers(ast, t, seen));
  }
  if (ts.isParenthesizedTypeNode(type)) {
    return declaredTypeMembers(ast, type.type, seen);
  }
  if (ts.isTypeReferenceNode(type)) {
    return typeMembersByName(ast, type.typeName.getText(ast), seen);
  }
  return [];
}

/**
 * Identifiers `fn` receives as a parameter whose DECLARED type is
 * `WizardStepHelpers` — either the whole parameter (`(ctx, helpers:
 * WizardStepHelpers) => …`) or a destructured member of it (the house shape:
 * `({ context, helpers }: { context: Ctx; helpers: WizardStepHelpers })`).
 *
 * Requiring the TYPE, not merely "is a parameter", is what makes the scope
 * guarantee below mean what the docs claim. Only the shell may construct a
 * `WizardStepHelpers` (asserted in the #2324 test), and the shell passes ONE
 * `canEdit` to both its banner and that object — so `helpers.canEdit` inside a
 * step provably IS the value the banner states. A parameter of some other type
 * proves nothing of the sort.
 */
function helpersParameterNames(ast: ts.SourceFile, fn: ts.Node): Set<string> {
  const names = new Set<string>();
  if (!ts.isFunctionLike(fn)) return names;
  const isHelpersType = (type: ts.TypeNode | undefined) =>
    type !== undefined &&
    ts.isTypeReferenceNode(type) &&
    type.typeName.getText(ast) === WIZARD_HELPERS_TYPE;

  for (const param of fn.parameters) {
    if (ts.isIdentifier(param.name)) {
      if (isHelpersType(param.type)) names.add(param.name.text);
      continue;
    }
    if (!ts.isObjectBindingPattern(param.name)) continue;
    const members = declaredTypeMembers(ast, param.type);
    for (const element of param.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const property = (element.propertyName ?? element.name).getText(ast);
      const member = members.find(
        (m): m is ts.PropertySignature =>
          ts.isPropertySignature(m) && m.name.getText(ast) === property,
      );
      if (member && isHelpersType(member.type)) names.add(element.name.text);
    }
  }
  return names;
}

/**
 * Named imports in `ast`, as `localName -> resolved file`. Aliased and default
 * imports are deliberately excluded: see the "no unresolvable vouch" test,
 * which turns that blind spot into a failure rather than a silent pass.
 */
function namedImports(
  fromFile: string,
  ast: ts.SourceFile,
): Map<string, string> {
  const out = new Map<string, string>();
  eachNode(ast, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;
    const target = resolveImport(fromFile, node.moduleSpecifier.text);
    if (!target) return;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const spec of bindings.elements) {
      if (spec.propertyName) continue; // `X as Y`
      if (node.importClause?.isTypeOnly || spec.isTypeOnly) continue;
      out.set(spec.name.text, target);
    }
  });
  return out;
}

describe("view-only section banner coverage (#2160)", () => {
  // `source` is the file with its comments blanked out. Every assertion in this
  // suite is a text search, so it has to run against code only — see
  // `stripComments`. That is also why `view-only-action.tsx` needs no special
  // case here even though its JSDoc quotes `describeReason={false}` at length,
  // and why the counts below can be trusted: the prose is gone before anything
  // is matched.
  const files = adminSourceFiles().map((file) => ({
    file,
    rel: relative(SRC, file).split(sep).join("/"),
    source: stripComments(readFileSync(file, "utf8")),
  }));

  // The same files parsed (#2168). Text is enough for "does this file contain
  // X"; the vouching checks need to know WHICH element an attribute sits on and
  // whether one node renders under another, which only the AST answers.
  const astFiles = parseAdminFiles();

  /*
    Derived views, computed ONCE for the whole suite. Each is a pure function of
    `astFiles` with nothing per-test about it, and three of the tests below used
    to rebuild all three independently — a full AST walk per admin file, plus an
    `existsSync` per import specifier, every time. On a cold run that pushed a
    single test past vitest's 5s default timeout (7.1s measured), which is a
    flake with no defect behind it. Hoisting is both the fix and faster overall.
  */
  const vouchChildren = new Map<string, Set<string>>(); // file -> export names
  for (const f of astFiles) {
    const names = vouchChildExports(f.ast);
    if (names.length > 0) vouchChildren.set(f.file, new Set(names));
  }
  const importsByFile = new Map<string, Map<string, string>>(
    astFiles.map((f) => [f.file, namedImports(f.file, f.ast)]),
  );
  const bannersByFile = new Map<string, ts.Node[]>(
    astFiles.map((f) => [f.file, bannerRenderSites(f.ast)]),
  );

  it("finds the admin surfaces it is meant to police", () => {
    // Guards against the glob silently matching nothing after a tree move,
    // which would make every assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(50);
    expect(
      files.filter((f) => f.source.includes("<ViewOnlyActionButton")).length,
    ).toBeGreaterThan(50);
    // …and the AST view sees the same tree, so a parse failure cannot make the
    // #2168 checks below vacuous either.
    expect(astFiles.map((f) => f.rel).sort()).toEqual(
      files.map((f) => f.rel).sort(),
    );
    expect(
      astFiles.filter((f) => jsxTags(f.ast, "ViewOnlyActionButton").length > 0)
        .length,
    ).toBeGreaterThan(50);
  });

  it("matches the coverage figures the docs publish", () => {
    /*
      Three documents and one JSDoc block quote these numbers as fact:
      `docs/ARCHITECTURE.md`, `docs/STYLE_GUIDE.md`,
      `CHANGELOG.md`, and `ViewOnlyActionButton`'s own JSDoc in
      `src/components/admin/view-only-action.tsx`. `AGENTS.md` published them
      too until #2714 routed the settings pattern out of the always-read core;
      it is still scanned for a stale figure, but no longer has to carry one.

      They were counted by hand, from raw text, and came out one too high —
      twice, for the same reason both times: a `describeReason={false}` written
      inside a comment counted as a call site. Nothing structural stopped a
      third instance, so this pins them.

      Since #2168 the figures are counted off `astFiles`, not text: a
      `describeReason` written in prose is not a `JsxAttribute`, so it cannot
      reach these totals at all. That is what makes the count mean "call sites"
      rather than "mentions". The comment-stripped `files` view still backs the
      TEXT assertions further down — and #2166 had to replace its lexer with a
      parser to keep even that honest (see `stripComments`) — but the numbers
      here no longer depend on it.

      This test is MEANT to fail when the rollout changes. Adding or converting
      a gated control is a real change to a published figure, and the fix is to
      re-run the numbers and update all five places together — never to loosen
      the assertion.
    */
    const perFile = astFiles.map((f) => {
      const kinds = describeReasonAttrs(f.ast).map(classifyDescribeReason);
      return {
        rel: f.rel,
        sites: jsxTags(f.ast, "ViewOnlyActionButton").length,
        // #2168: BOTH opt-out forms count. A control that hands its explanation
        // to a banner has stopped explaining itself either way, so a metric
        // that only counted `{false}` would have read "53 exceptions" after
        // this change while 21 of them no longer keep the reason on the page.
        staticOptOuts: kinds.filter((k) => k === "static").length,
        vouchedOptOuts: kinds.filter((k) => k === "vouched").length,
      };
    });
    const sum = (list: { n: number }[]) => list.reduce((n, f) => n + f.n, 0);

    // Controls that KEEP the per-button reason, per file.
    const exceptions = perFile
      .map((f) => ({
        rel: f.rel,
        n: f.sites - f.staticOptOuts - f.vouchedOptOuts,
      }))
      .filter((f) => f.n > 0);

    expect({
      callSites: perFile.reduce((n, f) => n + f.sites, 0),
      optOuts: perFile.reduce(
        (n, f) => n + f.staticOptOuts + f.vouchedOptOuts,
        0,
      ),
      // Split out, because the two are covered by DIFFERENT rules: a static
      // opt-out needs a banner in its own file, a vouched one needs a verified
      // vouching parent. The docs publish the split for the same reason.
      staticOptOuts: perFile.reduce((n, f) => n + f.staticOptOuts, 0),
      vouchedOptOuts: perFile.reduce((n, f) => n + f.vouchedOptOuts, 0),
      exceptions: sum(exceptions),
      exceptionFiles: exceptions.length,
      bannerComponents: astFiles.filter(
        (f) => (bannersByFile.get(f.file) ?? []).length > 0,
      ).length,
    }).toEqual({
      /*
        The delta chain from upstream, so the figures reconcile rather than
        merely being asserted. Every step is a MEASURED re-run, not arithmetic:

          263  upstream.
          264  +1  member-photos (hoppers#171) adds the committee photo-display
               control — a leaf exception that keeps its own reason.
          268  +4  the Member Notices feature (#2238) adds banner-bearing admin
               surfaces (the notices list page and the notice editor) with
               static opt-out ViewOnlyActionButtons covered in the same file.
          269  +1  commit 427200eb ("Build Fix") re-measured after that merge
               and found one call site and one banner component MORE than the
               +4/+2 written above — so the Notices feature really contributed
               5 call sites and 3 banner components (263 -> 269, 75 -> 78), and
               the prose deltas for it undercount by one. Recorded here rather
               than silently corrected, because 427200eb is the commit that
               made these numbers true and the earlier prose is what a reader
               would otherwise try (and fail) to add up.
          270  +1  #2259 adds the per-booking "No emails" switch.
          271  +1  #2247 adds "Restore built-in boards" to the display Templates
               page — a static opt-out under that page's existing banner.
          275  +4  #2249's Lodge Display setup wizard steps (restore the
               built-in boards, turn the module on, save the lodge details,
               pair the screen). All four KEPT their own reason at that point:
               the banner that covers them is rendered by the shared
               `IntegrationWizard` shell, in another file, and the shell renders
               its step bodies through a `render(context, helpers)` callback
               supplied by the wizard CONFIG — so there was no render site at
               which a parent could pass `ancestorRendersViewOnlyBanner`, and
               neither coverage rule could see it. (The Xero/Stripe/Google/
               backup wizard steps sidestepped it by using a plain disabled
               `Button`, which says nothing at all; these said why.)
          285 +10  #2324 gives the shell a vouch channel and converts all five
               setup flows together, so the ten controls that were plain
               disabled `Button`s become real, counted, policed call sites:
               Xero credentials + webhook key (2), Stripe keys + signing
               secret (2), Google credentials + verify (2), backups
               credentials + destination + turn-it-on + run-verification (4).
               Nothing else in the tree changed, and no call site was removed —
               the whole +10 is those four provider wizards' step files
               becoming visible to this suite for the first time.
        And how the other figures moved with #2324, each re-measured:

          optOuts  237 -> 242 (+5)   the controls the vouch NOW covers, all of
               them gated on the wizard's OWN area, which is exactly what its
               banner states: Lodge Display's restore-boards, save-lodge-details
               and pair-the-screen (3, `lodge`), and backups' turn-it-on and
               run-verification (2, `support`). staticOptOuts is untouched at
               216 — #2324 adds no `describeReason={false}`.
          exceptions 38 -> 43 (+5)   +8 -3. The +8 are the credential-ish
               writes that KEEP their own reason because their gate is NARROWER
               than the banner's: Xero credentials + webhook key, Stripe keys +
               signing secret, Google credentials + verify, backups credentials
               + destination all additionally require Full Admin, so an admin
               with the wizard's area but not Full Admin meets no banner and a
               dead button. They now say "Full Admin" instead of saying nothing.
               The -3 are the display-wizard controls that moved into the vouched
               bucket. Display's fourth control — the module switch — stays an
               exception: it is `support`-gated under a `lodge` banner, the same
               scope mismatch that keeps `member-credit-card.tsx` un-vouched.
          exceptionFiles 18 -> 23 (+5)   the four provider wizards' five step
               files (`xero-wizard-steps`, `xero-completion-steps`,
               `stripe-wizard-steps`, `google-wizard-steps`,
               `backup-wizard-steps`). `display-wizard-steps` was already an
               exception file and stays one on the module switch alone, so it
               is neither added nor removed.
          bannerComponents 78, unchanged   #2324 adds no banner. The shell's
               existing one now covers more, which is the entire point.

        Not converted, deliberately, and each is a scope judgement no static
        rule can make:

          - `xero/_components/connection-status-panel.tsx` — the connect /
            reconnect / disconnect buttons ARE finance-gated, matching the Xero
            wizard's banner, but the panel is a GRANDCHILD (the Connect step
            renders it) and is also used standalone outside the wizard.
            Forwarding the vouch through two hops is forbidden by the #2168
            rule above, so its plain `Button`s stay as they are.
          - the disabled `Input`s and `select`s inside the wizard steps. This
            suite polices `ViewOnlyActionButton`; text inputs have never been in
            its scope, and the display wizard has always left its own that way.

        The ledger then resumes:

          288  +3  #2252 adds the in-booking Bed allocation panel
               (`booking-bed-allocation-panel.tsx`): Assign, Remove and the
               booking-level Confirm, all static opt-outs under the panel's own
               banner (+1 banner component, 78 -> 79). Its remove-confirmation
               dialog keeps its own reason — a dialog is a separate
               accessibility container the card's banner does not reach — and
               is a plain Button rather than a ViewOnlyActionButton, matching
               the shared range dialog (#2251), so it adds no call site and no
               exception.
          291  +3  #2286 wires the Hut Leaders page's bed controls to the PUT
               that already existed: "Release bed" and "Change bed" per
               assignment row, plus "Confirm anyway" on the over-capacity
               question. All three are STATIC opt-outs under that page's single
               unconditional `AdminViewOnlySectionBanner`, which the two
               existing row actions (reset PIN, delete) already opt out under
               (optOuts 245 -> 248, staticOptOuts 219 -> 222; nothing else
               moves).
          295  +4  #2262 adds the cash / off-Xero payment feature's two leaf
               surfaces, four controls across two files, all keeping their own
               per-button reason: `booking-manual-payment-controls.tsx` (Record
               and Reverse manual payment) is a leaf control dropped into the
               Admin tools card's layout, exactly like the "No emails" switch
               and the two hold controls beside it, and
               `manual-refund-task-queue.tsx` (Mark paid back and Dismiss, one
               pair per open task) is a card on /admin/payments with no banner
               of its own. Both are gated on FINANCE, so neither may vouch off a
               banner elsewhere on its page that states another area. No new
               banner component: dropping one into the Admin tools card would
               duplicate what its siblings already handle per button. With them
               exceptions 43 -> 47 (+4), exceptionFiles 23 -> 25 (+2), and the
               leaf bucket 30/18 -> 34/20; optOuts, the vouched split and
               bannerComponents are untouched.
          293  +2  #2307's Member guests settings card on Bookings setup
               (member-guest-settings-card.tsx): Edit + Save, both static
               opt-outs under the card's own banner, so staticOptOuts and
               optOuts move +2 with it and bannerComponents +1 (79 -> 80).
               Re-measured on the merged tree rather than added to either
               side's figure: #2286 and #2307 landed in the same window and
               both moved the count.
          297      Re-measured on the merged tree: #2262's +4 and #2307's +2 are
               independent, so 291 -> 295 -> 297. Neither side's number is
               taken as-is.
          299  +2  the Mountain Conditions "Source & selectors" panel adds
               Preview and Save configuration ViewOnlyActionButtons — two static
               opt-outs under the panel's existing AdminViewOnlySectionBanner
               (optOuts 250 -> 252, staticOptOuts 224 -> 226; vouched,
               exceptions and bannerComponents unchanged — no new banner).
          301  +2  #2359 makes the Subscriptions header's Xero sync actions
               finance-edit-aware. Both keep their own reason because the
               sibling billing panel's banner does not cover header actions
               (exceptions 47 -> 49, exceptionFiles 25 -> 26, leaf bucket
               34/20 -> 36/21; opt-outs and bannerComponents unchanged).
          303  +2  #2364's Adult Member Hosting card on Booking Policies
               (adult-member-hosting-section.tsx): Edit + Save, both static
               opt-outs under the card's own unconditional
               AdminViewOnlySectionBanner, so optOuts 252 -> 254, staticOptOuts
               226 -> 228 and bannerComponents 80 -> 81 move with it. The
               vouched split, exceptions and the leaf bucket are untouched:
               nothing keeps its own reason, and no control here is gated on
               anything narrower than the bookings area the banner states.
          304  +1  #2364 review: /admin/book gains "Record the reason and
               create" — the surface that answers the adult-member hosting 409,
               which shipped with no client able to satisfy it. A static
               opt-out beside the existing over-capacity confirm, under the
               page's banner it already sits behind, so optOuts 254 -> 255 and
               staticOptOuts 228 -> 229 and nothing else moves (no new banner
               component, no new exception).
          307  +3  TLR-8C's Policy Exceptions queue (#2526,
               policy-exception-requests-panel.tsx): the decision form's
               controls are static opt-outs under the panel's own new
               AdminViewOnlySectionBanner, so optOuts 255 -> 258,
               staticOptOuts 229 -> 232 and bannerComponents 81 -> 82 move
               together. The vouched split, exceptions and the leaf bucket
               are untouched.
          312  +5  #2573's Google Analytics integration card
               (analytics-integration-card.tsx), which moves the GA4 setup onto
               Admin -> Integrations as a peer of Xero and Stripe. Its settings
               DIALOG renders its own AdminViewOnlySectionBanner — the
               sanctioned shape for dialog contents, which an ancestor's banner
               cannot reach — so all five controls are static opt-outs in the
               same file: Edit, Save, "Restore the suggested wording", and the
               two halves of the confirm-gated "Ask visitors to choose again"
               action. optOuts 258 -> 263, staticOptOuts 232 -> 237 and
               bannerComponents 82 -> 83 move together; the vouched split,
               exceptions and the leaf bucket are untouched, because nothing
               here is gated on anything narrower than the finance area the
               banner states.
          310  -2  #2586 replaces the roster's three immediate row-write call
               sites (Add Person, Remove and the unassigned-chore picker) with
               one staged whole-roster Edit control. That child control is
               vouched by the roster page's unconditional lodge-access banner,
               so static opt-outs move 237 -> 234, render-site vouches move
               21 -> 22, and total opt-outs move 263 -> 261.
          311  +1  #2593 replaces the old Save Mode site with two Edit/Save
               sites in the per-lodge allocation-preferences card. It owns a
               banner for standalone reuse, while the bed-allocation page
               suppresses that child banner and covers both control sites with
               the page's existing bookings-area banner.
               static opt-outs move 234 -> 235 and banner components 83 -> 84.
          310  -1  #2602 replaces the booking-panel removal control with a
               plain preview button: view-only administrators may inspect the
               staged removal, while the dialog keeps apply edit-gated. The
               removed site was a same-file static opt-out, so static opt-outs
               move 235 -> 234 and total opt-outs move 262 -> 261. Banner,
               vouch and per-button-explanation counts are unchanged.
          311  +1  Unrecorded when it landed, reconstructed here from the
               commit rather than left as a hole in the chain: #2597 ADDED a
               control — the "Resume approval" button, which finishes a deletion
               approval that started and did not finish, in
               `app/(admin)/admin/deletion-requests/deletion-requests-client.tsx`.
               It is a `describeReason={false}` static opt-out in the same file
               as that page's own unconditional banner, so callSites
               310 -> 311, optOuts 261 -> 262 and staticOptOuts 234 -> 235,
               and nothing else moves. Commit 969b88943
               re-measured the figures to 311/262/235 and updated every place
               that publishes them, but added no ledger line: the entry above
               it reads 310, the figures read 311, and the gap was exactly
               this. Noticed while measuring the entry below, whose own numbers
               would otherwise have looked like +2.
          312  +1  #2627 adds "Release approval" to the deletion queue's
               self-service rows — the Full-Admin way out of an approval left
               mid-flight, beside the existing "Resume approval". A static
               opt-out under the page's own unconditional
               AdminViewOnlySectionBanner, which the sibling Approve/Reject/
               Resume controls already opt out under, so static opt-outs move
               235 -> 236 and total opt-outs 262 -> 263. Nothing else moves: no
               new banner component, and the Full-Admin gate it additionally
               carries is applied by NOT RENDERING the control at all rather
               than by disabling it with a narrower per-button reason, so it
               adds no exception. (Re-measured, as always: 311 -> 312. The
               running left-hand column reached 310 at the step above, so it
               trails the measured total by one; #2637 supplies the correct
               reconstruction of that gap and this note deliberately does not
               guess at it.)
          313  +1  #2352 MC-03D adds the per-page Delete control to the Page
               Content cards, beside the Hide/Publish toggle it sits with and
               under the banner that file already renders. Static opt-outs move
               236 -> 237 and total opt-outs 263 -> 264; the vouched split,
               the exceptions and the banner count are untouched, because the
               control is gated on the same content area the banner states.
          313      THE COLLISION THIS LEDGER EXISTS FOR, and it fired. This
               entry was first written as `312`, measured against main at
               54b282b61 when #2352 was the first of three open PRs off that
               base — and #2636 (the entry above) reached main first with its own
               `callSites: 312`. The two literals were byte-identical, so the
               merge produced no conflict in the FIGURES block at all: only the
               prose ledger conflicted, and the numbers it guards merged
               silently wrong. Re-measured on the merged tree at f9bd34bd1 with
               `vitest run view-only-banner-contract` and set to what the tree
               reports: 313 / 264 / 237. #2641 will measure 314 / 265 / 238 when
               it lands, and it must MEASURE that rather than read it here.
          314  +1  #2595 adds the bed-allocation **Move** control to the
               allocation board's row menu. It is an EXCEPTION, not an opt-out:
               it keeps its own per-button reason because the menu it sits in is
               popover content with no banner above it, which is the same
               treatment every other control in that menu already has. So
               callSites 313 -> 314 and exceptions 49 -> 50 across 26 -> 27
               files, while optOuts and staticOptOuts do not move at all — the
               one entry in this ledger where the opt-out figures stay still.

               And that is where the entry above guessed wrong, which is the
               ledger's own rule proving itself a third time. #2637 predicted
               "#2641 will measure 314 / 265 / 238" by assuming every new
               control is an opt-out under a banner. This one is not: it sits in
               popover content, so it lands in the EXCEPTIONS bucket and the two
               opt-out figures do not move. Measured on the merged tree with
               `npx vitest run view-only-banner-contract`, the tree reports
               314 / 264 / 237 — one more call site than 313, and the same
               opt-out figures #2637 left behind. READ NOTHING FROM THIS
               COLUMN; run the suite.

               (The earlier hazard fired here too, in the other direction:
               against its own base this branch measured `callSites: 312`, the
               same literal #2637 wrote, so git merged the FIGURES value
               silently and only this prose collided — exactly the shape the
               entry above describes.)

          314      Re-measured a second time after merging main at d8041b601
               (#2352 ISR, #2621 arrival-time, #2654 requested-room Save). None
               of those three adds a `<ViewOnlyActionButton>` render site, so
               the tree still reports 314 / 264 / 237, exceptions 50 across 27
               files, and this block is unchanged. Recorded anyway, because
               "the figures did not move" is only worth anything when somebody
               RAN the suite to find that out — the sibling audit-writer census
               merged silently two short in this very same merge, off a
               byte-identical literal, and the only reason that was caught is
               that its per-sink figures were measured rather than assumed.

          315  +1  #2649 adds **Return to waitlist** — the repair for a free
               waitlist confirm stranded in `PAYMENT_PENDING`
               (`admin-return-to-waitlist-controls.tsx`) — to the Admin tools
               card. Like the `No emails` switch and the capacity/exclusive hold
               controls it sits beside, it is a LEAF dropped into someone else's
               layout with nothing local proving a banner renders above it, so
               it keeps its own per-button reason: an EXCEPTION, not an opt-out.
               leafControls 36 -> 37 across 21 -> 22 files, exceptions 50 -> 51
               across 27 -> 28 files, and optOuts/staticOptOuts do not move.

               AND THE COLLISION THIS LEDGER EXISTS FOR FIRED A THIRD TIME, on
               three lines at once. #2595 (the `314 +1` entry above) and this
               branch each measured `313 -> 314` against a base without the
               other, and each wrote `callSites: 314`, `exceptions: 50`,
               `exceptionFiles: 27` — byte-identical on all three, so git had no
               textual disagreement to report and merged the VALUES silently
               while only this prose collided. The merged tree holds BOTH new
               controls, so the honest figures are 315 / 51 / 28 and neither
               side's literals were them. The two that did NOT collide are what
               makes the shape legible: `leafControls`/`leafFiles` moved on this
               side only (#2595's control is popover content, mine is a leaf), so
               they merged correctly to 37/22 — and 10 dialog + 37 leaf + 4
               member-credit-card reconciles to 51, not 50. Re-measured with
               `npx vitest run view-only-banner-contract`, which reports
               315 / 264 / 237. READ NOTHING FROM THIS COLUMN; run the suite.

          319  +4  #2749 adds the Other Lodges panel on /admin/lodges
               (`lodges/_components/other-lodges-panel.tsx`): Add, Save, Edit and
               Delete. The panel is a CHILD of the Lodges page, which renders one
               lodge-area banner above it and passes `ancestorRendersViewOnlyBanner`
               at the render site (#2168), so all four are RENDER-SITE VOUCHED
               opt-outs, not static ones and not exceptions: callSites 315 -> 319,
               optOuts 264 -> 268, vouchedOptOuts 27 -> 31, and the render-site
               half of the split 22 -> 26. staticOptOuts, exceptions and the leaf
               bucket do not move, and bannerComponents stays 84 — the panel owns
               no banner of its own (the page's covers it). Re-measured with
               `npx vitest run view-only-banner-contract`, which reports
               319 / 268 / 237. READ NOTHING FROM THIS COLUMN; run the suite.

      */
      // #2259 adds the per-booking "No emails"
      // switch (`booking-no-emails-controls.tsx`), a leaf control dropped into
      // the Admin tools card's layout — the same shape as the capacity- and
      // exclusive-hold controls beside it, so it keeps its own per-button
      // reason rather than opting out under a banner it cannot prove renders.
      callSites: FIGURES.callSites,
      optOuts: FIGURES.optOuts,
      staticOptOuts: FIGURES.staticOptOuts,
      vouchedOptOuts: FIGURES.vouchedOptOuts,
      exceptions: FIGURES.exceptions,
      exceptionFiles: FIGURES.exceptionFiles,
      bannerComponents: FIGURES.bannerComponents,
    });

    // The vouched total splits by RULE, and the docs publish that split. Keeping
    // it arithmetic here means only one of the two halves has to be measured
    // (the #2324 test measures the shell's).
    expect(
      FIGURES.renderSiteVouchedOptOuts + FIGURES.shellVouchedOptOuts,
      `The published vouched split must add up to ${FIGURES.vouchedOptOuts}.`,
    ).toBe(FIGURES.vouchedOptOuts);

    /*
      …and the three shapes those exceptions fall into, because the docs break
      the total down and a bucket can drift while the total holds. The member
      detail cards are listed by name rather than by directory: three OTHER
      files in that same folder (`member-detail-header`,
      `member-account-access-group`, `member-contact-group`) are leaf toolbars,
      not per-record cards, and belong in the leaf bucket.
    */
    const MEMBER_DETAIL_CARDS = [
      "member-committee-assignments-card",
      "member-credit-card",
      "member-deletion-card",
      "member-dependents-card",
      "member-lifecycle-card",
      "member-lodge-access-card",
      "member-parent-links-card",
      "member-partner-link-card",
      "member-seasonal-membership-card",
    ].map((name) => `app/(admin)/admin/members/[id]/_components/${name}.tsx`);

    // Controls inside a dialog, sheet, popover, or dropdown menu — a separate
    // accessibility container that a banner in the page body does not reach.
    const SEPARATE_A11Y_CONTAINER = [
      "app/(admin)/admin/bookings/page.tsx",
      "app/(admin)/admin/issue-reports/page.tsx",
      "app/(admin)/admin/member-applications/_components/approval-mapping-panel.tsx",
      "app/(admin)/admin/membership-types/page.tsx",
      "components/admin/bed-allocation-move-dialog.tsx",
    ];

    const bucket = (names: string[]) =>
      exceptions.filter((f) => names.includes(f.rel));
    const leaves = exceptions.filter(
      (f) =>
        !MEMBER_DETAIL_CARDS.includes(f.rel) &&
        !SEPARATE_A11Y_CONTAINER.includes(f.rel),
    );

    expect({
      memberDetailCards: {
        controls: sum(bucket(MEMBER_DETAIL_CARDS)),
        files: bucket(MEMBER_DETAIL_CARDS).length,
      },
      separateA11yContainer: {
        controls: sum(bucket(SEPARATE_A11Y_CONTAINER)),
        files: bucket(SEPARATE_A11Y_CONTAINER).length,
      },
      leaves: { controls: sum(leaves), files: leaves.length },
    }).toEqual({
      // #2168 shrank this bucket from 25 controls / 9 files to 4 / 1. Eight of
      // the nine cards now take `ancestorRendersViewOnlyBanner` from the page,
      // which renders the one banner. `member-credit-card.tsx` is the survivor
      // and is NOT an oversight: it is gated on FINANCE while the page banner
      // states MEMBERSHIP, so vouching for it would point a view-only admin at
      // the wrong permission — and an admin with membership edit but finance
      // view-only would get no banner at all.
      memberDetailCards: { controls: 4, files: 1 },
      separateA11yContainer: { controls: 10, files: 5 },
      // +1 control / +1 file vs 20/11: the #2259 "No emails" switch; then
      // +4 controls / +1 file: the four #2249 display-wizard step controls,
      // which the shell's render-callback indirection put out of reach of both
      // coverage rules; then #2324 moves three of those four into the vouched
      // bucket (-3) and brings the four provider wizards' Full-Admin writes into
      // this one (+8 controls / +5 files) — see the delta chain above. Every
      // wizard control left here is a SCOPE exception, not an indirection one:
      // its gate is narrower than the banner its shell renders. Finally
      // +4 controls / +2 files: the #2262 cash-payment controls and the
      // manual-refund-task queue, both leaf surfaces described above.
      leaves: { controls: FIGURES.leafControls, files: FIGURES.leafFiles },
    });
  });

  it("matches the figures the docs publish, word for word", () => {
    /*
      The census above measures the tree. This one reads the PROSE.

      Both halves are needed, and the gap between them is where the drift has
      actually happened: the numbers moved, the census was updated, and one of the
      one of the three documents or the JSDoc was not. That leaves a reader
      trusting a figure no test disagrees with. Here every document that quotes
      a figure has to still quote the measured one.

      Matching is on whitespace-collapsed, markup-stripped text, so re-wrapping a
      paragraph or bolding a number is free; changing a number is not. The
      `ViewOnlyActionButton` JSDoc is checked too — it publishes the same split in
      the same words, and it is the one a developer reads first.

      When this fails, the fix is to re-measure and update every listed place
      together. Never to delete a phrase from this list to make it pass.
    */
    const f = FIGURES;
    const published: Record<string, string[]> = {
      "docs/ARCHITECTURE.md": [
        `${f.bannerComponents} components render a banner, and ${f.optOuts} of the ${f.callSites} ViewOnlyActionButton call sites opt out`,
        `${f.staticOptOuts} pass the literal describeReason={false}`,
        `and ${f.vouchedOptOuts} pass describeReason={!${VOUCH_PROP}}`,
        `${f.renderSiteVouchedOptOuts} by a parent's own JSX render site (#2168), ${f.shellVouchedOptOuts} by the guided-setup shell (#2324)`,
        `${f.exceptions} controls across ${f.exceptionFiles} files deliberately keep the per-button default`,
        `(${f.leafControls} controls across ${f.leafFiles} files.)`,
      ],
      "docs/STYLE_GUIDE.md": [
        // The style guide publishes the exception TOTAL only, on purpose.
        `${f.exceptions} controls still carry their own per-button reason`,
      ],
      "src/components/admin/view-only-action.tsx": [
        `pass describeReason={false} here (${f.staticOptOuts} of ${f.callSites} call sites)`,
        `a further ${f.vouchedOptOuts} pass describeReason={!${VOUCH_PROP}}`,
        `${f.renderSiteVouchedOptOuts} vouched at a JSX render site (#2168) and ${f.shellVouchedOptOuts}`,
        `${f.optOuts} opt-outs in total`,
        `counts ${f.leafControls} controls here`,
      ],
    };
    /*
      #2714 routed the canonical admin-settings pattern out of `AGENTS.md`'s
      always-read core and into `docs/ARCHITECTURE.md`, which had already carried
      the same rules in fuller form. `AGENTS.md` now leaves a pointer and a
      routing row instead, so it publishes none of these figures and is no longer
      REQUIRED to. It is still scanned, for the reason the shape check below
      exists: a figure re-introduced there has to be the measured one, not a
      resurrected copy of a superseded census.
    */
    const scannedButNotRequired: Record<string, string[]> = {
      "AGENTS.md": [
        `${f.optOuts} of ${f.callSites} ViewOnlyActionButton call sites now opt out`,
        `${f.staticOptOuts} covered by a banner in the SAME file`,
        `${f.vouchedOptOuts} by a verified vouching parent (${f.renderSiteVouchedOptOuts} at a JSX render site, ${f.shellVouchedOptOuts} through the guided-setup shell)`,
        `and ${f.exceptions} keep the per-button reason`,
      ],
    };

    const changelogPhrases = [
      `${f.callSites} gated admin controls, ${f.optOuts} of them covered by a banner (${f.staticOptOuts} in their own file, ${f.vouchedOptOuts} by a verified vouching parent — ${f.shellVouchedOptOuts} of those through the wizard frame)`,
      `and ${f.exceptions} across ${f.exceptionFiles} files deliberately keeping their own reason`,
    ];

    // Collapse the formatting a prose edit is free to change: line wrapping,
    // markdown emphasis, inline code fences, and JSDoc's leading ` * `.
    const flatten = (text: string) =>
      text
        .replace(/^\s*\*\s?/gm, " ")
        .replace(/[*`]/g, "")
        .replace(/\s+/g, " ");

    /*
      #2452 moved changelog entries OUT of CHANGELOG.md: a PR now writes its
      entry as a `changelog.d/<pr>-<slug>.md` fragment, and the release compile
      folds the fragments into the compiled CHANGELOG ledger later. Feature PRs
      do not edit that ledger or its Unreleased list, so current census
      enforcement applies to the source documents and new fragments instead.

      Every new fragment is therefore scanned separately, and a stale figure
      fails on its OWN pull request. A fragment is not REQUIRED to quote these
      sentences (almost none do); it is only forbidden from quoting a
      superseded version of one.
    */
    const fragmentsDir = join(process.cwd(), "changelog.d");
    const scanned: { rel: string; phrases: string[]; requirePresence: boolean }[] = [
      ...Object.entries(published).map(([rel, phrases]) => ({
        rel,
        phrases,
        requirePresence: true,
      })),
      ...Object.entries(scannedButNotRequired).map(([rel, phrases]) => ({
        rel,
        phrases,
        requirePresence: false,
      })),
      ...(existsSync(fragmentsDir)
        ? readdirSync(fragmentsDir)
            .filter((name) => name.endsWith(".md") && name !== "README.md")
            .map((name) => ({
              rel: `changelog.d/${name}`,
              phrases: changelogPhrases,
              requirePresence: false,
            }))
        : []),
    ];

    const offenders: string[] = [];
    for (const { rel, phrases, requirePresence } of scanned) {
      const file = join(process.cwd(), ...rel.split("/"));
      // A moved document must fail here, not throw ENOENT and not pass silently.
      if (!existsSync(file)) {
        offenders.push(`${rel} not found — it publishes these figures`);
        continue;
      }
      const flat = flatten(readFileSync(file, "utf8"));
      for (const phrase of phrases) {
        if (!flat.includes(phrase) && requirePresence) {
          offenders.push(`${rel}: "${phrase}"`);
          continue;
        }
        // A CORRECT SENTENCE ELSEWHERE IN THE SAME CURRENT DOCUMENT MUST NOT
        // EXCUSE A STALE ONE: `includes` only answers "does the measured figure
        // appear at least once". Release-compiler-owned CHANGELOG entries are
        // not in this set; current changelog fragments are.
        //
        // So every occurrence of each sentence's SHAPE — the same words with any
        // digits in the numeric slots — has to carry the measured figures.
        const shape = new RegExp(
          phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\d+/g, "\\d+"),
          "g",
        );
        for (const match of flat.matchAll(shape)) {
          if (match[0] !== phrase) {
            offenders.push(`${rel}: stale "${match[0]}" — should read "${phrase}"`);
          }
        }
      }
    }

    expect(
      offenders,
      `These documents no longer state the figures the census above measures. ` +
        `A rollout change moves the numbers; re-measure and update ` +
        `docs/ARCHITECTURE.md, docs/STYLE_GUIDE.md, any changelog.d/ fragment ` +
        `quoting them, and the ` +
        `ViewOnlyActionButton JSDoc together.`,
    ).toEqual([]);
  });

  it("never strips a control's reason without a banner covering it", () => {
    /*
      The STATIC opt-out, unchanged: `describeReason={false}` is only allowed
      where the banner is in the same file. #2168 adds a second opt-out form
      (`describeReason={!ancestorRendersViewOnlyBanner}`) rather than loosening
      this one, and that form is policed by the four tests below. The literal
      text check here would silently ignore the new form, so the very next test
      makes any THIRD form a failure — this rule cannot be escaped by inventing
      a spelling neither check knows about.
    */
    const offenders = files
      .filter((f) => f.source.includes("describeReason={false}"))
      .filter((f) => !f.source.includes("<AdminViewOnlySectionBanner"))
      .map((f) => f.rel);

    expect(
      offenders,
      `These files opt a ViewOnlyActionButton out of its own view-only reason ` +
        `(describeReason={false}) but render no <AdminViewOnlySectionBanner>. ` +
        `That deletes the explanation entirely. Either add the section banner ` +
        `or drop the describeReason opt-out.`,
    ).toEqual([]);
  });

  it("recognises only the two sanctioned describeReason forms (#2168)", () => {
    /*
      The closed world. `describeReason` may be omitted, `true`, the literal
      `false`, or exactly `!ancestorRendersViewOnlyBanner`. Anything else — a
      state variable, a prop with another name, a `&&` chain — is an opt-out
      that NEITHER the same-file banner rule NOR the vouching rules can see, so
      it would strip a control's explanation with nothing checking anything.
      Failing on the unknown form is what keeps the two rules exhaustive rather
      than merely typical.
    */
    const offenders: string[] = [];
    for (const f of astFiles) {
      for (const a of describeReasonAttrs(f.ast)) {
        if (classifyDescribeReason(a) !== "unrecognised") continue;
        const { line } = f.ast.getLineAndCharacterOfPosition(a.getStart(f.ast));
        offenders.push(`${f.rel}:${line + 1} ${a.getText(f.ast)}`);
      }
    }

    expect(
      offenders,
      `describeReason accepts exactly two opt-out spellings: the literal ` +
        `{false} (needs an AdminViewOnlySectionBanner in the SAME file), or ` +
        `{!${VOUCH_PROP}} (needs a parent that renders the banner and passes ` +
        `the prop at the render site). Any other expression is an opt-out no ` +
        `rule in this suite can verify.`,
    ).toEqual([]);
  });

  it("lets a vouched child use the prop for nothing but its own coverage (#2168)", () => {
    /*
      Three ways a child could make its own opt-out unverifiable, all closed
      here:

        1. Defaulting the prop to `true` (or not defaulting it), which would
           make the opt-out the child's baseline again — the exact orphan the
           whole rule prevents.
        2. FORWARDING the prop to a grandchild. Coverage would then be
           transitive, and the parent check below only verifies one hop, so the
           grandchild's controls would be uncovered with nothing noticing.
        3. Using it to gate anything other than the explanation.

      The only two permitted uses are `describeReason={!prop}` on a gated
      control and `{!prop ? <AdminViewOnlyNotice …> : null}` — the second
      because three of these cards carry a Notice that states the SAME scope as
      the page banner (and, in the lodge-access card, also covers disabled
      checkboxes that are not ViewOnlyActionButtons). Tying the Notice to the
      same signal is what stops the page showing the same sentence twice while
      keeping the card self-sufficient anywhere else.
    */
    const offenders: string[] = [];
    for (const f of astFiles) {
      const vouched = describeReasonAttrs(f.ast).filter(
        (a) => classifyDescribeReason(a) === "vouched",
      );
      const uses: ts.Identifier[] = [];
      eachNode(f.ast, (node) => {
        if (ts.isIdentifier(node) && node.text === VOUCH_PROP) uses.push(node);
      });
      if (vouched.length === 0 && uses.length === 0) continue;

      const at = (node: ts.Node) =>
        `${f.rel}:${f.ast.getLineAndCharacterOfPosition(node.getStart(f.ast)).line + 1}`;

      for (const use of uses) {
        const parent = use.parent;
        // (a) the destructured parameter, which must default to false.
        if (ts.isBindingElement(parent) && parent.name === use) {
          if (parent.initializer?.kind !== ts.SyntaxKind.FalseKeyword) {
            offenders.push(`${at(use)} declared without \`= false\``);
          }
          continue;
        }
        // (b) the prop-type declaration in view-only-action.tsx, and the shell's
        //     own `WizardStepHelpers` member (#2324) — both are declarations of
        //     the channel, not uses of it.
        if (ts.isPropertySignature(parent) && parent.name === use) continue;
        // (c') the PROPERTY NAME in `helpers.ancestorRendersViewOnlyBanner`,
        //      which is the shell channel being read at a step's render site.
        if (ts.isPropertyAccessExpression(parent) && parent.name === use)
          continue;
        // (c'') the shell SETTING the channel (`ancestorRendersViewOnlyBanner:
        //       true` in the `WizardStepHelpers` object it builds). Both of these
        //       are verified by the #2324 test, which checks the shell really
        //       renders the banner it is claiming to.
        if (ts.isPropertyAssignment(parent) && parent.name === use) continue;
        // (c) the ATTRIBUTE NAME at a parent's render site — that is the
        //     vouching side, verified by the two tests below, not here.
        if (ts.isJsxAttribute(parent) && parent.name === use) continue;
        // (d) `!prop`, in one of the two permitted positions.
        if (
          ts.isPrefixUnaryExpression(parent) &&
          parent.operator === ts.SyntaxKind.ExclamationToken
        ) {
          let cur: ts.Node = parent;
          while (
            cur.parent &&
            !ts.isJsxAttribute(cur.parent) &&
            !ts.isJsxExpression(cur.parent)
          ) {
            cur = cur.parent;
          }
          let holder = cur.parent;
          // `describeReason={!prop}` nests the expression inside a
          // JsxExpression inside the JsxAttribute; unwrap that one step so the
          // attribute name is what gets checked.
          if (
            holder &&
            ts.isJsxExpression(holder) &&
            holder.parent &&
            ts.isJsxAttribute(holder.parent)
          ) {
            holder = holder.parent;
          }
          if (holder && ts.isJsxAttribute(holder)) {
            if (holder.name.getText(f.ast) === "describeReason") continue;
            offenders.push(
              `${at(use)} gates the \`${holder.name.getText(f.ast)}\` prop`,
            );
            continue;
          }
          if (holder && ts.isJsxExpression(holder)) {
            if (holder.getText(f.ast).includes(`<${NOTICE}`)) continue;
            offenders.push(`${at(use)} gates JSX that renders no <${NOTICE}>`);
            continue;
          }
        }
        offenders.push(
          `${at(use)} used outside describeReason / the Notice guard`,
        );
      }

      // …and each opt-out must be declared by the COMPONENT it sits in, with the
      // `= false` default. Checked per attribute rather than per file (#2324):
      // `display-wizard-steps.tsx` holds six step bodies and three of them take
      // the vouch, so a file-level count of one would fail correct code — and
      // would miss an opt-out reading the prop from an outer scope.
      for (const a of vouched) {
        const declarer = vouchDeclarer(a);
        if (!declarer) {
          offenders.push(
            `${at(a)} opts out via the prop but no enclosing component ` +
              `destructures it as its own`,
          );
        } else if (!declarer.defaultsFalse) {
          offenders.push(
            `${at(a)} opts out via the prop but the component declaring it ` +
              `does not default it to false`,
          );
        }
      }
    }

    expect(
      offenders,
      `A vouched child may only DEFAULT \`${VOUCH_PROP}\` to false and read it ` +
        `as \`describeReason={!${VOUCH_PROP}}\` or as the guard on its own ` +
        `AdminViewOnlyNotice. Forwarding it, defaulting it to true, or using ` +
        `it for anything else makes the coverage unverifiable.`,
    ).toEqual([]);
  });

  it("only lets a parent vouch when it really renders the banner above the child (#2168)", () => {
    /*
      The heart of it. For every render site that passes the vouch prop:

        - the value must be the literal `true` (bare, or `{true}`). An
          expression could be false at runtime, and then the child would show
          its per-button reason under a banner-bearing parent — harmless — or,
          if the expression is a lie, hide it with no banner. Only a literal is
          provable statically.
        - a JSX SPREAD at the render site is rejected outright, because
          `{...props}` could carry the vouch prop invisibly and every check here
          would see a compliant-looking tag.
        - the parent must render the banner (the element, or the hoisted
          `const` idiom) in the SAME render root as the child — the same
          `return`, or the same arrow-function body — so the two genuinely
          appear together rather than in two branches that never coincide.
        - that banner render must be UNCONDITIONAL from the render root: not
          under `? :`, not under `&&`, not inside a callback. A banner that only
          appears in some states does not cover a child that appears in all of
          them.

      Note what this does NOT claim. It proves the banner ELEMENT renders. It
      does not prove the banner ever DISPLAYS anything, and the gap between
      those two is where the remaining limits live:

        - WHICH PERMISSION the banner names is unchecked. A parent vouching
          with a banner for a different permission area is a real defect this
          cannot see, which is why the page-level comment and the docs carry
          that reasoning explicitly (`member-credit-card.tsx` is the live case:
          gated on FINANCE under a MEMBERSHIP banner, so it is deliberately not
          vouched for).
        - SOURCE ORDER is unchecked: that the banner precedes the child in the
          returned tree is a review concern, not a mechanical one.
        - `canEdit` is only checked for the literal `true` (just below). The
          normal form is an expression, and whether that expression can ever be
          false is a runtime question. A banner whose `canEdit` is never false
          renders an empty live region and leaves every control it vouches for
          with no explanation at all — the exact hazard this mechanism exists
          to prevent, invisible to a static check.
        - CHILDREN are unchecked. A vouching banner with no `children` still
          passes everything here; at runtime its page-specific sentence just
          silently degrades to the generic shared heading, so the opt-outs are
          covered by a vaguer explanation than the author intended.

      Two scope limits apply to every check in this file, not just this one:

        - only paths containing `"admin"` are scanned (see `adminSourceFiles`).
          A vouching parent or a vouched child outside an admin path would be
          invisible to all of it. Zero such files exist today — the banner and
          `ViewOnlyActionButton` are admin-only components — but a tree move
          could change that silently.
        - the vouched-child rule below reads `!ancestorRendersViewOnlyBanner`
          on any component's `describeReason`, not only on
          `ViewOnlyActionButton`. That is not exploitable in practice: no other
          component declares the prop, so a planted use fails to compile with
          TS2322 before this suite ever runs. It is a precision note, not a
          hole.
    */
    expect(vouchChildren.size, "no vouched children found").toBeGreaterThan(0);

    const offenders: string[] = [];
    const vouchedSomewhere = new Set<string>();

    for (const parent of astFiles) {
      const imports = importsByFile.get(parent.file) ?? new Map<string, string>();
      const banners = bannersByFile.get(parent.file) ?? [];

      for (const tag of jsxTags(parent.ast)) {
        const name = tagName(tag);
        const target = imports.get(name);
        if (!target || !vouchChildren.get(target)?.has(name)) continue;

        const at = `${parent.rel}:${parent.ast.getLineAndCharacterOfPosition(tag.getStart(parent.ast)).line + 1}`;

        if (hasSpread(tag)) {
          offenders.push(`${at} renders <${name}> with a JSX spread`);
          continue;
        }
        const vouch = attr(tag, VOUCH_PROP);
        if (!vouch) continue; // not vouched: the child explains itself. Safe.

        const expr = attrExpression(vouch);
        // #2324: a vouch travelling down the wizard shell's `helpers` channel is
        // proved by the NEXT test instead — the shell renders the banner, and no
        // JSX render site in this file could. It is still counted as vouched
        // here, so the "mechanism must not be inert" check below stays honest.
        if (expr !== null && wizardVouchExpression(expr)) {
          vouchedSomewhere.add(`${target}#${name}`);
          continue;
        }
        if (expr !== null && expr.kind !== ts.SyntaxKind.TrueKeyword) {
          offenders.push(
            `${at} vouches for <${name}> with a non-literal value ` +
              `(${expr.getText(parent.ast)})`,
          );
          continue;
        }

        const root = renderRoot(tag);
        if (!root) {
          offenders.push(`${at} vouches for <${name}> outside any render root`);
          continue;
        }
        const covering = banners.filter(
          (b) => renderRoot(b) === root && unconditionalFrom(b, root),
        );
        if (covering.length === 0) {
          offenders.push(
            `${at} vouches for <${name}> but renders no unconditional ` +
              `<${BANNER}> in the same return`,
          );
          continue;
        }

        // The one display-side property that IS cheap to prove statically.
        // `AdminViewOnlySectionBanner` emits its sentence only when
        // `canEdit === false`, so a covering banner whose `canEdit` is the
        // literal `true` (or a bare `canEdit`, which JSX reads as true) can
        // never say anything — and every control it vouches for has silently
        // lost its own explanation. Only a literal is rejected: an expression
        // is the normal, correct form and is not statically decidable.
        const alwaysEditable = covering.some((site) => {
          const bannerTag = bannerTagOf(parent.ast, site);
          if (!bannerTag) return false;
          const canEdit = attr(bannerTag, "canEdit");
          if (!canEdit) return false;
          const value = attrExpression(canEdit);
          return value === null || value.kind === ts.SyntaxKind.TrueKeyword;
        });
        if (alwaysEditable) {
          offenders.push(
            `${at} vouches for <${name}> under a <${BANNER}> hardcoded to ` +
              `canEdit={true}, which never renders its sentence`,
          );
          continue;
        }

        vouchedSomewhere.add(`${target}#${name}`);
      }
    }

    expect(
      offenders,
      `A parent may only pass ${VOUCH_PROP} where it demonstrably renders the ` +
        `banner above that child: literal true, no JSX spread, and an ` +
        `unconditional <${BANNER}> in the same returned tree.`,
    ).toEqual([]);

    // …and the mechanism must not be inert. A child that declares the prop but
    // is never vouched for anywhere is dead plumbing that reads, to the next
    // person, as though its controls are already covered.
    const unvouched: string[] = [];
    for (const [file, names] of vouchChildren) {
      for (const name of names) {
        if (!vouchedSomewhere.has(`${file}#${name}`)) {
          unvouched.push(`${relative(SRC, file).split(sep).join("/")}#${name}`);
        }
      }
    }
    expect(
      unvouched,
      `These components declare ${VOUCH_PROP} but no parent ever passes it, so ` +
        `the opt-out never happens and the prop only misleads.`,
    ).toEqual([]);
  });

  it("only lets the wizard shell vouch for the step bodies it renders (#2324)", () => {
    /*
      The third coverage rule, and both halves of it are proved here rather than
      trusted (see the #2324 block at the top of this file for why the shell
      cannot use the #2168 render-site rule at all).

      THE SHELL'S HALF — three things, in order of what would break first:

        1. `WizardStepHelpers.ancestorRendersViewOnlyBanner` is REQUIRED and
           typed as the literal `true`. Making it optional, or widening it to
           `boolean`, would let a provider hand a step a false vouch, or forget
           it and have the step silently keep its reason while the docs claim
           otherwise. The type is what makes the forwarding expression at each
           render site compiler-proved rather than merely plausible.
        2. the shell sets it to the literal `true` in the helpers object it
           builds. If it stopped, every step's opt-out would still COMPILE (the
           prop defaults to false) and would silently revert to a per-button
           reason — a quiet regression, not a failure, which is exactly what a
           contract test is for.
        3. the shell renders an unconditional `AdminViewOnlySectionBanner` in
           EVERY branch it can return — the loading early-return included. This
           is the substance of the vouch: without it the shell is promising
           coverage it does not provide. The generic live-region test below also
           walks the shell, but it asks a different question ("is the banner
           mounted in every branch below the first one that mounts it") and
           accepts a conditional const. This one insists on the strict form for
           every branch, because it is the proof five setup flows rest on.

      THE STEPS' HALF — for every render site that forwards the channel:

        - it must sit inside a real `WizardStepConfig.render` callback (an object
          literal that also declares `id` and `isVerified`), so the spelling
          cannot spread to an ordinary page. This is decision A1: the vouch is
          honoured for step bodies and nowhere else.
        - the value must be read from THAT callback's own second parameter, not
          from a captured variable, a helper function, or an outer scope — the
          shell is the only thing that constructs a `WizardStepHelpers`, so
          reading it from the parameter is what ties the vouch to the shell.
        - the file must actually render `<IntegrationWizard>`. A config file that
          forwards helpers into a step body but hands the steps to something
          else is not covered by this shell's banner.
        - a JSX spread at the render site is rejected, exactly as in #2168:
          `{...props}` could carry the prop invisibly.
        - the child must resolve through a named, non-aliased import to a file
          that declares the prop with a `= false` default (the global
          resolvability rule below then catches any import form this cannot see).
        - the shell's `canEdit` must not be hardcoded to the literal `true`, and
          a `viewOnlyBanner` sentence must be supplied. A banner that can never
          render its sentence, or renders only the generic heading, leaves the
          controls it vouches for with less explanation than they gave up.

      WHAT THIS STILL DOES NOT CLAIM, and it is the same gap #2168 documents:
      WHICH permission the banner names. The shell's banner states the area the
      provider passed as `canEdit`; a step control gated on a narrower one (Full
      Admin, or the display wizard's `support`-gated module switch) must keep its
      own reason, and nothing here can tell that it did. Those are review
      judgements, written out at each call site and in `docs/ARCHITECTURE.md`.
    */
    const offenders: string[] = [];

    // ---- the shell's half -------------------------------------------------
    const typesFile = join(SRC, ...WIZARD_TYPES_REL.split("/"));
    expect(
      existsSync(typesFile),
      `${WIZARD_TYPES_REL} not found — the wizard shell contract moved, so ` +
        `every check below would be vacuous.`,
    ).toBe(true);
    const typesAst = ts.createSourceFile(
      typesFile,
      readFileSync(typesFile, "utf8"),
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    );
    // Collected into an array rather than a `let`: an assignment inside the
    // visitor callback is invisible to TS's narrowing, so a nullable local would
    // read as `null` at every use below.
    const declarations: ts.PropertySignature[] = [];
    eachNode(typesAst, (node) => {
      if (!ts.isInterfaceDeclaration(node)) return;
      if (node.name.text !== WIZARD_HELPERS_TYPE) return;
      for (const member of node.members) {
        if (!ts.isPropertySignature(member)) continue;
        if (member.name.getText(typesAst) !== VOUCH_PROP) continue;
        declarations.push(member);
      }
    });
    expect(
      declarations.length,
      `${WIZARD_HELPERS_TYPE} must declare ${VOUCH_PROP} exactly once — it is ` +
        `the only channel the shell has to a step.`,
    ).toBe(1);
    const declaration = declarations[0];
    expect(
      declaration.questionToken,
      `${VOUCH_PROP} must be REQUIRED on ${WIZARD_HELPERS_TYPE}: an optional ` +
        `vouch can be forgotten, and a step's opt-out would silently revert.`,
    ).toBeUndefined();
    const declaredType = declaration.type;
    expect(
      declaredType !== undefined &&
        ts.isLiteralTypeNode(declaredType) &&
        declaredType.literal.kind === ts.SyntaxKind.TrueKeyword,
      `${VOUCH_PROP} must be typed as the LITERAL \`true\`, not \`boolean\` — ` +
        `that is what stops a provider handing a step a false vouch. Found: ` +
        `${declaredType ? declaredType.getText(typesAst) : "no type"}`,
    ).toBe(true);

    const shell = astFiles.find((f) => f.rel === WIZARD_SHELL_REL);
    expect(
      shell,
      `${WIZARD_SHELL_REL} not found among the scanned admin files.`,
    ).toBeDefined();
    if (!shell) return;

    // The shell SETS the flag, on the object it types as WizardStepHelpers.
    const shellHelperObjects: ts.ObjectLiteralExpression[] = [];
    eachNode(shell.ast, (node) => {
      if (!ts.isVariableDeclaration(node) || !node.initializer) return;
      const type = node.type;
      if (
        !type ||
        !ts.isTypeReferenceNode(type) ||
        type.typeName.getText(shell.ast) !== WIZARD_HELPERS_TYPE
      ) {
        return;
      }
      if (ts.isObjectLiteralExpression(node.initializer)) {
        shellHelperObjects.push(node.initializer);
      }
    });
    expect(
      shellHelperObjects.length,
      `${WIZARD_SHELL_REL} must build exactly one \`${WIZARD_HELPERS_TYPE}\` ` +
        `object literal — that object is the vouch channel.`,
    ).toBe(1);
    const setsVouch = shellHelperObjects[0].properties.some(
      (p) =>
        ts.isPropertyAssignment(p) &&
        p.name.getText(shell.ast) === VOUCH_PROP &&
        p.initializer.kind === ts.SyntaxKind.TrueKeyword,
    );
    expect(
      setsVouch,
      `${WIZARD_SHELL_REL} must set \`${VOUCH_PROP}: true\` on the helpers it ` +
        `hands each step. Without it every step's opt-out silently reverts to ` +
        `a per-button reason while the docs claim the vouch covers them.`,
    ).toBe(true);

    // …and the banner really is there, unconditionally, in every branch.
    const shellBanners = bannersByFile.get(shell.file) ?? [];
    const shellComponents = new Set(
      shellBanners
        .map((site) => enclosingFunction(site))
        .filter((fn): fn is ts.Node => fn !== null),
    );
    expect(
      shellComponents.size,
      `${WIZARD_SHELL_REL} must render <${BANNER}> from exactly one component.`,
    ).toBe(1);
    for (const fn of shellComponents) {
      const branches = renderReturns(fn);
      expect(
        branches.length,
        `${WIZARD_SHELL_REL} must keep its loading early-return as a distinct ` +
          `render branch, so "every branch" means something.`,
      ).toBeGreaterThan(1);
      for (const ret of branches) {
        const covered = shellBanners.some(
          (site) =>
            site.getStart() >= ret.getStart() &&
            site.getEnd() <= ret.getEnd() &&
            unconditionalFrom(site, ret),
        );
        if (!covered) {
          const line =
            shell.ast.getLineAndCharacterOfPosition(ret.getStart()).line + 1;
          offenders.push(
            `${shell.rel}:${line} is a shell render branch with no ` +
              `unconditional <${BANNER}> — the vouch it makes to every step ` +
              `is not true there`,
          );
        }
      }
    }
    const shellBannerCanEditHardcoded = shellBanners.some((site) => {
      const bannerTag = bannerTagOf(shell.ast, site);
      if (!bannerTag) return false;
      const canEdit = attr(bannerTag, "canEdit");
      if (!canEdit) return true;
      const value = attrExpression(canEdit);
      return value === null || value.kind === ts.SyntaxKind.TrueKeyword;
    });
    expect(
      shellBannerCanEditHardcoded,
      `${WIZARD_SHELL_REL}'s <${BANNER}> must take \`canEdit\` from the ` +
        `provider. Hardcoded to true (or omitted) it never renders its ` +
        `sentence, and every vouched step control is left with nothing.`,
    ).toBe(false);

    /*
      ---- and ONLY the shell may CONSTRUCT the vouch ------------------------

      Everything above proves the shell's vouch is honest. It does not stop
      another file minting its own, and that is a real hole rather than a
      theoretical one, in two shapes:

        - DECOY HELPERS. A provider config writes
          `const helpers: WizardStepHelpers = { …, ancestorRendersViewOnlyBanner:
          true }` and calls a step body's render with it. Every check in the
          steps' half below passes — the value IS read from a `render`
          callback's own parameter — while nothing renders a banner at all.
        - DECOY STEP CONFIG. The same object literal shape used to satisfy the
          `id`/`isVerified` test for a `render` that the shell never receives.

      Both need the flag, or a `WizardStepHelpers`, to be built somewhere other
      than the shell. So that is what is forbidden. Outside
      `integration-wizard.tsx`, in the admin tree, neither may appear:

        - a PROPERTY ASSIGNMENT named `ancestorRendersViewOnlyBanner`. The
          sanctioned forward is a JSX ATTRIBUTE (a `JsxAttribute` node), and the
          declaration in `view-only-action.tsx` / `types.ts` is a
          `PropertySignature`, so neither is touched by this;
        - an object literal ANNOTATED as `WizardStepHelpers`, in each of the
          three spellings that annotate one: `const x: WizardStepHelpers = {…}`,
          `{…} as WizardStepHelpers`, `{…} satisfies WizardStepHelpers`.

      Test files are outside this scan by construction (`walk` skips `__tests__`
      and `*.test.tsx`) and that is deliberate, not a gap: a step-body unit test
      MUST build a helpers object to render the step at all. What it cannot do is
      make a PRODUCTION step opt out — the step's own `= false` default, checked
      above, is what covers that.
    */
    for (const f of astFiles) {
      if (f.rel === WIZARD_SHELL_REL) continue;
      const at = (node: ts.Node) =>
        `${f.rel}:${f.ast.getLineAndCharacterOfPosition(node.getStart(f.ast)).line + 1}`;

      eachNode(f.ast, (node) => {
        if (
          ts.isPropertyAssignment(node) &&
          node.name.getText(f.ast) === VOUCH_PROP
        ) {
          offenders.push(
            `${at(node)} sets \`${VOUCH_PROP}\` as an object property — only ` +
              `${WIZARD_SHELL_REL} may construct the vouch, because only it ` +
              `renders the banner the vouch promises`,
          );
        }
        if (!ts.isObjectLiteralExpression(node)) return;
        const parent: ts.Node | undefined = node.parent;
        let annotation: ts.TypeNode | undefined;
        if (
          parent &&
          ts.isVariableDeclaration(parent) &&
          parent.initializer === node
        ) {
          annotation = parent.type;
        } else if (
          parent &&
          (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) &&
          parent.expression === node
        ) {
          annotation = parent.type;
        }
        if (
          annotation &&
          ts.isTypeReferenceNode(annotation) &&
          annotation.typeName.getText(f.ast) === WIZARD_HELPERS_TYPE
        ) {
          offenders.push(
            `${at(node)} builds a \`${WIZARD_HELPERS_TYPE}\` object — a ` +
              `fabricated helpers object carries a vouch nothing has proved`,
          );
        }
      });
    }

    // ---- the steps' half --------------------------------------------------
    let wizardVouchSites = 0;
    const wizardVouched = new Set<string>(); // "file#Export"
    for (const f of astFiles) {
      const imports = importsByFile.get(f.file) ?? new Map<string, string>();
      const shellTags = jsxTags(f.ast, WIZARD_SHELL);

      for (const tag of jsxTags(f.ast)) {
        const vouch = attr(tag, VOUCH_PROP);
        if (!vouch) continue;
        const expr = attrExpression(vouch);
        if (expr === null) continue; // bare `prop` — the #2168 literal form
        const channel = wizardVouchExpression(expr);
        if (!channel) continue; // literal / other — #2168's rules own it

        const name = tagName(tag);
        const at = `${f.rel}:${f.ast.getLineAndCharacterOfPosition(tag.getStart(f.ast)).line + 1}`;

        if (hasSpread(tag)) {
          offenders.push(`${at} forwards the shell's vouch with a JSX spread`);
          continue;
        }
        const target = imports.get(name);
        if (!target || !vouchChildren.get(target)?.has(name)) {
          offenders.push(
            `${at} forwards the shell's vouch to <${name}>, which this test ` +
              `cannot resolve to a file declaring the prop`,
          );
          continue;
        }
        const arrow = wizardStepRenderArrow(tag);
        if (!arrow) {
          offenders.push(
            `${at} forwards the shell's vouch outside a ` +
              `WizardStepConfig.render callback`,
          );
          continue;
        }
        const helpersParam = arrow.parameters[1];
        const helpersName =
          helpersParam && ts.isIdentifier(helpersParam.name)
            ? helpersParam.name.text
            : null;
        if (
          helpersName === null ||
          channel.expression.getText(f.ast) !== helpersName
        ) {
          offenders.push(
            `${at} reads the vouch from \`${channel.expression.getText(f.ast)}\`` +
              `, not from its render callback's own helpers parameter`,
          );
          continue;
        }
        if (shellTags.length === 0) {
          offenders.push(
            `${at} forwards the shell's vouch but this file never renders ` +
              `<${WIZARD_SHELL}>`,
          );
          continue;
        }
        const alwaysEditable = shellTags.some((t) => {
          const canEdit = attr(t, "canEdit");
          if (!canEdit) return true;
          const value = attrExpression(canEdit);
          return value === null || value.kind === ts.SyntaxKind.TrueKeyword;
        });
        if (alwaysEditable) {
          offenders.push(
            `${at} forwards the shell's vouch under an <${WIZARD_SHELL}> whose ` +
              `canEdit is hardcoded true (or missing), so its banner never ` +
              `renders a sentence`,
          );
          continue;
        }
        if (shellTags.some((t) => !attr(t, "viewOnlyBanner"))) {
          offenders.push(
            `${at} forwards the shell's vouch under an <${WIZARD_SHELL}> with ` +
              `no viewOnlyBanner sentence, so the opt-outs are covered by the ` +
              `generic heading alone`,
          );
          continue;
        }
        wizardVouched.add(`${target}#${name}`);
        wizardVouchSites += 1;
      }
    }

    /*
      ---- the SCOPE check, which this channel can make mechanically ----------

      #2168 cannot check scope: a vouching parent's banner and its child's
      `canEdit` are two unrelated expressions in two files, and whether they name
      the same permission area is a judgement. The wizard channel is different,
      and it is the one real strengthening #2324 buys. The shell passes ONE
      `canEdit` to both the banner and `helpers`, so a step control that takes
      its `canEdit` from that same `helpers` object is covered by the banner BY
      CONSTRUCTION — the two cannot disagree, because they are the same value.

      So: inside a wizard-vouched component, a control that opts out via the
      vouch must read `canEdit` off an identifier the component received as a
      parameter DECLARED `WizardStepHelpers` (in practice `helpers.canEdit`), not
      from an independent source.

      The declared TYPE is what makes "the same value" a proof rather than a
      likelihood. "Is a parameter" alone would accept `canEdit` read off any prop
      a caller happened to pass — including a second, independently-derived
      access flag with a different scope, which is precisely the defect this
      check exists to catch. With the type required, and with only the shell
      allowed to CONSTRUCT a `WizardStepHelpers` (asserted above), the object
      behind that identifier can only have come from the shell, and the shell
      built its `canEdit` and its banner's `canEdit` from one value.

      It also keeps the live scope mismatch out by more than luck: the Lodge
      Display module switch calls `useAdminAreaEditAccess("support")` itself
      while the wizard's banner states `lodge`, so it cannot be vouched for — and
      cannot be vouched for by ACCIDENT either, because a local hook result is
      neither a parameter nor typed as the helpers.

      This does not make the wizard channel judgement-free. Deciding a control
      should NOT take the vouch is still a review call. What is now mechanical is
      the other direction: a control that DOES take it provably shares the
      banner's `canEdit`.
    */
    let shellVouchedControls = 0;
    for (const key of wizardVouched) {
      const [file, name] = key.split("#");
      const target = astFiles.find((f) => f.file === file);
      if (!target) continue;
      const fn = namedComponentFn(target.ast, name);
      if (!fn) {
        offenders.push(
          `${target.rel} exports no resolvable component \`${name}\` to scope ` +
            `the vouch's canEdit check to`,
        );
        continue;
      }
      const helpersParams = helpersParameterNames(target.ast, fn);
      for (const tag of jsxTags(target.ast, "ViewOnlyActionButton")) {
        if (tag.getStart() < fn.getStart() || tag.getEnd() > fn.getEnd()) {
          continue;
        }
        const describeReason = attr(tag, "describeReason");
        if (
          !describeReason ||
          classifyDescribeReason(describeReason) !== "vouched"
        ) {
          continue;
        }
        // Counted here rather than at the render site: the docs publish the
        // number of CONTROLS the shell channel covers, and one step body can
        // hold several. (Today each holds one, which is why the two coincide.)
        shellVouchedControls += 1;
        const at = `${target.rel}:${target.ast.getLineAndCharacterOfPosition(tag.getStart(target.ast)).line + 1}`;
        const canEdit = attr(tag, "canEdit");
        const value = canEdit ? attrExpression(canEdit) : null;
        const readsFromHelpers =
          value !== null &&
          ts.isPropertyAccessExpression(value) &&
          value.name.text === "canEdit" &&
          ts.isIdentifier(value.expression) &&
          helpersParams.has(value.expression.text);
        if (!readsFromHelpers) {
          offenders.push(
            `${at} opts out under the shell's banner but takes canEdit from ` +
              `\`${value ? value.getText(target.ast) : "nothing"}\` rather than ` +
              `off a <${name}> parameter declared \`${WIZARD_HELPERS_TYPE}\` — ` +
              `so nothing proves it is the same permission area the banner states`,
          );
        }
      }
    }

    expect(
      offenders,
      `The wizard shell's vouch (#2324) is honoured only inside a real ` +
        `WizardStepConfig.render, read from that callback's own helpers ` +
        `parameter, in a file that renders <${WIZARD_SHELL}> with a real ` +
        `canEdit and its own banner sentence.`,
    ).toEqual([]);

    // …and it must not be inert. A channel nothing travels down would read, to
    // the next person, as though the wizard steps were already covered.
    expect(
      wizardVouchSites,
      `No step forwards ${VOUCH_PROP} from the shell, so the channel is dead ` +
        `plumbing and every wizard step control is back to its own reason.`,
    ).toBeGreaterThan(0);

    // The docs publish the vouched total split by RULE (#2168 render site vs
    // this shell channel), so the shell's half is measured rather than asserted
    // in prose. The census test checks the two halves add up to the total.
    expect(
      shellVouchedControls,
      `The docs publish ${FIGURES.shellVouchedOptOuts} opt-outs covered through ` +
        `the wizard shell's channel. Re-measure and update them together.`,
    ).toBe(FIGURES.shellVouchedOptOuts);
  });

  it("never lets the vouch prop reach a component this test cannot resolve (#2168)", () => {
    /*
      The parent check above resolves a child through a NAMED, non-aliased
      import — the house style, and all this repo uses. A default import, an
      alias, a barrel re-export or `next/dynamic` would take a render site out
      of its view, and a check that silently stops looking is worse than no
      check.

      So the attribute NAME itself is policed globally: wherever
      `ancestorRendersViewOnlyBanner` appears as a JSX attribute, the tag it is
      on must resolve to a known vouched child. A refactor to any unresolvable
      import form fails here instead of quietly leaving the vouch unverified.
    */
    const offenders: string[] = [];
    for (const f of astFiles) {
      const imports = importsByFile.get(f.file) ?? new Map<string, string>();
      for (const tag of jsxTags(f.ast)) {
        if (!attr(tag, VOUCH_PROP)) continue;
        const name = tagName(tag);
        const target = imports.get(name);
        if (target && vouchChildren.get(target)?.has(name)) continue;
        offenders.push(
          `${f.rel}:${f.ast.getLineAndCharacterOfPosition(tag.getStart(f.ast)).line + 1} <${name}>`,
        );
      }
    }

    expect(
      offenders,
      `${VOUCH_PROP} was passed to a component this test cannot resolve to a ` +
        `file that declares it (aliased import, default import, barrel or ` +
        `dynamic import). Import it by its own name so the vouch stays ` +
        `verifiable.`,
    ).toEqual([]);
  });

  it("never nests one banner-bearing component inside another", () => {
    /*
      The coverage rule above is asserted per FILE by text presence, so it is
      blind BY CONSTRUCTION to the opposite defect: two banners covering the
      same controls. A page that renders its own banner and then renders a
      child component that renders one too shows a view-only admin the same
      sentence twice, in two `role="status"` regions, both announced.

      A child that is legitimately reused in a container no ancestor banner
      reaches (a dialog) keeps its own banner by default; the parent that DOES
      cover it passes `renderViewOnlyBanner={false}` at the render site, which
      is exactly where a reader needs to see it. EVERY render site of the child
      is checked, not just the first, so a second copy added below a compliant
      one can not ride on it.

      The scan is static, and its reach is exactly the house style it polices:
      a named import (`import { Child } from "…"`) rendered as `<Child …>`. It
      does NOT see a component reached by an aliased import
      (`import { Child as Editor }`), a default import, a barrel re-export, or
      `next/dynamic`. None of those are used for banner-bearing admin
      components today — every pair that currently exists is checked — but a
      future refactor to one of those forms would take the pair out of this
      test's view rather than fail it.
    */
    const bannerFiles = new Set(
      files
        .filter((f) => f.source.includes("<AdminViewOnlySectionBanner"))
        .map((f) => f.file),
    );

    const offenders: string[] = [];
    for (const parent of files) {
      if (!bannerFiles.has(parent.file)) continue;

      const importRe =
        /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
      for (const match of parent.source.matchAll(importRe)) {
        const target = resolveImport(parent.file, match[2]);
        if (!target || !bannerFiles.has(target) || target === parent.file)
          continue;

        for (const raw of match[1].split(",")) {
          const spec = raw.trim();
          // `type Foo` / `Foo as Bar` are not renderable component bindings.
          if (!spec || spec.startsWith("type ") || spec.includes(" as "))
            continue;
          if (!/^[A-Z]\w*$/.test(spec)) continue;

          const tags = openingTags(parent.source, spec);
          if (tags.length === 0) continue; // imported but never rendered here
          const uncovered = tags.filter(
            (tag) => !tag.includes("renderViewOnlyBanner={false}"),
          );
          if (uncovered.length === 0) continue;
          // The file has a banner somewhere; only THIS export matters.
          const childSource = stripComments(readFileSync(target, "utf8"));
          if (!componentRendersBanner(childSource, spec)) continue;

          offenders.push(
            `${parent.rel} renders <${spec}> from ${relative(SRC, target).split(sep).join("/")} ` +
              `(${uncovered.length} of ${tags.length} render site(s) without renderViewOnlyBanner={false})`,
          );
        }
      }
    }

    expect(
      offenders,
      `These components render an AdminViewOnlySectionBanner AND render a ` +
        `child component that renders one too, so a view-only admin meets the ` +
        `same sentence twice in two live regions. Decide which container owns ` +
        `the explanation: if the parent's banner covers the child's controls, ` +
        `pass renderViewOnlyBanner={false} at the child's render site; ` +
        `otherwise drop the parent's banner.`,
    ).toEqual([]);
  });

  it("keeps every banner's live region mounted across a component's branches", () => {
    /*
      The banner only announces if its `role="status"` wrapper is registered in
      the accessibility tree BEFORE its content appears. A section that renders
      the banner solely in its loaded branch mounts it already-populated, which
      some screen-reader/browser pairings drop silently (VoiceOver + Safari).
      The house idiom is to hoist the banner into a `const …Banner = (…)` above
      the early-returns and render that const in EVERY branch.

      This check runs over the AST, per component, rather than over file text.
      The text version it replaces was vacuous on the very page #2168 adds:
      deleting the banner from BOTH of `/admin/members/[id]`'s early-return
      branches left the suite green. Two independent reasons, and both are
      structural rather than a matter of a better pattern:

        - it counted render sites with `/\{\s*\w*[Bb]anner\s*\}/`, which also
          matched the named IMPORT `{ AdminViewOnlySectionBanner }`. The page
          imports the banner as a sole specifier, so its count read one higher
          than it rendered, and the "at least two render sites" floor was met
          by one real render plus the import line.
        - it located the early return with `source.search(…)`, which finds the
          FIRST match in the file. On that page the first match is a `useEffect`
          precondition — `if (loading || !member || …) return;` — hundreds of
          lines above the render early-return, so the positional half compared
          against the wrong statement entirely.

      Against the AST neither is expressible. An import is an import, not a JSX
      expression; a `return` with no value is not a render branch; and each
      branch is checked in its own right instead of a whole file being scored
      by a count. Two rules run over every component that mounts a banner:

        A. a LOADING-guarded render branch must mount the banner. This is the
           original defect — the fetch-settles-then-banner-appears shape — and
           the condition is read from the `if` that actually guards that branch.
           The spellings stay broad (`loading`, `isLoading`, `isPending`,
           `isFetching`, `status === "loading"`) because the defect has recurred
           under all of them.
        B. once a component mounts the banner in one branch, every LATER branch
           must mount it too. This is what makes deleting the banner from a
           non-loading early-return (an error branch, say) fail, which rule A
           alone cannot see.

      Rule B is anchored at the FIRST mounting branch rather than at the top of
      the component, and that asymmetry is deliberate. Several panels return
      early for terminal states that are not "still loading" and carry no banner
      on purpose — `lodge-details-panel`'s `accessDenied` and `multiLodge`
      returns say the section is unavailable in their own words, and a
      view-only banner above them would explain a control set that is not
      there. Those all sit ABOVE the first mounting branch. What is not
      defensible is mounting the banner and then dropping it lower down, which
      is precisely the shape a copy-paste edit produces.

      What this does NOT claim: that the banner ever displays anything. See the
      stated limits on the vouching test above — `AdminViewOnlySectionBanner`
      emits content only when `canEdit === false`, and nothing here reads
      `canEdit`.
    */
    const LOADING_GUARD =
      /\b(loading|isLoading|isPending|isFetching)\b|status\s*===\s*["']loading["']/i;

    const offenders: string[] = [];
    for (const f of astFiles) {
      const sites = bannerMountSites(f.ast);
      if (sites.length === 0) continue;

      const components = new Set(
        sites
          .map((site) => enclosingFunction(site))
          .filter((fn): fn is ts.Node => fn !== null),
      );

      for (const fn of components) {
        const branches = renderReturns(fn);
        const mounts = branches.map((ret) =>
          sites.some(
            (site) =>
              site.getStart() >= ret.getStart() &&
              site.getEnd() <= ret.getEnd(),
          ),
        );
        const firstMount = mounts.indexOf(true);

        branches.forEach((ret, i) => {
          if (mounts[i]) return;
          const at = `${f.rel}:${f.ast.getLineAndCharacterOfPosition(ret.getStart()).line + 1}`;
          const guard = guardCondition(ret, fn);

          if (guard && LOADING_GUARD.test(guard.getText(f.ast))) {
            offenders.push(
              `${at} returns early on \`${guard.getText(f.ast)}\` without ` +
                `mounting the banner`,
            );
            return;
          }
          if (firstMount !== -1 && i > firstMount) {
            offenders.push(
              `${at} drops the banner from a branch below one that mounts it`,
            );
          }
        });
      }
    }

    expect(
      offenders,
      `A component that mounts <${BANNER}> must mount it in its loading ` +
        `branch and in every branch below the first one that mounts it — ` +
        `hoist it into a const above the early-returns and render that const ` +
        `in each. Otherwise the live region is only registered once the ` +
        `section's fetch settles, and screen readers drop the announcement.`,
    ).toEqual([]);
  });
});

describe("gated controls keep `disabled` (#2160 Decision 1)", () => {
  it("does not switch ViewOnlyActionButton to aria-disabled", () => {
    /*
      Owner Decision 1 on #2160: KEEP `disabled`. The known, accepted cost is
      that gated controls stay OUT of the keyboard tab order — the banner puts
      the reason in the reading order, but it does not make the control
      focusable. If someone later swaps in `aria-disabled`, that is a real
      behaviour change (a clickable control that must be neutralised) and it
      needs a fresh owner decision, not a silent edit.
    */
    const source = readFileSync(
      join(SRC, "components", "admin", "view-only-action.tsx"),
      "utf8",
    );
    // Strip comments first: the JSDoc DISCUSSES `aria-disabled` at length —
    // explaining what was weighed and declined — so matching raw source would
    // fail on the documentation that exists precisely to record this decision.
    // Only the code is the contract.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    expect(code).toContain("disabled={isDisabled}");
    expect(code).not.toMatch(/aria-disabled/);
  });
});
