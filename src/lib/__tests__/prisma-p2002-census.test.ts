import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { moduleImports, productionSourceFiles } from "./support/static-import-graph";
import { stripComments } from "./support/strip-comments";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

/**
 * #5407 item 6 (`INV-SSOT-001`): a unique-constraint failure is recognised by
 * one of two predicates, never written out inline.
 *
 * - `isPrismaUniqueConstraintError` (`src/lib/prisma-errors.ts`): any object
 *   whose `code` is `P2002`, by shape.
 * - `isPrismaKnownUniqueConstraintError` (`src/lib/prisma-known-errors.ts`):
 *   the same, and an instance of `Prisma.PrismaClientKnownRequestError`.
 *
 * Nineteen sites used to spell the class-based test inline, and four more the
 * shape-based one, each slightly differently.
 *
 * ## What it matches
 *
 * Every quoted `P2002` (single, double or backtick quotes) in production code
 * under `src/`, with comments stripped and strings kept, keyed by
 * `file :: line`. Any inline test of the code needs the literal, whether it
 * sits beside an `instanceof`, a duck-typed `.code` read or a named constant,
 * so this is broader than looking for one shape (`INV-SSOT-004`). A site that
 * adds a condition of its own (which constraint collided) calls a predicate
 * for the class and code and keeps its condition, so it holds no literal.
 *
 * ## READS `src/` FROM DISK
 *
 * `pnpm run test:related` cannot select it. Run it with `pnpm run test:named`.
 *
 * ## What it does not see
 *
 * The code built at run time (`"P" + "2002"`), read from a variable filled
 * elsewhere, or compared through `Prisma.PrismaClientKnownRequestError`'s
 * other fields; and `scripts/`, `prisma/` and tests, which hold none today.
 */

const PREDICATE_MODULES = ["src/lib/prisma-errors.ts", "src/lib/prisma-known-errors.ts"];

/** Each reviewed literal outside the predicate modules, as `file :: line`. */
const REVIEWED_P2002_LITERALS = [
  // The bed range assignment retries ONE time on either a unique collision or
  // a write conflict (P2034), but not on P2028, which isTransactionContention
  // would include. A set of codes, read through its own class-checked reader.
  "src/lib/bed-allocation-range-assign.ts :: const RETRYABLE_RANGE_WRITE_CODES: ReadonlySet<string> = new Set([\"P2002\", \"P2034\"]);",
  // After that retry, a second collision is reported as the bed-night race.
  "src/lib/bed-allocation-range-assign.ts :: if (prismaErrorCode(retryError) === \"P2002\") {",
];

const QUOTED_P2002 = /(["'`])P2002\1/g;

/** `file :: trimmed line` for each quoted `P2002` in comment-stripped code. */
function quotedP2002Lines(file: string, code: string): string[] {
  return [...code.matchAll(QUOTED_P2002)].map((match) => {
    const start = code.lastIndexOf("\n", match.index) + 1;
    const end = code.indexOf("\n", match.index);
    return `${file} :: ${code.slice(start, end === -1 ? undefined : end).trim()}`;
  });
}

/**
 * A direct read of a Prisma error's `meta.target` (#5407): the driver adapter
 * this stack uses never fills it, so a narrowing that reads it alone never
 * fires. `describeUniqueConstraintTarget` in `prisma-errors.ts` is the one
 * reader. Matches, in comment-stripped code, `meta.target`, `meta?.target`,
 * `meta!.target`, `meta["target"]` (each with optional `!` and `?.`), and a
 * cast on one line, `(error.meta as { target?: string[] }).target`. Not seen:
 * a destructured `{ target }` from `meta`, a cast split across lines, and
 * `meta` copied into a variable of another name first.
 */
const META_TARGET_READ =
  /\bmeta\s*!?\s*\??\.\s*target\b|\bmeta\s*!?\s*\??\.?\s*\[\s*(["'`])target\1\s*\]|\bmeta\s+as\b[^;\n]*?\)\s*!?\s*\??\.\s*target\b/;

function read(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("Prisma P2002 census (#5407 item 6)", { timeout: CENSUS_TIMEOUT_MS }, () => {
  const files = productionSourceFiles();

  it("reads the production tree", () => {
    expect(files.length).toBeGreaterThan(500);
    for (const home of PREDICATE_MODULES) expect(files).toContain(home);
  });

  it("finds a P2002 literal only in the two predicate modules and the reviewed sites", () => {
    const found = files
      .filter((file) => !PREDICATE_MODULES.includes(file))
      .flatMap((file) => quotedP2002Lines(file, stripComments(read(file))));
    expect(
      found.sort(),
      "recognise P2002 with isPrismaKnownUniqueConstraintError (Prisma's class) or isPrismaUniqueConstraintError (any object with the code)",
    ).toEqual([...REVIEWED_P2002_LITERALS].sort());
  });

  it("reads meta.target only in prisma-errors.ts, the one constraint reader (#5407)", () => {
    const readers = files
      .filter((file) => file !== "src/lib/prisma-errors.ts")
      .filter((file) => META_TARGET_READ.test(stripComments(read(file))));
    expect(
      readers,
      "the driver adapter never fills meta.target: read the colliding constraint with describeUniqueConstraintTarget",
    ).toEqual([]);
    expect(META_TARGET_READ.test(stripComments(read("src/lib/prisma-errors.ts")))).toBe(true);
  });

  it("keeps prisma-errors.ts import-free and prisma-known-errors.ts on the Prisma runtime alone", () => {
    const imports = (file: string) => moduleImports(file, stripComments(read(file))).map((entry) => entry.specifier);
    expect(imports("src/lib/prisma-errors.ts")).toEqual([]);
    expect(imports("src/lib/prisma-known-errors.ts")).toEqual(["@prisma/client"]);
  });

  describe("the matcher", () => {
    it.each([
      ['error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"', 1],
      ["(error as { code?: unknown }).code === 'P2002'", 1],
      ["const UNIQUE = `P2002`;", 1],
      ['new Set(["P2002", "P2034"])', 1],
      ['error.code === "P2025"', 0],
      ['"P20021"', 0],
    ])("counts %j as %i", (code, expected) => {
      expect(quotedP2002Lines("x.ts", code)).toHaveLength(expected);
    });

    it.each([
      ["error.meta?.target", true],
      ["err.meta.target.includes(x)", true],
      ["error.meta?.['target']", true],
      ['meta["target"]', true],
      ["error.meta!.target", true],
      ["(error.meta as { target?: string[] }).target", true],
      ["(err.meta as Record<string, unknown>)?.target", true],
      ["(metadata as { target?: string }).target", false],
      ["link.metadata?.target", false],
      ["target.invoiceId", false],
    ])("treats %j as a meta.target read: %s", (code, expected) => {
      expect(META_TARGET_READ.test(code)).toBe(expected);
    });

    it("ignores P2002 named only in a comment once comments are stripped", () => {
      expect(quotedP2002Lines("x.ts", stripComments('// was code === "P2002"\nconst x = 1;'))).toEqual([]);
    });
  });
});
