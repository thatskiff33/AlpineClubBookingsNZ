/**
 * AI app connection shapes (ALP-719, `INV-MCP-006`): the modules under
 * `src/lib/connection-shapes/` that list, field by field, what a connection's
 * answer may carry. In them `field: true` means "send this field", never a
 * Prisma `select`, and an interface field is the type of an answer the route
 * already built. A census that hunts for a column being selected or written
 * skips them; `connection-shape-modules.test.ts` keeps that honest by failing
 * if one of them ever loads anything but the projection and its siblings.
 */
import { moduleImports } from "./static-import-graph";

export const CONNECTION_SHAPE_DIR = "src/lib/connection-shapes/";

/** The only modules a shape may load at runtime. */
export const CONNECTION_SHAPE_RUNTIME_IMPORTS: readonly RegExp[] = [
  /^@\/lib\/connection-projection$/,
  /^@\/lib\/connection-shapes\/[a-z0-9-]+$/,
];

/** Whether a repo-relative path is a connection shape module. */
export function isConnectionShapeModule(file: string): boolean {
  return file.replaceAll("\\", "/").startsWith(CONNECTION_SHAPE_DIR);
}

/** Runtime imports of a shape module outside the allowed set, as `file:line specifier`. */
export function forbiddenShapeImports(file: string, text: string): string[] {
  return moduleImports(file, text)
    .filter((entry) => entry.kind !== "type")
    .filter((entry) => !CONNECTION_SHAPE_RUNTIME_IMPORTS.some((allowed) => allowed.test(entry.specifier)))
    .map((entry) => `${file}:${entry.line} ${entry.specifier}`);
}
