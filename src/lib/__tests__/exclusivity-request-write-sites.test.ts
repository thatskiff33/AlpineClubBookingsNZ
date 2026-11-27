import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { AST_CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

/*
  #2263 / ADR-001 (dated entry, 2026-07-30) — the sanctioned front-doors that may
  ASK for a whole-lodge exclusive hold.

  The behavioural pin in booking-request.test.ts proves the PUBLIC create path
  writes no `exclusivityRequested`. It cannot prove anything about a door that
  does not exist yet: a fourth front-door added next year would simply not be
  covered by a test nobody thought to write. This scan closes that. It finds
  every WRITE of `exclusivityRequested` in the source tree and asserts the set of
  files containing one is exactly the sanctioned set.

  Why this flag is worth a scan of its own. It is the request-side half of the
  one capacity action that sterilises every bed in the lodge (ADR-001). A path
  that could set it without an authenticated, capped, audited requester behind it
  would let somebody ask the club to empty the building on a date of their
  choosing. The ADMIN action that GRANTS the hold (`Booking.wholeLodgeHold`) is a
  separate flag and deliberately out of scope: an admin may set that on any
  booking, and only the REQUEST front-doors are enumerated here.

  It runs over the TypeScript AST rather than over file text, for the reason
  `view-only-banner-contract.test.ts` had to learn twice: raw text cannot tell a
  write from a Prisma `select`, from a type declaration, or from prose about any
  of them — and the files in this area are heavily commented with the very
  expressions being matched.

  Adding a legitimate new door means adding it to SANCTIONED_WRITE_SITES with a
  reason, which is exactly the reviewable diff this test exists to force.
*/

const SRC = join(process.cwd(), "src");

/*
  The scan roots. `src/` is the obvious one; `prisma/` and `scripts/` are here
  because they are the two places that write to this database WITHOUT going
  through a route or a service — a seed, a backfill, or a one-off operator script
  could stamp `exclusivityRequested` on rows with no requester, no cap, no audit
  and no attribution, and a src-only scan would never see it. Neither directory
  is allowed a write site at all, so both simply must contribute nothing to the
  found set.
*/
const SCAN_ROOTS = [SRC, join(process.cwd(), "prisma"), join(process.cwd(), "scripts")];

type SanctionedSite = {
  reason: string;
  /**
   * How many WRITE assignments this file is allowed. A count, not a boolean:
   * "this file may write the flag" is a much weaker statement than "this file
   * writes it in exactly N places", and a new write smuggled into an
   * already-sanctioned file is precisely the change that would otherwise slip
   * through a set-equality assertion.
   */
  writes: number;
};

/**
 * The only files allowed to WRITE `exclusivityRequested`, each with why and how
 * many times. A file listed here must still write it for an authenticated or
 * email-verified requester — the entry records the decision, it does not waive
 * it.
 */
const SANCTIONED_WRITE_SITES: Record<string, SanctionedSite> = {
  // Door 1 — the school/group front-door (#121). Public, but email-verified,
  // rate limited, and it lands in the officer queue holding nothing.
  "lib/school-booking-request.ts": {
    reason:
      "SCHOOL front-door: persists the requester's exclusivity ask on submission, and re-states it in the approval audit metadata (#121, ADR-001); the member whole-lodge approval audits it too (#2263).",
    writes: 4,
  },
  "app/api/booking-requests/school/route.ts": {
    reason:
      "SCHOOL front-door route: validates the submitted flag in its Zod schema and passes it to createSchoolBookingRequest.",
    writes: 2,
  },
  // Door 2 — the authenticated member door (#2263). Session-bound, capped at two
  // open requests, rate limited per-IP and per-member, always attributed.
  "lib/booking-request.ts": {
    reason:
      "MEMBER whole-lodge front-door: createMemberWholeLodgeRequest stamps exclusivityRequested together with requestedByMemberId, from the session only; the admin serialiser re-emits the stored value for the queue badge (#2263).",
    writes: 3,
  },
};

/**
 * Prisma delegates whose write payloads must never receive an opaque object
 * spread inside a sanctioned file. The AST scan above can only see LITERAL
 * property assignments, so `data: { ...body }` would carry
 * `exclusivityRequested` straight through it — invisible to the write-site set
 * and to anybody grepping for the field name.
 */
const GUARDED_WRITE_METHODS = new Set(["create", "update", "updateMany", "upsert"]);
const GUARDED_PAYLOAD_KEYS = new Set(["data", "create", "update"]);

/** Prisma clause keys whose object literals are READS, never writes. */
const READ_CLAUSE_KEYS = new Set([
  "select",
  "where",
  "include",
  "orderBy",
  "omit",
  "distinct",
  "_count",
]);

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests describe the rule; they do not implement a front-door.
      if (entry.name === "__tests__") return [];
      return listSourceFiles(entryPath);
    }
    return /\.(ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function eachNode(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  node.forEachChild((child) => eachNode(child, visit));
}

/**
 * True when this `exclusivityRequested` property assignment is a WRITE.
 *
 * A `PropertySignature` (`exclusivityRequested: boolean` in an interface) is not
 * a PropertyAssignment at all, so type declarations never reach here. A property
 * nested anywhere inside a Prisma `select` / `where` / `include` object is a
 * read of the column, not a write to it, and is excluded — otherwise every
 * consumer that merely LOOKS at the flag would masquerade as a front-door and
 * the list would stop meaning anything.
 */
function isWriteAssignment(node: ts.PropertyAssignment): boolean {
  if (isConnectionShapeEntry(node)) return false;
  let cursor: ts.Node | undefined = node.parent;
  while (cursor) {
    if (
      ts.isPropertyAssignment(cursor) &&
      (ts.isIdentifier(cursor.name) || ts.isStringLiteral(cursor.name)) &&
      READ_CLAUSE_KEYS.has(cursor.name.text)
    ) {
      return false;
    }
    cursor = cursor.parent;
  }
  return true;
}

const CONNECTION_SHAPE_BUILDERS = new Set(["connectionShapeFor", "completeConnectionShapeFor"]);
const CONNECTION_SHAPE_TYPES = new Set(["ConnectionShapeFor", "CompleteConnectionShapeFor"]);

/**
 * True for `exclusivityRequested: true` inside an AI app connection shape
 * (ALP-719): an allow-list of the fields a connection is SENT, a read of the
 * value like a Prisma `select`. Only the literal `true`, and only inside a
 * `connectionShapeFor(...)` argument or a `satisfies ConnectionShapeFor<…>`
 * literal, so a real payload cannot borrow the exemption.
 */
function isConnectionShapeEntry(node: ts.PropertyAssignment): boolean {
  if (node.initializer.kind !== ts.SyntaxKind.TrueKeyword) return false;
  let cursor: ts.Node | undefined = node.parent;
  while (cursor) {
    if (
      ts.isCallExpression(cursor) &&
      ts.isIdentifier(cursor.expression) &&
      CONNECTION_SHAPE_BUILDERS.has(cursor.expression.text)
    ) {
      return true;
    }
    if (
      ts.isSatisfiesExpression(cursor) &&
      ts.isTypeReferenceNode(cursor.type) &&
      ts.isIdentifier(cursor.type.typeName) &&
      CONNECTION_SHAPE_TYPES.has(cursor.type.typeName.text)
    ) {
      return true;
    }
    cursor = cursor.parent;
  }
  return false;
}

function countWriteSites(file: string): number {
  let found = 0;
  eachNode(parse(file), (node) => {
    if (!ts.isPropertyAssignment(node)) return;
    if (!ts.isIdentifier(node.name)) return;
    if (node.name.text !== "exclusivityRequested") return;
    if (isWriteAssignment(node)) found += 1;
  });
  return found;
}

/**
 * Spread expressions a reader can audit at the call site: an inline object
 * literal, or a conditional between them (`...(cond ? {} : { guests })`), which
 * is the shape the approval paths use to vary one known key. What is REJECTED is
 * an opaque spread — an identifier, a property access, a call result — because
 * its keys are decided somewhere else, possibly by a request body.
 */
function isAuditableSpread(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return isAuditableSpread(expression.expression);
  }
  if (ts.isObjectLiteralExpression(expression)) return true;
  if (ts.isConditionalExpression(expression)) {
    return (
      isAuditableSpread(expression.whenTrue) &&
      isAuditableSpread(expression.whenFalse)
    );
  }
  if (ts.isBinaryExpression(expression)) {
    // `cond && { … }` / `x ?? { … }` — both branches must still be literals.
    return (
      isAuditableSpread(expression.left) || isAuditableSpread(expression.right)
    );
  }
  return false;
}

