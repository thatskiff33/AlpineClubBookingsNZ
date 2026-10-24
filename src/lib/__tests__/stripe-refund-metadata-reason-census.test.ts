import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { relativeSource, sourceFiles } from "@/lib/__tests__/support/booking-guest-night-writer-scan";
import { cardRefundDoorOf } from "@/lib/card-refund-own-note-share";
import * as keys from "@/lib/payment-recovery-keys";

/**
 * #4312 review (`INV-ADDPAY-047`, `INV-SSOT`): EVERY STRIPE REFUND THE APP
 * MAKES STAMPS A `reason` IN ITS METADATA.
 *
 * The `charge.refunded` webhook gives a card refund on a bank transfer a Xero
 * note of its own only when the refund carries no app `reason`
 * (`cardRefundDoorOf` reads it as made in the Stripe dashboard). A door that
 * refunded with no `reason` would be taken for the dashboard: its refund noted
 * by the webhook AND by the door's own note - one refund credited twice. So:
 *
 * - every call that makes a Stripe refund (`processRefund`,
 *   `refundPaymentTransactions`, called bare or as a member) outside tests
 *   passes an object literal with a `metadata` property - read off the
 *   TypeScript AST, so a comment, a string or a property of the same name
 *   nested deeper never counts. Its value is one of the builders the last
 *   test proves (`payment-recovery-keys.ts`), or an object literal whose own
 *   top-level `reason` has a non-empty value. `undefined`, `null`, a ternary,
 *   an empty `reason` and anything the walk cannot read (a spread in place of
 *   the property or after it, which may replace it at runtime, an argument
 *   passed whole) are findings, never passes;
 * - every metadata builder in `payment-recovery-keys.ts` stamps a non-empty one,
 *   so a door passing a builder's answer is read as an app door.
 *
 * A variable passed as `metadata` is read through the `const` a block around
 * the call declares, by the same rules. What it cannot see: a parameter passed
 * on as `metadata` (`refundPaymentTransactions` forwarding its own to
 * `processRefund`: its callers are the sites checked), the value of a variable
 * passed as `reason`, a variable reassigned after its declaration, and a
 * refund made through an alias of either function or straight through
 * `stripe.refunds` (only `processRefund` does).
 *
 * A source scan: `pnpm run test:related` cannot select it, so it runs by name.
 */
const REFUND_FUNCTIONS = new Set(["processRefund", "refundPaymentTransactions"]);

/** The expression under any parentheses, `as`, `satisfies` or `!`. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** The called function's own name - bare (`processRefund(...)`) or a member (`deps.refundPaymentTransactions(...)`). */
function calleeName(call: ts.CallExpression): string | null {
  const callee = unwrap(call.expression);
  return ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
}

/** The metadata builders whose every answer the last test proves stamps a reason. */
const METADATA_BUILDERS = new Set(Object.keys(keys).filter((name) => /RefundMetadata$/.test(name)));

function isUndefined(node: ts.Expression): boolean {
  return ts.isIdentifier(node) && node.text === "undefined";
}

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
  if ((ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return property.name.text;
  return null;
}

/** The object literal's own top-level property of that name (the last, as at runtime), or null. */
function ownProperty(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | null {
  return [...object.properties].reverse().find((property) => propertyName(property) === name) ?? null;
}

/** Whether a spread follows the property in its object literal: it may replace the property at runtime, so the census cannot read it. */
function spreadAfter(object: ts.ObjectLiteralExpression, property: ts.ObjectLiteralElementLike): boolean {
  return object.properties.slice(object.properties.indexOf(property) + 1).some((later) => ts.isSpreadAssignment(later));
}

/** A value that names something at runtime: a non-blank literal, a variable, a member, a call or a template. */
function namesAValue(node: ts.Expression): boolean {
  const value = unwrap(node);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text.trim() !== "";
  if (ts.isIdentifier(value)) return !isUndefined(value);
  return ts.isPropertyAccessExpression(value) || ts.isCallExpression(value) || ts.isTemplateExpression(value);
}

/**
 * The initializer of the `const`/`let` of that name a block around `from`
 * declares, nearest first, or null: a parameter, a destructured name, or one
 * the census cannot find.
 */
function declaredValue(from: ts.Node, name: string): ts.Expression | null {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const declaration = statement.declarationList.declarations.find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name);
      if (declaration) return declaration.initializer ?? null;
    }
  }
  return null;
}

