import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ADMIN_PAGES, adminPageRoutePath, getAdminPage, type AdminPageId } from "@/lib/admin-hubs";
import { adminPageFiles, toRawPathname } from "./helpers/admin-route-enumeration";

/**
 * Every admin page's heading is its menu name (#4968, INV-SSOT-008): the
 * registry label the sidebar, the palette and help already show. Each page's
 * `<h1>` — and the `title` of a component that renders one — is read from
 * disk as JSX, so a comment or an unrelated string cannot satisfy it, and every
 * loading, empty and loaded heading is checked. A heading is a string literal or
 * `getAdminPage("<id>").label`; anything else fails until it is excluded below.
 *
 * Detail, print, stub and test destinations are left out by the registry's own
 * `kind`; they have no fixed heading.
 */
const EXCLUDED: Partial<Record<AdminPageId, string>> = {
  "hut-leaders": "The heading is the club-configured hut-leader label, pluralised.",
  "notice-new": "NoticeEditor's card title depends on create or edit mode; it is not a fixed page heading.",
};

/**
 * #4968 leaves case-only differences out of scope and `docs/STYLE_GUIDE.md`
 * does not settle heading case, so these compare without case: a different
 * word still fails.
 */
const CASE_ONLY = new Set<AdminPageId>([
  "xero-member-grouping", "membership-types", "member-fields", "message-board", "google-setup",
]);

/** Components that render their `title` prop as the page's `<h1>`. */
const TITLE_COMPONENTS = new Set(["AdminPageHeader", "AdminHubPage", "AdminPageTabs"]);

const PAGE_FILES = new Map(adminPageFiles.map((file) => [toRawPathname(file), file]));

function headingValue(node: ts.Expression, file: string): string {
  if (ts.isStringLiteral(node)) return node.text;
  if (
    ts.isPropertyAccessExpression(node) && node.name.text === "label" &&
    ts.isCallExpression(node.expression) && node.expression.expression.getText() === "getAdminPage"
  ) {
    const id = node.expression.arguments[0];
    if (id && ts.isStringLiteral(id)) return getAdminPage(id.text as AdminPageId).label;
  }
  throw new Error(`${file}: unrecognised heading ${node.getText()}; read the registry label or exclude the page with a reason`);
}

/** The text of an `<h1>`: its literal text, or its one expression beside any icons. */
function h1Value(node: ts.JsxElement, file: string): string {
  const parts = node.children.filter((child) => !ts.isJsxText(child) || child.text.trim());
  const expressions = parts.filter(ts.isJsxExpression).filter((child) => child.expression);
  const text = parts.filter(ts.isJsxText).map((child) => child.text).join(" ")
    .replace(/\s+/g, " ").trim().replace(/&amp;/g, "&");
  if (!expressions.length) return text;
  if (text || expressions.length !== 1) throw new Error(`${file}: a heading mixing text and expressions needs explicit handling`);
  return headingValue(expressions[0]!.expression!, file);
}

/** Resolves an `@/` or relative import to its `.tsx` file, if it has one. */
function resolveImport(specifier: string, from: string): string | undefined {
  const base = specifier.startsWith("@/") ? path.resolve("src", specifier.slice(2))
    : specifier.startsWith(".") ? path.resolve(path.dirname(from), specifier) : undefined;
  return base && [`${base}.tsx`, path.join(base, "index.tsx")].find((candidate) => fs.existsSync(candidate));
}

function definesTitleComponent(tree: ts.SourceFile): boolean {
  return tree.statements.some((statement) =>
    ts.isFunctionDeclaration(statement) && !!statement.name && TITLE_COMPONENTS.has(statement.name.text));
}

/**
 * The headings `file` renders. A server wrapper that renders none of its own is
 * followed into the components it imports and renders. A title component is
 * checked where it is used, never in the file that defines it.
 */
function headingsIn(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const tree = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (seen.size > 1 && definesTitleComponent(tree)) return [];
  const headings: string[] = [];
  const rendered = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === "h1") {
      headings.push(h1Value(node, file));
    }
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const name = node.tagName.getText(tree);
      rendered.add(name);
      if (TITLE_COMPONENTS.has(name)) {
        const title = node.attributes.properties.find(
          (attr): attr is ts.JsxAttribute => ts.isJsxAttribute(attr) && attr.name.getText(tree) === "title",
        );
        const value = title?.initializer && ts.isJsxExpression(title.initializer)
          ? title.initializer.expression : title?.initializer;
        if (!value) throw new Error(`${file}: <${name}> has no title`);
        headings.push(headingValue(value, file));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (headings.length) return headings;
  return tree.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const clause = statement.importClause;
    const names = [
      clause?.name?.text,
      ...(clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
        ? clause.namedBindings.elements.map((binding) => binding.name.text) : []),
    ].filter((name): name is string => !!name && rendered.has(name) && !TITLE_COMPONENTS.has(name));
    if (!names.length) return [];
    const target = resolveImport(statement.moduleSpecifier.text, file);
    return target ? headingsIn(target, seen) : [];
  });
}

describe("admin page headings are their menu names (#4968, INV-SSOT-008)", () => {
  for (const page of ADMIN_PAGES) {
    if (page.kind !== "page" || EXCLUDED[page.id as AdminPageId]) continue;
    it(page.id, () => {
      const file = PAGE_FILES.get(adminPageRoutePath(page));
      expect(file, "the registry destination has a page file").toBeDefined();
      const headings = headingsIn(file!);
      expect(headings, "no heading found: render one, or exclude the page with a reason").not.toHaveLength(0);
      const fold = (value: string) => (CASE_ONLY.has(page.id as AdminPageId) ? value.toLowerCase() : value);
      for (const heading of headings) expect(fold(heading), file).toBe(fold(page.label));
    });
  }

  it("excludes only real pages, each still in the registry", () => {
    for (const id of [...Object.keys(EXCLUDED), ...CASE_ONLY]) {
      expect(getAdminPage(id as AdminPageId).kind).toBe("page");
    }
  });
});
