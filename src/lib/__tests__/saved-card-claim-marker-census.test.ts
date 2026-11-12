import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { relativeSource, sourceFiles } from "./support/booking-guest-night-writer-scan";

/*
 * #4993 (`INV-PAY-151`): every saved-card PENDING -> CONFIRMED claim stamps
 * `Booking.savedCardClaimAt` in the same guarded write. A claim without it is
 * invisible to `recoverStaleSavedCardClaims`, so an interrupted charge would
 * hold its beds CONFIRMED and unpaid with nothing to hand it back.
 *
 * A claimer is any production file that charges through
 * `beginSavedCardChargeAttempt`; every `updateMany` there whose `data` sets the
 * status to CONFIRMED is a claim.
 */
const ATTEMPT_MODULE = "src/lib/saved-card-charge-attempt.ts";
const KNOWN_CLAIMERS = [
  "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts",
  "src/app/api/payments/charge-saved-method/route.ts",
  "src/lib/cron-confirm-pending.ts",
];

function propertyNamed(object: ts.ObjectLiteralExpression, name: string) {
  return object.properties.find(
    (property): property is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name,
  );
}

function setsConfirmed(data: ts.ObjectLiteralExpression) {
  const status = propertyNamed(data, "status");
  if (!status || !ts.isPropertyAssignment(status)) return false;
  const value = status.initializer;
  return (
    (ts.isPropertyAccessExpression(value) && value.name.text === "CONFIRMED") ||
    (ts.isStringLiteral(value) && value.text === "CONFIRMED")
  );
}

/** Each CONFIRMED-setting `updateMany` in `code`, and whether it stamps the marker. */
function confirmedClaims(file: string, code: string) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const claims: { line: number; stampsMarker: boolean }[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "updateMany"
    ) {
      const argument = node.arguments[0];
      const data = argument && ts.isObjectLiteralExpression(argument) ? propertyNamed(argument, "data") : undefined;
      if (data && ts.isPropertyAssignment(data) && ts.isObjectLiteralExpression(data.initializer) && setsConfirmed(data.initializer)) {
        claims.push({
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          stampsMarker: propertyNamed(data.initializer, "savedCardClaimAt") !== undefined,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return claims;
}

function callsBeginAttempt(file: string, code: string) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "beginSavedCardChargeAttempt") {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("INV-PAY-151: every saved-card claim stamps the durable claim marker (#4993)", () => {
  it("detects a CONFIRMED claim without the marker, in either status spelling", () => {
    expect(confirmedClaims("x.ts", `
      await tx.booking.updateMany({ where: { id, status: BookingStatus.PENDING }, data: { status: BookingStatus.CONFIRMED } });
      await tx.booking.updateMany({ where: { id }, data: { status: "CONFIRMED", nonMemberHoldUntil: null } });
    `)).toEqual([
      { line: 2, stampsMarker: false },
      { line: 3, stampsMarker: false },
    ]);
  });

  it("accepts a claim that stamps the marker and ignores other transitions", () => {
    expect(confirmedClaims("x.ts", `
      await tx.booking.updateMany({ where: { id }, data: { status: BookingStatus.CONFIRMED, savedCardClaimAt: now } });
      await tx.booking.updateMany({ where: { id }, data: { status: BookingStatus.PENDING, savedCardClaimAt: null } });
      // data: { status: BookingStatus.CONFIRMED }
    `)).toEqual([{ line: 2, stampsMarker: true }]);
  });

  it("finds every claimer in production source, and each of their claims stamps the marker", () => {
    const claimers = sourceFiles()
      .map((file) => ({ relative: relativeSource(file), code: readFileSync(file, "utf8") }))
      .filter(({ relative }) => relative.startsWith("src/") && relative !== ATTEMPT_MODULE)
      .filter(({ relative, code }) => code.includes("beginSavedCardChargeAttempt") && callsBeginAttempt(relative, code));

    // A new claimer joins this census automatically; a lost one is a broken walk.
    expect(claimers.map(({ relative }) => relative).sort()).toEqual(expect.arrayContaining(KNOWN_CLAIMERS));

    for (const { relative, code } of claimers) {
      const claims = confirmedClaims(relative, code);
      expect(claims.length, `${relative}: no PENDING -> CONFIRMED claim found`).toBeGreaterThan(0);
      for (const claim of claims) {
        expect(claim.stampsMarker, `${relative}:${claim.line} claims CONFIRMED without savedCardClaimAt`).toBe(true);
      }
    }
  });
});
