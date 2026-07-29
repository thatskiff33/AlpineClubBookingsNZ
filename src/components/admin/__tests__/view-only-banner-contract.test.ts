import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

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
      Four documents and one JSDoc block quote these numbers as fact:
      `docs/ARCHITECTURE.md`, `AGENTS.md`, `docs/STYLE_GUIDE.md`,
      `CHANGELOG.md`, and `ViewOnlyActionButton`'s own JSDoc in
      `src/components/admin/view-only-action.tsx`.

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
        (f) => bannerRenderSites(f.ast).length > 0,
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
               pair the screen). All four KEEP their own reason: the banner
               that covers them is rendered by the shared `IntegrationWizard`
               shell, in another file, and the shell renders its step bodies
               through a `render(context, helpers)` callback supplied by the
               wizard CONFIG — so there is no render site at which a parent
               could pass `ancestorRendersViewOnlyBanner`, and neither
               coverage rule can see it. The per-button reason is the honest
               state, not an oversight. (The Xero/Stripe/Google/backup wizard
               steps sidestep this by using a plain disabled `Button`, which
               says nothing at all; these say why.)
      */
      // #2259 adds the per-booking "No emails"
      // switch (`booking-no-emails-controls.tsx`), a leaf control dropped into
      // the Admin tools card's layout — the same shape as the capacity- and
      // exclusive-hold controls beside it, so it keeps its own per-button
      // reason rather than opting out under a banner it cannot prove renders.
      callSites: 275,
      optOuts: 237,
      staticOptOuts: 216,
      vouchedOptOuts: 21,
      exceptions: 38,
      exceptionFiles: 18,
      bannerComponents: 78,
    });

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
      separateA11yContainer: { controls: 9, files: 4 },
      // +1 control / +1 file vs 20/11: the #2259 "No emails" switch; then
      // +4 controls / +1 file: the four #2249 display-wizard step controls,
      // which the shell's render-callback indirection puts out of reach of
      // both coverage rules (see the delta chain above).
      leaves: { controls: 25, files: 13 },
    });
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

      let defaulted = 0;
      for (const use of uses) {
        const parent = use.parent;
        // (a) the destructured parameter, which must default to false.
        if (ts.isBindingElement(parent) && parent.name === use) {
          if (parent.initializer?.kind !== ts.SyntaxKind.FalseKeyword) {
            offenders.push(`${at(use)} declared without \`= false\``);
          } else {
            defaulted += 1;
          }
          continue;
        }
        // (b) the prop-type declaration in view-only-action.tsx.
        if (ts.isPropertySignature(parent) && parent.name === use) continue;
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

      if (vouched.length > 0 && defaulted !== 1) {
        offenders.push(
          `${f.rel} opts ${vouched.length} control(s) out via the prop but ` +
            `destructures it with a \`= false\` default ${defaulted} time(s)`,
        );
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
    const vouchChildren = new Map<string, Set<string>>(); // file -> exports
    for (const f of astFiles) {
      const names = vouchChildExports(f.ast);
      if (names.length > 0) vouchChildren.set(f.file, new Set(names));
    }
    expect(vouchChildren.size, "no vouched children found").toBeGreaterThan(0);

    const offenders: string[] = [];
    const vouchedSomewhere = new Set<string>();

    for (const parent of astFiles) {
      const imports = namedImports(parent.file, parent.ast);
      const banners = bannerRenderSites(parent.ast);

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
    const vouchChildren = new Map<string, Set<string>>();
    for (const f of astFiles) {
      const names = vouchChildExports(f.ast);
      if (names.length > 0) vouchChildren.set(f.file, new Set(names));
    }

    const offenders: string[] = [];
    for (const f of astFiles) {
      const imports = namedImports(f.file, f.ast);
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
