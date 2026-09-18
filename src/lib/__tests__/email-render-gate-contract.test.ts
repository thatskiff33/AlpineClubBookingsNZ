/**
 * The render gate is only a guarantee while EVERY send path goes through it
 * (#2900).
 *
 * `emailPalette()` is synchronous, so nothing in the template layer can wait for
 * the club's Site Style theme to load. The guarantee therefore lives one level
 * up: a sending module builds its themed HTML inside `renderEmailHtml()`, which
 * awaits `ensureEmailPaletteReady()` first. One module that renders a template
 * directly re-opens the exact defect this issue reported — the first email from
 * a fresh process in the public default palette, the next one in the club's.
 *
 * That cannot be caught by types (the templates return plain strings) and it
 * cannot be caught by a hand-written list of send sites, because a new sender is
 * exactly the thing a list forgets. So this test reads the SOURCE TREE: it finds
 * every module that imports a palette-reading render function from
 * `email-templates/`, and checks that each call to one is inside a
 * `renderEmailHtml(...)` argument. A brand-new sender module is covered the
 * moment it is written.
 *
 * ## Why this runs on the TypeScript AST and not on file text
 *
 * The first version of this guard hand-rolled a lexer to mask comments and
 * quoted strings. It had no template-literal case, so an apostrophe inside a
 * backtick string opened a bogus quoted-string mask that ran to the next `'` in
 * the file — blinding the scan over huge regions. Measured on that version:
 * 50.7% of `email/booking.ts`, 63.6% of `email-message-renderer.ts`, and in
 * `email/family.ts` everything from line 235 (`You've joined ${groupName}`) to
 * end of file. Six real ungated render calls sat inside those blind spots and
 * the guard passed green — and because the codemod that applied the gate used
 * the same scanner, those six were the exact sites it skipped
 * (`booking.ts:797`, `family.ts:236/256/271/286`, `membership.ts:410`).
 *
 * A guard whose own lexer can go blind is worse than no guard, because it reads
 * as complete. So the scan is now `ts.createSourceFile` over the real grammar:
 * template literals, their `${...}` holes, regex literals and comments are the
 * compiler's problem, not ours, and "is this call inside the gate" is answered
 * by node containment instead of by paren counting. That is also the house
 * pattern for tree-scanning contract tests here (see
 * `exclusivity-request-write-sites.test.ts`).
 *
 * ## Why "palette-reading", not "named *Template"
 *
 * The first version only recognised imported names ending in `Template`. Nine
 * exports of `email-templates/layout.ts` read the palette without that suffix —
 * `layout`, `heading`, `paragraph`, `button`, `infoTable`, `muted`,
 * `multilineBlock`, `alertBox`, `supportEmailLink` — so a sender that composed a
 * body out of those instead of calling a `*Template` function would render
 * themed HTML outside the gate with every assertion here still passing.
 *
 * This version derives the set instead: a `email-templates/` export is
 * palette-reading if it calls `emailPalette()`, or calls anything that does.
 * That closure runs over MODULE-PRIVATE helpers too, which is load-bearing —
 * `refundRequestApprovedTemplate` reaches the palette only through the
 * unexported `refundRequestOutcomeLayout`, so a closure over exports alone would
 * have dropped both refund-appeal templates out of the guarded set.
 *
 * Deliberate exemptions are listed in `EXEMPT_FILES` with their reasons, and the
 * list is asserted to be exactly those files — an exemption that stops being
 * needed fails this test rather than quietly widening the hole.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const SRC_DIR = "src";
const TEMPLATE_DIR_SEGMENT = "email-templates";
const TEMPLATE_DIR = join(SRC_DIR, "lib", TEMPLATE_DIR_SEGMENT);
/** The synchronous accessor every themed template ultimately reads. */
const PALETTE_ACCESSOR = "emailPalette";
const GATE = "renderEmailHtml";

/**
 * Files that import a palette-reading render function but must NOT be gated.
 *
 * `src/lib/email-templates/**` is the template layer itself and is excluded
 * structurally rather than listed here: those modules compose each other, and
 * gating a leaf would make the shell async.
 */
const EXEMPT_FILES: ReadonlyArray<{ file: string; why: string }> = [];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const toPosix = (file: string) => relative(".", file).split(sep).join("/");

