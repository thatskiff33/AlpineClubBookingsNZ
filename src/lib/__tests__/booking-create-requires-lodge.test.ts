/*
 * #2701 — A BOOKING MUST NAME ITS LODGE, AND THE SERVER NO LONGER GUESSES.
 *
 * `resolveOptionalActiveLodgeId` answers a missing id with the club's DEFAULT
 * lodge. On a read that is a convenience; on a CREATE it is how a member ends
 * up paid up at a lodge they were never shown — reachable whenever
 * `/api/lodges` fails, because `LodgeSelect` then renders nothing, the
 * selection normalises to `null`, and both wizards posted no lodge at all.
 *
 * Ten client surfaces are fixed alongside this. THIS is the gate that closes
 * the class: one refusal instead of ten guards, so the eleventh screen written
 * next year fails loudly here instead of writing quietly to the wrong lodge.
 */

import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  BOOKING_LODGE_REQUIRED_CODE,
  BOOKING_LODGE_UNRESOLVED_MEMBER_MESSAGE,
} from "@/lib/booking-lodge-scope";

/**
 * The route module pulls in the whole booking service graph, so the refusal is
 * exercised here through the exact predicate the route applies, plus a source
 * assertion that the route really applies it. The end-to-end refusal is proved
 * by `POST /api/bookings` returning 400 in the route suite and by the E2E
 * booking-create census, which now names a lodge on every direct create.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

const ROUTE = readFileSync(
  join(process.cwd(), "src/app/api/bookings/route.ts"),
  "utf8",
);

const CREATE_SERVICE_NAMES = new Set([
  "createDraftBooking",
  "createConfirmedBooking",
  "createWaitlistedBooking",
]);

type ProductionCreateCall = {
  file: string;
  service: string;
  hasDefinedLodgeId: boolean;
};

function listProductionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return listProductionTypeScriptFiles(absolute);
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) return [];
    const repoPath = relative(process.cwd(), absolute).replaceAll("\\", "/");
    if (
      repoPath.includes("/__tests__/") ||
      /\.(?:test|spec)\.tsx?$/.test(repoPath)
    ) {
      return [];
    }
    return [absolute];
  });
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function objectLiteralHasDefinedLodgeId(
  expression: ts.Expression | undefined,
): boolean {
  if (!expression) return false;
  const value = unwrapExpression(expression);
  if (!ts.isObjectLiteralExpression(value)) return false;
  return value.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    const name = property.name;
    const isLodgeId =
      name !== undefined &&
      ((ts.isIdentifier(name) && name.text === "lodgeId") ||
        (ts.isStringLiteral(name) && name.text === "lodgeId"));
    if (!isLodgeId) return false;
    const initializer = unwrapExpression(property.initializer);
    return !(
      (ts.isIdentifier(initializer) && initializer.text === "undefined") ||
      initializer.kind === ts.SyntaxKind.NullKeyword ||
      ts.isVoidExpression(initializer)
    );
  });
}

function expressionFrom(sourceText: string): ts.Expression | undefined {
  const source = ts.createSourceFile(
    "fixture.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const statement = source.statements[0];
  return statement && ts.isExpressionStatement(statement)
    ? statement.expression
    : undefined;
}

function collectProductionCreateCalls(): ProductionCreateCall[] {
  const calls: ProductionCreateCall[] = [];
  for (const absolute of listProductionTypeScriptFiles(
    join(process.cwd(), "src"),
  )) {
    const file = relative(process.cwd(), absolute).replaceAll("\\", "/");
    const source = ts.createSourceFile(
      file,
      readFileSync(absolute, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      absolute.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const importedServices = new Map<string, string>();
    const importedNamespaces = new Set<string>();

    source.statements.forEach((statement) => {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== "@/lib/booking-create"
      ) {
        return;
      }
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        importedNamespaces.add(bindings.name.text);
      } else if (bindings && ts.isNamedImports(bindings)) {
        bindings.elements.forEach((element) => {
          const exported = element.propertyName?.text ?? element.name.text;
          if (CREATE_SERVICE_NAMES.has(exported)) {
            importedServices.set(element.name.text, exported);
          }
        });
      }
    });

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        let service: string | undefined;
        if (ts.isIdentifier(node.expression)) {
          service = importedServices.get(node.expression.text);
        } else if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          importedNamespaces.has(node.expression.expression.text) &&
          CREATE_SERVICE_NAMES.has(node.expression.name.text)
        ) {
          service = node.expression.name.text;
        }
        if (service) {
          calls.push({
            file,
            service,
            hasDefinedLodgeId: objectLiteralHasDefinedLodgeId(node.arguments[0]),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return calls;
}

// Parse the production tree once per test file. Running this census separately
// in both assertions made the gate vulnerable to Vitest's five-second timeout
// when the focused suite shared a busy worker pool.
const PRODUCTION_CREATE_CALLS = collectProductionCreateCalls();

describe("POST /api/bookings — the lodge is required (#2701)", { timeout: CENSUS_TIMEOUT_MS }, () => {
  it("refuses before resolving, so the default lodge is never reached", () => {
    // MUTATION PROBE: delete the `if (!parsed.data.lodgeId)` block and this
    // fails. That block is the whole fix; without it
    // `resolveOptionalActiveLodgeId(prisma, undefined)` returns
    // `getDefaultLodgeId(...)` and the booking is written against a lodge the
    // caller never named.
    const guardIndex = ROUTE.indexOf("if (!parsed.data.lodgeId)");
    const resolveIndex = ROUTE.indexOf("const bookingLodgeId = await resolveOptionalActiveLodgeId");

    expect(guardIndex, "the create must refuse an unnamed lodge").toBeGreaterThan(-1);
    expect(resolveIndex).toBeGreaterThan(-1);
    // Order matters: refusing AFTER resolving would still have consulted the
    // default lodge, and a later reader would reasonably move the guard.
    expect(guardIndex).toBeLessThan(resolveIndex);
  });

  it("answers with the machine-readable code, not only prose", () => {
    expect(ROUTE).toContain("BOOKING_LODGE_REQUIRED_CODE");
    expect(BOOKING_LODGE_REQUIRED_CODE).toBe("BOOKING_LODGE_REQUIRED");
  });

  it("keeps the refusal a 400, not a 500", () => {
    // The caller sent a bad request; nothing failed.
    const guardIndex = ROUTE.indexOf("if (!parsed.data.lodgeId)");
    const window = ROUTE.slice(guardIndex, guardIndex + 600);
    expect(window).toContain("status: 400");
  });

  it("leaves the SHARED helper permissive, so read contracts are untouched", () => {
    // Deliberately not fixed by making `resolveOptionalActiveLodgeId` strict:
    // that helper also serves reads where an omitted lodge legitimately means
    // "the whole club", and `INV-INT-016` retains exactly such a mode on
    // `GET /api/bookings/rooms` for consumers outside this repository.
    const helper = readFileSync(
      join(process.cwd(), "src/lib/lodges.ts"),
      "utf8",
    );
    const start = helper.indexOf("export async function resolveOptionalActiveLodgeId");
    expect(start).toBeGreaterThan(-1);
    expect(helper.slice(start, start + 500)).toContain("getDefaultLodgeId(db)");
  });

  it("gives the member something they can act on", () => {
    // Not a field-validation string about a control they were never offered.
    expect(BOOKING_LODGE_UNRESOLVED_MEMBER_MESSAGE).toMatch(
      /nothing has been booked or charged/i,
    );
    expect(BOOKING_LODGE_UNRESOLVED_MEMBER_MESSAGE).toMatch(/try again/i);
  });

  it("keeps an insertion/deletion census of every production service create", () => {
    // The HTTP refusal is not the only door into these services. Admin copy and
    // group join both bypass the route, and each once omitted its authoritative
    // lodge. An exact census makes a newly-added internal door a deliberate
    // contract change rather than another silent default-lodge write.
    expect(
      PRODUCTION_CREATE_CALLS
        .map(({ file, service }) => `${file}:${service}`)
        .sort(),
    ).toEqual(
      [
        "src/app/api/bookings/route.ts:createConfirmedBooking",
        "src/app/api/bookings/route.ts:createDraftBooking",
        "src/app/api/bookings/route.ts:createWaitlistedBooking",
        "src/lib/admin-booking-copy.ts:createDraftBooking",
        "src/lib/booking-exception-approval.ts:createConfirmedBooking",
        "src/lib/group-booking.ts:createConfirmedBooking",
        "src/lib/waitlist-cross-lodge.ts:createConfirmedBooking",
      ].sort(),
    );
  });

  it("requires every production service create to name its lodge", () => {
    // MUTATION PROBE: remove `lodgeId` from either admin-booking-copy.ts or
    // group-booking.ts and this reports the exact internal writer that would
    // fall through the service's legacy default-lodge compatibility path.
    expect(
      PRODUCTION_CREATE_CALLS
        .filter((call) => !call.hasDefinedLodgeId)
        .map(({ file, service }) => `${file}:${service}`),
    ).toEqual([]);
  });

  it("does not launder indirection or an explicitly undefined lodge green", () => {
    // The service's required type checks typed aliases/wrappers, and its runtime
    // guard catches unchecked ones. This syntax census independently refuses
    // the two shapes that previously made a production call look compliant
    // without presenting a definite field at the call itself.
    expect(
      objectLiteralHasDefinedLodgeId(expressionFrom("input")),
    ).toBe(false);
    expect(
      objectLiteralHasDefinedLodgeId(expressionFrom("({ ...input })")),
    ).toBe(false);
    expect(
      objectLiteralHasDefinedLodgeId(
        expressionFrom("({ lodgeId: undefined })"),
      ),
    ).toBe(false);
    expect(
      objectLiteralHasDefinedLodgeId(expressionFrom("({ lodgeId: void 0 })")),
    ).toBe(false);
    expect(
      objectLiteralHasDefinedLodgeId(expressionFrom("({ lodgeId: null })")),
    ).toBe(false);
    expect(
      objectLiteralHasDefinedLodgeId(
        expressionFrom("({ lodgeId: booking.lodgeId })"),
      ),
    ).toBe(true);
  });
});