/** Every opaque spread inside a `bookingRequest` write payload in this file. */
function findOpaqueBookingRequestSpreads(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const ast = parse(file);
  const offences: string[] = [];

  eachNode(ast, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!ts.isPropertyAccessExpression(node.expression)) return;
    const method = node.expression.name.text;
    if (!GUARDED_WRITE_METHODS.has(method)) return;
    // `prisma.bookingRequest.create` / `tx.bookingRequest.update` / …
    const delegate = node.expression.expression;
    if (!ts.isPropertyAccessExpression(delegate)) return;
    if (delegate.name.text !== "bookingRequest") return;

    const [arg] = node.arguments;
    if (!arg || !ts.isObjectLiteralExpression(arg)) return;

    for (const property of arg.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      if (!ts.isIdentifier(property.name)) continue;
      if (!GUARDED_PAYLOAD_KEYS.has(property.name.text)) continue;
      if (!ts.isObjectLiteralExpression(property.initializer)) continue;
      for (const entry of property.initializer.properties) {
        if (!ts.isSpreadAssignment(entry)) continue;
        if (isAuditableSpread(entry.expression)) continue;
        const { line } = ast.getLineAndCharacterOfPosition(entry.getStart(ast));
        offences.push(
          `${relative(process.cwd(), file).split(sep).join("/")}:${line + 1} — ` +
            `${source.slice(entry.getStart(ast), entry.getEnd()).trim()}`,
        );
      }
    }
  });

  return offences;
}