function parseFile(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** The called name, for both `foo()` and `x.foo()`. */
function calleeName(node: ts.CallExpression): string | undefined {
  const target = node.expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.name)) {
    return target.name.text;
  }
  return undefined;
}

/** Every name called anywhere inside `node`. */
function calledNames(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name !== undefined) names.add(name);
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return names;
}

function isExported(stmt: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(stmt) &&
    (ts.getModifiers(stmt) ?? []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

/**
 * The `email-templates/` exports that read the club palette, directly or through
 * any chain of helpers in that directory (private helpers included).
 *
 * Names are keyed bare rather than per-module, which is deliberately
 * conservative: two same-named helpers in different template files union their
 * callees, so the closure can only ever over-approximate. Over-approximating
 * makes the guard ask for MORE gating, never less.
 */
function paletteReadingTemplateExports(): Set<string> {
  const callees = new Map<string, Set<string>>();
  const exported = new Set<string>();

  for (const file of listSourceFiles(TEMPLATE_DIR)) {
    const sourceFile = parseFile(file);
    for (const stmt of sourceFile.statements) {
      const exportedHere = isExported(stmt);
      const record = (name: string, body: ts.Node) => {
        const seen = callees.get(name) ?? new Set<string>();
        for (const called of calledNames(body)) seen.add(called);
        callees.set(name, seen);
        if (exportedHere) exported.add(name);
      };
      if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) {
        record(stmt.name.text, stmt);
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) {
            continue;
          }
          record(decl.name.text, decl.initializer);
        }
      }
    }
  }

  const reads = new Set<string>();
  for (const [name, called] of callees) {
    if (called.has(PALETTE_ACCESSOR)) reads.add(name);
  }
  // Transitive closure: a helper that calls a palette-reading helper reads the
  // palette too.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, called] of callees) {
      if (reads.has(name)) continue;
      for (const one of called) {
        if (reads.has(one)) {
          reads.add(name);
          grew = true;
          break;
        }
      }
    }
  }

  return new Set([...reads].filter((name) => exported.has(name)));
}

/**
 * Local names in `sourceFile` bound to a palette-reading `email-templates/`
 * export, keyed by the LOCAL name (so `import { x as y }` is matched as `y`).
 */
function importedRenderFunctions(
  sourceFile: ts.SourceFile,
  paletteReading: ReadonlySet<string>,
): Map<string, string> {
  const local = new Map<string, string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!stmt.moduleSpecifier.text.includes(`${TEMPLATE_DIR_SEGMENT}/`)) {
      continue;
    }
    // `import type { … }` binds no value, so it can render nothing.
    if (stmt.importClause?.isTypeOnly === true) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const exportedName = (element.propertyName ?? element.name).text;
      if (paletteReading.has(exportedName)) {
        local.set(element.name.text, exportedName);
      }
    }
  }
  return local;
}

interface RenderCall {
  file: string;
  fn: string;
  line: number;
  gated: boolean;
}

/**
 * Every call to a palette-reading render function in this module, each marked
 * with whether it sits inside a `renderEmailHtml(...)` argument.
 */
function findRenderCalls(
  file: string,
  sourceFile: ts.SourceFile,
  renderFns: ReadonlyMap<string, string>,
): RenderCall[] {
  const calls: RenderCall[] = [];
  let gateDepth = 0;

  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== undefined && renderFns.has(name)) {
        calls.push({
          file,
          fn: name,
          line:
            sourceFile.getLineAndCharacterOfPosition(
              node.expression.getStart(sourceFile),
            ).line + 1,
          gated: gateDepth > 0,
        });
      }
      if (name === GATE) {
        // The gate's own callee is not gated by itself; its ARGUMENTS are the
        // region in which building themed HTML is allowed.
        walk(node.expression);
        gateDepth++;
        for (const argument of node.arguments) walk(argument);
        gateDepth--;
        return;
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  return calls;
}

interface SendingModule {
  file: string;
  sourceFile: ts.SourceFile;
  renderFns: Map<string, string>;
}

function sendingModules(paletteReading: ReadonlySet<string>): SendingModule[] {
  const templatePrefix = `${toPosix(TEMPLATE_DIR)}/`;
  const modules: SendingModule[] = [];
  for (const path of listSourceFiles(SRC_DIR)) {
    const file = toPosix(path);
    if (file.startsWith(templatePrefix)) continue;
    const sourceFile = parseFile(path);
    const renderFns = importedRenderFunctions(sourceFile, paletteReading);
    if (renderFns.size === 0) continue;
    modules.push({ file, sourceFile, renderFns });
  }
  return modules;
}

