/**
 * #5167 review (INV-SSOT): a booking created already worth $0 is confirmed by
 * ONE Payment-row writer, `createZeroPriceConfirmationPayment`, whether it was
 * made by `createConfirmedBooking` or by the paid-booking import's free stay.
 * Before this the import hand-copied the create's row, and a change to one
 * (a provenance column, a PaymentTransaction row, the credit mirror) would
 * not have reached the other.
 *
 * Pinned here, by reading the source:
 * - the caller set is exactly the two creators, so a third door is a decision;
 * - neither creator writes a `$0` Payment row inline any more, so the copy
 *   cannot quietly return;
 * - in each caller's own function the order is the shared row, then the PAID
 *   status write (each caller keeps its own: the create stamps a capacity
 *   override, the import guards on PAYMENT_PENDING), then
 *   `postStoredBookingConfirmationLedgerLines`, which `#4660` requires.
 *
 * The row's own shape is checked against a recording transaction client.
 * WHAT THIS CANNOT SEE: a creator that confirms through a renamed helper.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PaymentStatus, type Prisma } from "@prisma/client";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { createZeroPriceConfirmationPayment } from "@/lib/booking-zero-price-payment";
import { callsInOwnBody, enclosingFunction } from "./support/function-scope";
import { productionSourceFiles } from "./support/prisma-delegate-read-scan";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

const ROOT = process.cwd();
const HELPER = "createZeroPriceConfirmationPayment";
const HELPER_FILE = "src/lib/booking-zero-price-payment.ts";
const CREATORS = ["src/lib/booking-create.ts", "src/lib/booking-import/write.ts"];

function parse(file: string): ts.SourceFile {
  const text = readFileSync(join(ROOT, file), "utf8");
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function calls(source: ts.SourceFile, match: (call: ts.CallExpression) => boolean): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && match(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const callsNamed = (name: string) => (call: ts.CallExpression) =>
  ts.isIdentifier(call.expression) && call.expression.text === name;

/** `<client>.<model>.<method>(...)`, by the last two property names. */
const delegateCall = (model: string, methods: string[]) => (call: ts.CallExpression) => {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const receiver = call.expression.expression;
  return methods.includes(call.expression.name.text)
    && ts.isPropertyAccessExpression(receiver) && receiver.name.text === model;
};

/** A booking write whose own arguments set `status: BookingStatus.PAID`. */
function setsPaid(call: ts.CallExpression, source: ts.SourceFile): boolean {
  return delegateCall("booking", ["update", "updateMany"])(call)
    && call.arguments.some((arg) => /\bstatus\s*:\s*BookingStatus\.PAID\b/.test(arg.getText(source)));
}

/** Calls made by `scope` itself (not by a nested closure), in source order. */
function ownCalls(scope: ts.Node): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return found;
}

describe("the one $0 confirmation Payment writer (#5167)", () => {
  it("is called by exactly the two booking creators", () => {
    const callers = productionSourceFiles(ROOT)
      .filter((file) => file !== HELPER_FILE && /\.(ts|tsx)$/.test(file))
      .filter((file) => readFileSync(join(ROOT, file), "utf8").includes(HELPER))
      .filter((file) => calls(parse(file), callsNamed(HELPER)).length > 0)
      .sort();
    expect(callers).toEqual([...CREATORS].sort());
  }, CENSUS_TIMEOUT_MS);

  it.each(CREATORS)("%s writes no zero-amount Payment row inline", (file) => {
    const source = parse(file);
    const inline = calls(source, delegateCall("payment", ["create", "upsert"]))
      .filter((call) => call.arguments.some((arg) => /\bamountCents\s*:\s*0\b/.test(arg.getText(source))))
      .map((call) => `${file}:${source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1}`);
    expect(inline).toEqual([]);
  });

  it.each(CREATORS)("%s writes the row, then PAID, then the confirmation lines, in one function", (file) => {
    const source = parse(file);
    const sites = calls(source, callsNamed(HELPER));
    expect(sites).toHaveLength(1);
    const [site] = sites;
    if (!site) throw new Error(`${file}: no ${HELPER} call`);
    const scope = enclosingFunction(site);
    expect(callsInOwnBody(scope, HELPER)).toBe(1);

    const own = ownCalls(scope);
    const helperAt = own.indexOf(site);
    const paidAt = own.findIndex((call, index) => index > helperAt && setsPaid(call, source));
    const linesAt = own.findIndex((call, index) => index > paidAt && callsNamed("postStoredBookingConfirmationLedgerLines")(call));
    expect(helperAt).toBeGreaterThanOrEqual(0);
    expect(paidAt, `${file}: no PAID booking write after ${HELPER}`).toBeGreaterThan(helperAt);
    expect(linesAt, `${file}: no confirmation lines after the PAID write`).toBeGreaterThan(paidAt);
  });

  it("writes a $0 SUCCEEDED row that mirrors the applied credit", async () => {
    const created: unknown[] = [];
    const tx = { payment: { create: async (args: unknown) => void created.push(args) } } as unknown as Prisma.TransactionClient;
    await createZeroPriceConfirmationPayment(tx, { bookingId: "booking-1", creditAppliedCents: 4_250 });
    expect(created).toEqual([
      { data: { bookingId: "booking-1", amountCents: 0, creditAppliedCents: 4_250, status: PaymentStatus.SUCCEEDED } },
    ]);
  });
});