/**
 * Every scanned file with at least one write, keyed the way the map is.
 * Memoised: parsing the whole tree costs ~12s, and three assertions ask the same
 * question.
 */
let scanned: Record<string, number> | null = null;
function scanWriteSites(): Record<string, number> {
  if (scanned) return scanned;
  const counts: Record<string, number> = {};
  for (const root of SCAN_ROOTS) {
    for (const file of listSourceFiles(root)) {
      const writes = countWriteSites(file);
      if (writes === 0) continue;
      // src/ paths stay relative to src/ (the map's existing shape); prisma/ and
      // scripts/ report their directory so an offender there is unmistakable.
      const key =
        root === SRC
          ? relative(SRC, file).split(sep).join("/")
          : relative(process.cwd(), file).split(sep).join("/");
      counts[key] = writes;
    }
  }
  scanned = counts;
  return counts;
}

// The scan parses every .ts/.tsx file under src/, prisma/ and scripts/, which
// takes well past the 5s default on a loaded box. Memoised above, so this budget
// covers one pass.
describe("whole-lodge exclusivity request write sites (#2263, ADR-001)", { timeout: AST_CENSUS_TIMEOUT_MS }, () => {
  it("has exactly the sanctioned front-doors and no others, across src, prisma and scripts", () => {
    const found = Object.keys(scanWriteSites()).sort();

    expect(
      found,
      "A file that WRITES exclusivityRequested is a front-door for asking the " +
        "club to sterilise every bed in the lodge. Only the authenticated " +
        "member door (#2263) and the email-verified school door (#121) are " +
        "sanctioned — and a seed, backfill or operator script may never write " +
        "it at all, because such a row would have no requester, no cap, no " +
        "attribution and no audit. Add a new door to SANCTIONED_WRITE_SITES " +
        "with its reason, or take the write out.",
    ).toEqual(Object.keys(SANCTIONED_WRITE_SITES).sort());
  });

  it("writes the flag in exactly the sanctioned number of places per file", () => {
    const expected = Object.fromEntries(
      Object.entries(SANCTIONED_WRITE_SITES).map(([file, site]) => [
        file,
        site.writes,
      ]),
    );

    expect(
      scanWriteSites(),
      "An already-sanctioned file gained (or lost) an exclusivityRequested " +
        "write. Set-equality alone would not have noticed. Update the `writes` " +
        "count with the new site's reason in the same diff.",
    ).toEqual(expected);
  });

  it("never spreads an opaque object into a BookingRequest write payload", () => {
    /*
      The AST scan above can only see literal `exclusivityRequested:` property
      assignments. `data: { ...body }` or `data: { ...input }` defeats it
      completely — the flag arrives from an object assembled elsewhere, so the
      write-site set stays "correct" while an unauthenticated caller's payload
      decides whether the club is asked to empty the lodge. Inline literals and
      conditionals between them stay allowed: their keys are visible right there.
    */
    const offences = Object.keys(SANCTIONED_WRITE_SITES).flatMap((file) =>
      findOpaqueBookingRequestSpreads(join(SRC, file)),
    );

    expect(
      offences,
      "Spread an inline object literal with named keys instead, so the field " +
        "set of a BookingRequest write is readable at the call site.",
    ).toEqual([]);
  });

  it("keeps the member door attributing every request it opens", () => {
    /*
      The member door's guarantee is not merely "it may set the flag" but "it
      always says who asked". An unattributed member-origin row would be
      invisible to My requests, uncounted by the open-request cap, and
      impossible for its own author to withdraw — a request that can only ever
      be resolved by an admin noticing it.
    */
    const source = readFileSync(join(SRC, "lib", "booking-request.ts"), "utf8");
    const ast = parse(join(SRC, "lib", "booking-request.ts"));

    let createBody: string | null = null;
    eachNode(ast, (node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === "createMemberWholeLodgeRequest"
      ) {
        createBody = source.slice(node.getStart(ast), node.getEnd());
      }
    });

    expect(createBody, "createMemberWholeLodgeRequest was not found").not.toBeNull();
    expect(createBody!).toContain("exclusivityRequested: true");
    expect(createBody!).toContain("requestedByMemberId: member.id");
  });
});