describe("email render gate contract (#2900)", () => {
  const paletteReading = paletteReadingTemplateExports();
  const exempt = new Set(EXEMPT_FILES.map((e) => e.file));
  const modules = sendingModules(paletteReading);
  const calls = modules
    .filter(({ file }) => !exempt.has(file))
    .flatMap(({ file, sourceFile, renderFns }) =>
      findRenderCalls(file, sourceFile, renderFns),
    );

  it("finds the sending modules by reading the tree, not from a list", () => {
    // A guard over an empty population is a guard that passes for the wrong
    // reason. If either of these collapses, the discovery above has broken and
    // the real assertion below would pass vacuously.
    expect(modules.length).toBeGreaterThanOrEqual(15);
    expect(calls.length).toBeGreaterThanOrEqual(100);
  });

  it("treats every palette-reading template export as needing the gate, not just *Template names", () => {
    // The nine layout blocks that read the palette without a `Template` suffix.
    // A sender composing a body from these renders themed HTML just as much as
    // one calling a `*Template` function, so the guard must know about them.
    for (const helper of [
      "layout",
      "heading",
      "paragraph",
      "button",
      "infoTable",
      "muted",
      "multilineBlock",
      "alertBox",
      "supportEmailLink",
    ]) {
      expect(paletteReading.has(helper), `${helper} reads emailPalette()`).toBe(
        true,
      );
    }
    // Reached only through an unexported helper — the case a closure over
    // exports alone silently drops.
    expect(paletteReading.has("refundRequestApprovedTemplate")).toBe(true);
    expect(paletteReading.has("refundRequestDeclinedTemplate")).toBe(true);
    // And it must NOT be "everything in the directory", or the guard would stop
    // discriminating: these exports read no colour.
    //
    // "formatCents" passes here VACUOUSLY since #3302 (equivalence lens,
    // confirmed harmless but worth stating so the next reader is not misled):
    // `layout.ts` changed it from a delegating function declaration to
    // `export { formatCents } from "@/lib/utils"`, and
    // `paletteReadingTemplateExports()` above only walks
    // `ts.isFunctionDeclaration` and `ts.isVariableStatement` — it does not
    // see a bare `ExportDeclaration` at all, so `formatCents` is absent from
    // BOTH `callees` and `exported` rather than present-and-verified-clean.
    // `.has("formatCents")` still returns `false` either way, so this
    // assertion still passes, but it is no longer proof this scanner looked
    // at `formatCents` and found no palette read — it is proof the scanner
    // cannot see a re-export at all. Still true in substance (the re-export
    // delegates to a pure, palette-free helper), just true for a different
    // reason than this test's own shape claims.
    for (const plain of [
      "escapeHtml",
      "formatCents",
      "formatChoreRosterDate",
      "WHITE",
      "BASE_URL",
    ]) {
      expect(paletteReading.has(plain), `${plain} reads no palette`).toBe(false);
    }
  });

  it("builds every themed email inside renderEmailHtml()", () => {
    expect(
      calls.filter((c) => !c.gated).map((c) => `${c.file}:${c.line} ${c.fn}()`),
      "Each of these renders themed email HTML outside the render gate, so on a " +
        "cold process it would be coloured with the shipped default palette " +
        "instead of the club's saved Site Style theme (#2900). Wrap the call: " +
        "`await renderEmailHtml(() => yourTemplate(...))`.",
    ).toEqual([]);
  });

  it("imports the gate wherever it renders", () => {
    const missing = modules
      .filter(({ file }) => !exempt.has(file))
      .filter(({ sourceFile }) => !/renderEmailHtml/.test(sourceFile.text))
      .map(({ file }) => file);
    expect(missing).toEqual([]);
  });

  it("keeps the exemption list to exactly the files that still need one", () => {
    // Empty today. Anything added here must carry a reason, and must really
    // render themed email — a stale exemption is a hole nobody can see.
    const discovered = new Set(modules.map((m) => m.file));
    for (const { file, why } of EXEMPT_FILES) {
      expect(why.length, `${file} needs a reason`).toBeGreaterThan(20);
      expect(discovered.has(file), `${file} no longer renders email`).toBe(true);
    }
  });
});