/** Why a metadata value does not stamp a reason, or null when it does (a variable read through its declaration). */
function metadataMissingReason(node: ts.Expression, seen: ReadonlySet<string> = new Set()): string | null {
  const value = unwrap(node);
  if (ts.isIdentifier(value)) {
    if (isUndefined(value)) return "metadata is undefined";
    if (seen.has(value.text)) return null;
    const declared = declaredValue(value, value.text);
    return declared ? metadataMissingReason(declared, new Set([...seen, value.text])) : null; // a parameter: its callers' metadata
  }
  if (ts.isCallExpression(value)) {
    const builder = calleeName(value);
    return builder && METADATA_BUILDERS.has(builder) ? null : `metadata is ${builder ?? "a call"}(...), not a builder this census proves`;
  }
  if (!ts.isObjectLiteralExpression(value)) return `metadata is ${ts.SyntaxKind[value.kind]}, which the census cannot prove names a reason`;
  const reason = ownProperty(value, "reason");
  if (!reason) return "metadata names no reason";
  if (spreadAfter(value, reason)) return "a spread after metadata's reason may replace it";
  if (ts.isShorthandPropertyAssignment(reason)) return null; // a variable named `reason`
  if (!ts.isPropertyAssignment(reason) || !namesAValue(reason.initializer)) return "metadata's reason is empty or not a value";
  return null;
}

/** Why a refund call's argument does not stamp a reason, or null when it does. */
function missingReason(call: ts.CallExpression): string | null {
  const [argument] = call.arguments;
  const options = argument ? unwrap(argument) : null;
  if (!options || !ts.isObjectLiteralExpression(options)) return "its options are not an object literal the census can read";
  const metadata = ownProperty(options, "metadata");
  if (!metadata) return "no metadata";
  if (spreadAfter(options, metadata)) return "a spread after metadata may replace it";
  if (ts.isShorthandPropertyAssignment(metadata)) return metadataMissingReason(metadata.name);
  if (!ts.isPropertyAssignment(metadata)) return "metadata is not a value";
  return metadataMissingReason(metadata.initializer);
}

/** Every refund call in the files: where it is, and the call. */
function refundCalls(files: ReadonlyArray<{ path: string; text: string }>): Array<{ at: string; call: ts.CallExpression }> {
  const calls: Array<{ at: string; call: ts.CallExpression }> = [];
  for (const { path, text } of files) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, /x$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && REFUND_FUNCTIONS.has(calleeName(node) ?? "")) {
        calls.push({ at: `${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`, call: node });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return calls;
}

/** Each refund call site that does not pass a `metadata` naming a reason: `path:line (why)`. */
function refundCallsWithoutReason(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  return refundCalls(files).flatMap(({ at, call }) => {
    const why = missingReason(call);
    return why ? [`${at} (${why})`] : [];
  });
}

/** Every non-test TypeScript source naming either function (a call cannot be made without its name), read once. */
function scannedFiles(): Array<{ path: string; text: string }> {
  return sourceFiles()
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => ({ path: relativeSource(file), text: readFileSync(file, "utf8") }))
    .filter(({ text }) => [...REFUND_FUNCTIONS].some((name) => text.includes(name)));
}

