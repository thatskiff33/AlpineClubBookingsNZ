/**
 * Function lengths, measured (#4927).
 *
 * The file-size budget measures whole files, so a 2,000-line function in a file
 * that is allowed to be long passes it. This module lists the functions a
 * source file defines and the lines each one spans, so the function-length
 * ratchet (`scripts/lib/function-length-ratchet.ts`) can judge them the way the
 * file-size ratchet judges files.
 *
 * WHAT COUNTS AS A FUNCTION, deliberately the units a reader opens and reads
 * top to bottom:
 *
 *   - a top-level `function` declaration, exported or not, `default` included;
 *   - a function expression or arrow assigned to a top-level `const`/`let`
 *     (through `as`, `satisfies`, `!` and parentheses, which change no shape),
 *     including one passed to a wrapping call — `forwardRef(…)`, `memo(…)`,
 *     `withAuth(async () => …)` — whose span is the whole declaration;
 *   - a method, constructor or accessor of a top-level class (and of a class
 *     assigned to a top-level `const`).
 *
 * A function NESTED inside one of those is part of its enclosing function's
 * length, not a unit of its own. That is the point: a 2,000-line function that
 * keeps its phases as inner closures is still one 2,000-line function, and the
 * cure the ratchet asks for — typed functions that read only what they are
 * given — is a top-level function.
 *
 * An overload signature has no body and is not counted; the implementation is.
 * A span runs from the first token of the declaration (after its leading
 * comment, which is documentation rather than code) to its closing token.
 *
 * Uses the TypeScript compiler's parser only — no type checking, no program, no
 * file system. The caller supplies the text, so the same function measures the
 * working tree and the base ref.
 */
import ts from "typescript";

import { unwrap } from "./ts-unwrap";

export type FunctionSpan = {
  /**
   * The name a person would search for: `name`, `Class.method`,
   * `Class.constructor`, `Class.get name`, or `default` for an anonymous
   * default export. Unique within one file: a repeated name gets ` (2)`,
   * ` (3)`… in source order.
   */
  name: string;
  /** 1-based line of the first token. */
  startLine: number;
  /** 1-based line of the last token. */
  endLine: number;
  /** `endLine - startLine + 1`. */
  lines: number;
};

function scriptKindFor(file: string): ts.ScriptKind {
  if (/\.(tsx|jsx)$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.(js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * A function, or a call wrapping one (`forwardRef((props, ref) => …)`,
 * `memo(forwardRef(…))`): the shapes that make a top-level binding a function a
 * reader opens. A wrapped component is still one long component.
 */
function isFunctionValue(expression: ts.Expression): boolean {
  const value = unwrap(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return true;
  return ts.isCallExpression(value) && value.arguments.some(isFunctionValue);
}

function memberName(
  member: ts.ClassElement,
  sourceFile: ts.SourceFile,
): string | null {
  if (ts.isConstructorDeclaration(member)) return "constructor";
  const name = member.name;
  if (!name) return null;
  const text = ts.isIdentifier(name) || ts.isPrivateIdentifier(name)
    ? name.text
    : name.getText(sourceFile);
  if (ts.isGetAccessorDeclaration(member)) return `get ${text}`;
  if (ts.isSetAccessorDeclaration(member)) return `set ${text}`;
  return text;
}

/**
 * Every function in one source file, in source order.
 *
 * `file` is used only to pick the parser's dialect (`.tsx` and `.jsx` allow
 * JSX); it is never read from disk.
 */
export function measureFunctions(file: string, text: string): FunctionSpan[] {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(file),
  );
  const found: Array<{ name: string; node: ts.Node }> = [];

  const addClass = (className: string, node: ts.ClassLikeDeclaration) => {
    for (const member of node.members) {
      const hasBody =
        (ts.isMethodDeclaration(member) ||
          ts.isConstructorDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member)) &&
        member.body !== undefined;
      if (hasBody) {
        const name = memberName(member, sourceFile);
        if (name) found.push({ name: `${className}.${name}`, node: member });
        continue;
      }
      // `handler = async () => { … }` as a class field is a method in all but
      // syntax, and a long one is just as long.
      if (ts.isPropertyDeclaration(member) && member.initializer) {
        const value = unwrap(member.initializer);
        if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
          const name = memberName(member, sourceFile);
          if (name) found.push({ name: `${className}.${name}`, node: member });
        }
      }
    }
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (!statement.body) continue; // an overload signature
      found.push({ name: statement.name?.text ?? "default", node: statement });
      continue;
    }
    if (ts.isClassDeclaration(statement)) {
      addClass(statement.name?.text ?? "default", statement);
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      if (isFunctionValue(statement.expression)) {
        found.push({ name: "default", node: statement });
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer || !ts.isIdentifier(declaration.name)) continue;
      if (isFunctionValue(declaration.initializer)) {
        // The declaration, not the bare arrow, so a one-declaration statement's
        // span starts at `const` like a reader's eye does.
        const node =
          statement.declarationList.declarations.length === 1
            ? statement
            : declaration;
        found.push({ name: declaration.name.text, node });
        continue;
      }
      const value = unwrap(declaration.initializer);
      if (ts.isClassExpression(value)) addClass(declaration.name.text, value);
    }
  }

  const seen = new Map<string, number>();
  return found.map(({ name, node }) => {
    const occurrence = (seen.get(name) ?? 0) + 1;
    seen.set(name, occurrence);
    const startLine =
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const endLine =
      sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    return {
      name: occurrence === 1 ? name : `${name} (${occurrence})`,
      startLine,
      endLine,
      lines: endLine - startLine + 1,
    };
  });
}
