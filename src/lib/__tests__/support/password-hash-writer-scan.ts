import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Scanner for the `passwordHash` writer census (#4610, INV-AUTH-005).
//
// A writer is any place a value is given to a `passwordHash` property: an
// object-literal property (`passwordHash: x`, `"passwordHash": x`), a shorthand
// property (`{ passwordHash }`), or an assignment (`row.passwordHash = x`,
// `row["passwordHash"] = x`). Types, selects (`passwordHash: true|false`) and
// destructuring reads are not writers, and the TypeScript parser tells those
// shapes apart, so comments and strings never count.
//
// Each writer is reported with its enclosing named function ("scope") and
// whether an awaited `screenChosenPassword(...)` call precedes it in that scope.

export const SCREEN_HELPER = "screenChosenPassword";

export type PasswordHashWriterSite = {
  file: string;
  scope: string;
  line: number;
  screenedBefore: boolean;
};

const REPO_ROOT = process.cwd();
export const PASSWORD_HASH_SCAN_ROOTS = ["src", "prisma", "scripts"] as const;

function walk(relative: string): string[] {
  const absolute = path.join(REPO_ROOT, relative);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "migrations") {
        return [];
      }
      return walk(child);
    }
    return /\.(?:[cm]?tsx?|[cm]?js)$/.test(entry.name) ? [child] : [];
  });
}

/** Every non-test source file under the scan roots, relative and `/`-separated. */
export function passwordHashScanFiles(): string[] {
  return PASSWORD_HASH_SCAN_ROOTS.flatMap(walk).filter(
    (file) =>
      !file.includes("/__tests__/") &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
      !file.endsWith(".d.ts"),
  );
}

function nameText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function scopeNode(node: ts.Node): { name: string; node: ts.Node } | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return { name: current.name.text, node: current };
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return { name: current.parent.name.text, node: current };
    }
    if (ts.isMethodDeclaration(current)) {
      return { name: nameText(current.name) ?? "anonymous-method", node: current };
    }
  }
  return null;
}

function isWriterNode(node: ts.Node): boolean {
  if (ts.isPropertyAssignment(node) && nameText(node.name) === "passwordHash") {
    const value = node.initializer;
    return value.kind !== ts.SyntaxKind.TrueKeyword && value.kind !== ts.SyntaxKind.FalseKeyword;
  }
  if (ts.isShorthandPropertyAssignment(node) && node.name.text === "passwordHash") {
    return true;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    const left = node.left;
    if (ts.isPropertyAccessExpression(left) && left.name.text === "passwordHash") return true;
    if (ts.isElementAccessExpression(left) && nameText(left.argumentExpression) === "passwordHash") {
      return true;
    }
  }
  return false;
}

/** An awaited `screenChosenPassword(...)` call ending before `position` inside `within`. */
function screenedBefore(within: ts.Node, position: number): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === SCREEN_HELPER &&
      ts.isAwaitExpression(node.parent) &&
      node.getEnd() <= position
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(within);
  return found;
}

export function scanPasswordHashWriters(file: string, source: string): PasswordHashWriterSite[] {
  const kind = /\.tsx$/.test(file)
    ? ts.ScriptKind.TSX
    : /\.[cm]?js$/.test(file)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const sites: PasswordHashWriterSite[] = [];
  const visit = (node: ts.Node): void => {
    if (isWriterNode(node)) {
      const scope = scopeNode(node);
      const position = node.getStart(sourceFile);
      sites.push({
        file,
        scope: scope?.name ?? "module",
        line: sourceFile.getLineAndCharacterOfPosition(position).line + 1,
        screenedBefore: screenedBefore(scope?.node ?? sourceFile, position),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

export function scanRepositoryPasswordHashWriters(): PasswordHashWriterSite[] {
  return passwordHashScanFiles().flatMap((file) =>
    scanPasswordHashWriters(file, fs.readFileSync(path.join(REPO_ROOT, file), "utf8")),
  );
}
