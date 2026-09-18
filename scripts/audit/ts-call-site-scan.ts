/**
 * The shared TypeScript call-site scanning primitives (#2723).
 *
 * WHY THIS FILE EXISTS. `audit-writer-census.ts` (#2581) worked out, over a
 * review round and six demonstrated bypasses, how to answer "which call sites
 * pass which top-level property" from the AST rather than from a grep. The
 * credential-actor census (#2723) asks the identical question of a different
 * set of functions. Copying the walk would have produced a second instrument
 * that measures differently — which is exactly the shape `INV-SSOT-004` names:
 * two instruments claiming independence agree wherever both are blind. So the
 * walk lives here once and both censuses import it.
 *
 * WHAT IS HERE is only what is genuinely generic: listing source files, parsing,
 * walking, unwrapping an expression, reading an object literal's own top-level
 * keys with spreads resolved, and naming the enclosing symbol. Everything that
 * knows what a particular census is looking FOR stays in that census.
 *
 * THE FAIL-CLOSED RULE TRAVELS WITH IT, because it is the part that took the
 * bruises. A property whose NAME the parser cannot resolve — a computed key,
 * a getter, a method — marks the whole object `unreadableKeys`, so every lookup
 * on it fails closed rather than reporting the key it asked for as absent. A
 * spread of INLINE literals contributes its key names (with opaque values,
 * since a spread may or may not be present at run time); a spread of anything
 * else marks the object unreadable.
 *
 * WHAT IT STILL DOES NOT SEE, stated because the alternative is a false
 * completeness claim: this parses each file with `createSourceFile` and no type
 * checker — a full program over ~1,900 files costs minutes — so a value reached
 * through an alias created by assignment rather than declaration, or handed back
 * from a helper, is invisible. That is why the TYPE and the RUNTIME assertion at
 * each boundary are the primary defences and a census is the backstop.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

import ts from "typescript";

export const SOURCE_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs)$/;

export const DECLARATION_AND_TEST_FILES = /(\.test\.|\.spec\.|\.d\.ts$)/;

/** Repo-relative POSIX form, so a census reads the same on Windows and Linux. */
export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/**
 * Every source file under `dir`, skipping the named directories and the test /
 * declaration files. The skip set is a PARAMETER rather than a constant because
 * the two censuses draw different boundaries: the audit census skips `e2e`
 * (Playwright describes writers rather than being one), while the credential
 * census must walk it — the E2E stack seeds real credentials through the real
 * store, so a seed that stopped naming an actor is a finding, not noise.
 */
export function listSourceFiles(
  dir: string,
  out: string[],
  skipDirectories: ReadonlySet<string>,
): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirectories.has(entry.name)) continue;
      listSourceFiles(full, out, skipDirectories);
      continue;
    }
    if (!SOURCE_EXTENSIONS.test(entry.name)) continue;
    if (DECLARATION_AND_TEST_FILES.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

export function parseSourceFile(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

export function eachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => eachNode(child, visit));
}

/** Strip parentheses and `as` / `satisfies` wrappers. */
export function unwrap(node: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(node)) return unwrap(node.expression);
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return unwrap(node.expression);
  }
  return node;
}

/** The text of a string literal or a template with no substitutions. */
export function literalText(node: ts.Expression): string | null {
  const inner = unwrap(node);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
    return inner.text;
  }
  return null;
}

export function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

export type TopLevelProperty =
  | { kind: "assignment"; value: ts.Expression }
  | { kind: "opaque"; text: string };

/**
 * A view of an object literal's OWN top-level keys, with spreads resolved as far
 * as they can be read at the call site. `unreadableKeys` means some key was set
 * by something the parser cannot name, so every lookup on it has to fail closed.
 *
 * WHY IT IS SHAPED THIS WAY, WITH THE MEASUREMENTS THAT SHAPED IT. This block
 * travelled here from `audit-writer-census.ts` with the code it describes
 * (#2723): the rule left, the evidence for it did not, and a rule whose reasons
 * live in another file is one the next editor relaxes for a good-sounding
 * reason.
 *
 * A spread of INLINE literals contributes its key names, rather than marking
 * the object unreadable, for one measured reason: the deletion-rejected writer
 * in `src/app/api/admin/deletion-requests/[id]/route.ts` spreads
 * `...(suppressed ? { metadata } : {})` and passes no category. A census that
 * failed closed on any spread would report that site as "category decided
 * elsewhere" instead of as the omission it is, and the uncategorised count would
 * read 81 rather than 82 — a site quietly moved from the population that has to
 * be fixed into an allowlist. A conditional / `&&` / `??` between literals reads
 * the same way, exactly as `exclusivity-request-write-sites.test.ts` reads its
 * own payloads. A spread of anything opaque — an identifier, a call result —
 * still fails closed, because its keys are decided somewhere a reviewer cannot
 * see.
 *
 * `unreadableKeys` ALSO covers a property whose NAME the parser cannot resolve,
 * and that is not hypothetical tidiness (#2695 review). A computed key —
 * `{ [SOME_CONSTANT]: … }`, or even `{ ["memberDisclosure"]: … }` — and a getter
 * (`{ get memberDisclosure() { … } }`) both compile, both set the key at run
 * time, and both used to be DROPPED: the walk skipped what it could not name, so
 * the object measured as though the key were absent. For `category` that
 * reported an omission that is not one; for `memberDisclosure` it was worse,
 * because `absent` is the safe answer and therefore the unpinned one — a real
 * member-facing declaration would have measured as neither declared nor
 * forwarded, i.e. invisible to the census while the reader honoured it and the
 * member read the text. Anything this walk cannot name marks the whole object
 * unreadable, which puts every lookup on it into a pinned `forwarded`
 * population instead.
 */
