import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * #4467 item 3: a shared form schema is shared, or it is not doing its job.
 *
 * `src/lib/forms/*-schema.ts` holds the zod schemas a form and its API route
 * both validate with, so the browser cannot let through what the route
 * refuses. Two ways that quietly stops being true, and this census fails each:
 *
 * - **It stops being importable by the form.** A schema module that grows a
 *   server import (`@/lib/prisma`, a helper that reaches it) ships that to the
 *   browser, or fails the build. `client-server-boundary-census.test.ts`
 *   catches the server-only modules it lists, one hop or many; this is the
 *   cheaper, stricter rule for this folder: `zod` and nothing else.
 * - **One side stops using it.** A route that goes back to an inline schema,
 *   or a form that stops validating, leaves two rule sets again with nothing
 *   comparing them (`INV-SSOT`). Each schema module must be imported by at
 *   least one API route and at least one `"use client"` module.
 *
 * Imports are read from TypeScript's own parse, so a specifier mentioned in
 * a comment does not count, and neither does a type-only import: it
 * validates nothing.
 */

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const FORMS = path.join(SRC, "lib", "forms");
const SCHEMA_SUFFIX = "-schema.ts";
const ALLOWED_SCHEMA_IMPORTS = new Set(["zod"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "node_modules" || entry === "__tests__" ? [] : walk(full);
    }
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false);
}

/**
 * The module specifiers a file imports or re-exports a VALUE from. A
 * type-only import validates nothing, so `import type { … }` and an import
 * whose every name is `type` do not count as using a schema.
 */
function importsOf(file: string): string[] {
  const specifiers: string[] = [];
  for (const statement of parse(file).statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      const bindings = clause?.namedBindings;
      const onlyTypeNames =
        clause !== undefined &&
        clause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly);
      if (onlyTypeNames) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

/** The file an import specifier names, without extension, or null if not in `src`. */
function resolveSpecifier(from: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return path.join(SRC, specifier.slice(2));
  if (specifier.startsWith(".")) return path.resolve(path.dirname(from), specifier);
  return null;
}

function isClientModule(file: string): boolean {
  const first = parse(file).statements[0];
  return Boolean(
    first &&
      ts.isExpressionStatement(first) &&
      ts.isStringLiteral(first.expression) &&
      first.expression.text === "use client",
  );
}

function isApiRoute(file: string): boolean {
  const relative = path.relative(SRC, file).split(path.sep).join("/");
  return relative.startsWith("app/api/") && /\/route\.ts$/.test(relative);
}

const schemaModules = readdirSync(FORMS)
  .filter((entry) => entry.endsWith(SCHEMA_SUFFIX))
  .map((entry) => path.join(FORMS, entry));

const sourceFiles = walk(SRC);

function importersOf(schemaFile: string): string[] {
  const target = schemaFile.replace(/\.ts$/, "");
  return sourceFiles.filter((file) =>
    importsOf(file).some((specifier) => resolveSpecifier(file, specifier) === target),
  );
}

describe("shared form schemas (#4467)", () => {
  it("finds the schema modules it polices", () => {
    // A census that matched nothing would pass every rule below.
    expect(schemaModules.length).toBeGreaterThan(0);
    expect(schemaModules.map((file) => path.basename(file))).toContain(
      "committee-role-schema.ts",
    );
  });

  it.each(schemaModules.map((file) => [path.relative(ROOT, file), file]))(
    "%s imports nothing but zod",
    (_label, file) => {
      const outside = importsOf(file).filter(
        (specifier) => !ALLOWED_SCHEMA_IMPORTS.has(specifier),
      );
      expect(
        outside,
        "a shared form schema is imported by a browser form: keep it to zod",
      ).toEqual([]);
    },
  );

  it.each(schemaModules.map((file) => [path.relative(ROOT, file), file]))(
    "%s is imported by an API route and by a client form",
    (_label, file) => {
      const importers = importersOf(file);
      const relative = importers.map((importer) => path.relative(ROOT, importer));
      expect(
        importers.filter(isApiRoute).length,
        `no API route imports it; importers: ${relative.join(", ") || "none"}`,
      ).toBeGreaterThan(0);
      expect(
        importers.filter(isClientModule).length,
        `no "use client" module imports it; importers: ${relative.join(", ") || "none"}`,
      ).toBeGreaterThan(0);
    },
  );
});