describe("every Stripe refund the app makes stamps a reason (#4312 review)", () => {
  it("every refund call outside tests passes metadata, and a literal one names a reason", () => {
    const files = scannedFiles();
    expect(refundCalls(files).length).toBeGreaterThan(15); // 18 when written
    expect(refundCallsWithoutReason(files)).toEqual([]);
  });

  const at = (text: string) => refundCallsWithoutReason([{ path: "x.ts", text }]).map((finding) => finding.replace(/ \(.*\)$/, ""));

  it("FAILS on a refund call with no metadata, or one the census cannot prove names a reason (fixture proof)", () => {
    expect(at("await processRefund({ paymentIntentId, amountCents });")).toEqual(["x.ts:1"]);
    expect(at("\nawait refundPaymentTransactions({ paymentId, metadata: { bookingId }, format });")).toEqual(["x.ts:2"]);
    expect(at("await processRefund({ metadata: undefined });")).toEqual(["x.ts:1"]);
    expect(at("await processRefund({ metadata: null });")).toEqual(["x.ts:1"]);
    expect(at("await processRefund({ metadata: ok ? { reason: \"a\" } : {} });")).toEqual(["x.ts:1"]);
    expect(at("await processRefund({ metadata: { reason: \"\" } });")).toEqual(["x.ts:1"]);
    expect(at("await processRefund({ metadata: { reason: \"  \" } });")).toEqual(["x.ts:1"]);
    expect(at("await processRefund({ metadata: { reason: undefined } });")).toEqual(["x.ts:1"]);
    expect(at("await processRefund({ metadata: { reason: null } });")).toEqual(["x.ts:1"]);
    expect(at("await processRefund({ metadata: { reason: ok ? \"a\" : undefined } });")).toEqual(["x.ts:1"]);
    expect(at("await processRefund({ metadata: { ...base, bookingId } });")).toEqual(["x.ts:1"]);
    expect(at("await processRefund({ metadata: metadata ?? {} });")).toEqual(["x.ts:1"]);
    expect(at("await processRefund({ metadata: anyHelper(bookingId) });")).toEqual(["x.ts:1"]);
    expect(at("await processRefund(options);")).toEqual(["x.ts:1"]);
    // A variable is read through its declaration, by the same rules.
    expect(at("const metadata = { bookingId };\nawait processRefund({ metadata });")).toEqual(["x.ts:2"]);
    expect(at("function f() {\n  const m = undefined;\n  if (x) { return processRefund({ metadata: m }); }\n}")).toEqual(["x.ts:3"]);
    expect(at("await processRefund({ ...options });")).toEqual(["x.ts:1"]);
    // A spread after the matched property may replace it at runtime: after metadata, or after its reason.
    expect(at("await processRefund({ metadata: { reason: \"x\" }, ...options });")).toEqual(["x.ts:1"]);
    expect(at("await processRefund({ metadata: { reason: \"x\", ...extra } });")).toEqual(["x.ts:1"]);
    expect(at("const metadata = { reason: \"x\", ...extra };\nawait processRefund({ metadata });")).toEqual(["x.ts:2"]);
  });

  it("FAILS where a reason sits anywhere but the metadata's own top level (fixture proof)", () => {
    // A `reason` nested a brace deeper, or on the refund call itself (Stripe's reason enum), is not the metadata's.
    expect(at("await processRefund({ metadata: { extra: { reason: \"x\" }, bookingId } });")).toEqual(["x.ts:1"]);
    expect(at("await processRefund({ reason: \"requested_by_customer\", metadata: { bookingId } });")).toEqual(["x.ts:1"]);
    // Another property spelled like metadata is not it.
    expect(at("await processRefund({ stripeMetadata: { reason: \"x\" } });")).toEqual(["x.ts:1"]);
    // A comment is not code: a commented-out metadata stamps nothing, and a commented-out call is no call.
    expect(at("await processRefund({ amountCents, /* metadata: { reason: \"x\" } */ });")).toEqual(["x.ts:1"]);
    expect(at("// processRefund({ amountCents });\n/* refundPaymentTransactions({}) */")).toEqual([]);
  });

  it("passes a literal reason past nested braces, a builder's answer, a variable, and a member call (fixture proof)", () => {
    expect(at("await stripe.processRefund({ metadata: { nested: { a: { b: 1 } }, reason: \"x\" } });")).toEqual([]);
    expect(at("await processRefund({ metadata: { bookingId, reason: REASON } });")).toEqual([]);
    expect(at("await processRefund({ metadata: { reason: `x_${id}` } as Record<string, string> });")).toEqual([]);
    expect(at("await processRefund({ metadata: buildLateCaptureRefundMetadata(bookingId) });")).toEqual([]);
    expect(at("await deps.refundPaymentTransactions({ metadata, format });")).toEqual([]); // a parameter
    expect(at("const metadata = { bookingId, reason: \"x\" };\nawait processRefund({ metadata });")).toEqual([]);
    expect(at("const m = buildRefundRequestRefundMetadata(b, r);\nawait processRefund({ metadata: m });")).toEqual([]);
    expect(at("send(() => refundPaymentTransactions({ metadata: m, format }));")).toEqual([]);
    // A spread before the property is overridden by it.
    expect(at("await processRefund({ ...options, metadata: { ...base, reason: \"x\" } });")).toEqual([]);
  });

  it("every metadata builder stamps a reason, so its refunds read as an app door's", () => {
    const builders = Object.entries(keys).filter(([name, value]) => /^build\w*RefundMetadata$/.test(name) && typeof value === "function");
    expect(builders.map(([name]) => name).sort()).toEqual([
      "buildBookingCancellationRefundMetadata",
      "buildBookingModificationRefundMetadata",
      "buildLateCaptureRefundMetadata",
      "buildRefundRequestRefundMetadata",
    ]);
    for (const [name, build] of builders) {
      const metadata = (build as (...args: string[]) => Record<string, string>)("booking-1", "reason-or-request");
      expect(metadata.reason, name).toEqual(expect.stringMatching(/\S/));
      expect(cardRefundDoorOf(metadata), name).not.toBe("outside-app");
    }
    // The census accepts a metadata built by exactly these: each is proved here.
    expect([...METADATA_BUILDERS].sort()).toEqual([...builders.map(([name]) => name), "cardRefundOperationRefundMetadata"].sort());
    for (const type of ["REFUND_SUPERSEDED_PAYMENT", "REFUND_BOOKING_MODIFICATION"]) {
      for (const idempotencyKey of ["refund_request_refund_rr-1", "booking_cancel_refund_recovery_b-1", "mod-refund-x"]) {
        const metadata = keys.cardRefundOperationRefundMetadata({ type, idempotencyKey, stripeKeyPrefix: null, bookingId: "booking-1" });
        expect(cardRefundDoorOf(metadata)).not.toBe("outside-app");
      }
    }
  });
});