export type ResolvedObject = {
  keys: Map<string, TopLevelProperty>;
  unreadableKeys: boolean;
};

export function spreadLiterals(
  expression: ts.Expression,
): ts.ObjectLiteralExpression[] | null {
  const inner = unwrap(expression);
  if (ts.isObjectLiteralExpression(inner)) return [inner];
  if (ts.isConditionalExpression(inner)) {
    const whenTrue = spreadLiterals(inner.whenTrue);
    const whenFalse = spreadLiterals(inner.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  if (ts.isBinaryExpression(inner)) {
    // `cond && { … }` / `value ?? { … }` — read whichever side is a literal.
    const left = spreadLiterals(inner.left);
    const right = spreadLiterals(inner.right);
    if (left && right) return [...left, ...right];
    return right ?? left;
  }
  return null;
}

export function resolveObjectLiteral(
  literal: ts.ObjectLiteralExpression,
): ResolvedObject {
  const keys = new Map<string, TopLevelProperty>();
  let unreadableKeys = false;

  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = propertyName(property.name);
      if (!name) {
        // A COMPUTED key: `{ [KEY]: … }`, or a numeric one. It sets some key at
        // run time and the parser cannot say which, so every lookup on this
        // object has to fail closed rather than report the key it asked for as
        // absent.
        unreadableKeys = true;
        continue;
      }
      keys.set(name, { kind: "assignment", value: property.initializer });
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      keys.set(property.name.text, {
        kind: "opaque",
        text: property.name.text,
      });
      continue;
    }
    if (ts.isSpreadAssignment(property)) {
      const branches = spreadLiterals(property.expression);
      if (!branches) {
        unreadableKeys = true;
        continue;
      }
      for (const branch of branches) {
        const resolved = resolveObjectLiteral(branch);
        unreadableKeys = unreadableKeys || resolved.unreadableKeys;
        for (const [name, value] of resolved.keys) {
          // A key that arrives through a spread may or may not be present at
          // runtime, so its VALUE is not readable even when its name is.
          keys.set(name, { kind: "opaque", text: `spread ${name}` });
          void value;
        }
      }
      continue;
    }
    // A getter, a setter, a method, or whatever the language adds next. Each
    // can name a key a census reads and none of them holds an initialiser
    // expression to read, so the object is unreadable rather than short of one
    // property.
    unreadableKeys = true;
  }

  return { keys, unreadableKeys };
}

export function findTopLevelProperty(
  resolved: ResolvedObject,
  key: string,
): TopLevelProperty | null {
  return resolved.keys.get(key) ?? null;
}

/**
 * The enclosing function/method/class/variable chain, `<module>` at top level.
 *
 * Used as stable site identity: line numbers move under a rebase — #2618 alone
 * moved one writer from line 131 to line 293 — and a symbol chain does not.
 * Named function declarations, methods, classes and `const fn = …` initialisers
 * all contribute; an anonymous arrow inside one of them does not, so a reformat
 * that wraps a call in another callback does not change the identity.
 */
export function symbolChain(node: ts.Node): string {
  const names: string[] = [];
  let cursor: ts.Node | undefined = node.parent;
  while (cursor) {
    if (
      (ts.isFunctionDeclaration(cursor) ||
        ts.isMethodDeclaration(cursor) ||
        ts.isClassDeclaration(cursor)) &&
      cursor.name &&
      ts.isIdentifier(cursor.name)
    ) {
      names.unshift(cursor.name.text);
    } else if (
      ts.isVariableDeclaration(cursor) &&
      ts.isIdentifier(cursor.name)
    ) {
      names.unshift(cursor.name.text);
    }
    cursor = cursor.parent;
  }
  return names.length ? names.join(".") : "<module>";
}

/** A call node that is really a declaration's own name, not an invocation. */
export function isDeclarationName(call: ts.CallExpression): boolean {
  return (
    ts.isFunctionDeclaration(call.parent) || ts.isMethodDeclaration(call.parent)
  );
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
