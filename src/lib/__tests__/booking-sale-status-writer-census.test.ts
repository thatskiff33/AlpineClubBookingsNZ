/**
 * #4628 (Ledger M3c): EVERY WRITER THAT SETS A BOOKING PAID OR CANCELLED IS
 * CLASSIFIED. A PAID is a booking's confirmation and a CANCELLED is its
 * cancellation: each either posts its member-money journal event (R01 or the
 * confirmation bridge, R04) or is not a sale. This census reads every non-test
 * source file under `src/` and `scripts/` and finds each Prisma write to a
 * booking (`<client>.booking.create|createMany|update|updateMany|upsert`) that
 * sets `status` to PAID or CANCELLED, sets it to anything computed, or hands
 * over a payload or spread it cannot read. Each must be listed below, by file,
 * value and count; a new one fails until someone decides which it is. A raw
 * SQL `UPDATE "Booking"` that sets the status is refused outright.
 *
 * `POSTS` names the posting call the file makes, and the census checks the
 * file still makes it. `LEGACY_GAP` is a sale whose writer posts no legacy
 * confirmation line, so no journal event either: the booking-ledger back-post
 * confirms it later and posts its R01 (M3b), and the gap is reported, not
 * fixed here. Seeds under `prisma/` are fixtures, not doors, and are not read.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { RELEASE_ADMIN_CAPACITY_HOLD_UPDATE, RELEASE_WHOLE_LODGE_HOLD_UPDATE } from "@/lib/booking-status";
import { productionSourceFiles } from "./support/prisma-delegate-read-scan";
import { stripComments } from "./support/strip-comments";

const ROOT = process.cwd();
const WRITE_METHODS = new Set(["create", "createMany", "update", "updateMany", "upsert"]);
const SALE_STATUSES = new Set(["PAID", "CANCELLED"]);

type Classification =
  | { kind: "POSTS"; call: string; why: string }
  | { kind: "NOT_A_SALE"; why: string }
  | { kind: "LEGACY_GAP"; why: string }
  | { kind: "NO_SALE_STATUS"; why: string };

/** A site, as `file|value|count`: value is PAID, CANCELLED, `computed:<expr>`, `payload:<expr>` or `spread:<expr>`. */
const REVIEWED: Record<string, Classification> = {
  // --- PAID: a confirmation ---
  "src/lib/payment-reconciliation.ts|PAID|1": { kind: "POSTS", call: "postBookingConfirmationLedgerLines", why: "the settle: R01, or the bridge to a binding R01" },
  "src/lib/xero-inbound/invoice-paid-effects.ts|PAID|1": { kind: "POSTS", call: "postStoredBookingConfirmationLedgerLines", why: "the Xero receipt confirms the booking and links its binding R01 (#4628)" },
  "src/lib/school-booking-request.ts|PAID|1": { kind: "POSTS", call: "postStoredBookingConfirmationLedgerLines", why: "a credit-settled request approval" },
  "src/lib/group-settlement.ts|PAID|1": { kind: "POSTS", call: "postGroupSettlementLedgerLines", why: "a group settle confirms each organiser-settled child" },
  "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts|PAID|1": { kind: "NOT_A_SALE", why: "only a $0 booking (savedCardChargeCents 0): nothing to charge" },
  "src/app/api/bookings/[id]/confirm-draft/route.ts|PAID|1": { kind: "NOT_A_SALE", why: "only a $0 draft (finalPriceCents 0)" },
  "src/app/api/bookings/[id]/waitlist-confirm/route.ts|PAID|1": { kind: "NOT_A_SALE", why: "only a $0 offer (finalPriceCents 0)" },
  "src/lib/cron-confirm-pending.ts|PAID|1": { kind: "NOT_A_SALE", why: "only a $0 provisional booking (savedCardChargeCents 0)" },
  "src/lib/booking-create.ts|PAID|1": { kind: "LEGACY_GAP", why: "a create whose price account credit covers posts no confirmation line (back-post)" },
  "src/lib/booking-credit-election.ts|PAID|1": { kind: "LEGACY_GAP", why: "a fully credit-covered settle posts no confirmation line (back-post)" },
  // --- CANCELLED: a cancellation ---
  "src/lib/booking-cancel.ts|CANCELLED|5": { kind: "POSTS", call: "postCancellationLedgerLines", why: "every cancel path: R04, pending or confirmed" },
  "src/lib/cron-confirm-pending.ts|CANCELLED|3": { kind: "POSTS", call: "postCancellationLedgerLines", why: "capacity bump and hold-ended cancels" },
  "src/lib/internet-banking-payment-cron.ts|CANCELLED|1": { kind: "POSTS", call: "postCancellationLedgerLines", why: "bank-transfer hold expiry: the pending charge's R04" },
  "src/lib/payment-reconciliation.ts|CANCELLED|1": { kind: "POSTS", call: "postCancellationLedgerLines", why: "the settle's capacity void" },
  "src/lib/xero-inbound/invoice-paid-effects.ts|CANCELLED|1": { kind: "POSTS", call: "postCancellationLedgerLines", why: "a late receipt's capacity cancel" },
  "src/lib/group-cancel.ts|CANCELLED|1": { kind: "POSTS", call: "postGroupCancelChildLedgerLines", why: "group cancel, through the cancellation poster per child" },
  "src/lib/booking-request-quotes.ts|CANCELLED|1": { kind: "NOT_A_SALE", why: "a quote, never bound" },
  "src/lib/cron-quote-expiry-reminders.ts|CANCELLED|2": { kind: "NOT_A_SALE", why: "expired quotes, never bound" },
  "src/lib/cron-waitlist.ts|CANCELLED|1": { kind: "NOT_A_SALE", why: "waitlist entries, which hold no charge" },
  "src/lib/cron-group-settlement-reaper.ts|CANCELLED|1": { kind: "NOT_A_SALE", why: "organiser-settled children whose group never settled: none was bound" },
  "src/lib/waitlist-cross-lodge.ts|CANCELLED|2": { kind: "NOT_A_SALE", why: "an expired offer, and the card-priced replacement undone on price drift" },
  "src/app/api/admin/bookings/[id]/review/route.ts|CANCELLED|1": { kind: "NOT_A_SALE", why: "a rejected legacy draft" },
  // --- computed statuses ---
  "src/lib/booking-date-modification-service.ts|computed:newStatus|2": { kind: "POSTS", call: "postStoredBookingConfirmationLedgerLines", why: "the zero-dollar auto-pay confirms; otherwise PAYMENT_PENDING or unchanged" },
  "src/lib/booking-batch-modification-service.ts|computed:lifecycle.newStatus|1": { kind: "POSTS", call: "postStoredBookingConfirmationLedgerLines", why: "the zero-dollar auto-pay confirms" },
  "src/lib/booking-guest-acceptance-reprice.ts|computed:lifecycle.newStatus|1": { kind: "POSTS", call: "postStoredBookingConfirmationLedgerLines", why: "the zero-dollar auto-pay confirms" },
  "src/lib/booking-guest-removal-service.ts|computed:lifecycle.newStatus|1": { kind: "POSTS", call: "postStoredBookingConfirmationLedgerLines", why: "the zero-dollar auto-pay confirms" },
  "src/app/api/admin/bookings/[id]/force-confirm/route.ts|computed:nextStatus|1": { kind: "NOT_A_SALE", why: "PAID only for a $0 booking; otherwise AWAITING_REVIEW or PAYMENT_PENDING" },
  "src/app/api/bookings/[id]/guests/route.ts|computed:holdAdjustedStatus|1": { kind: "NO_SALE_STATUS", why: "unchanged, or PENDING to PAYMENT_PENDING" },
  "src/lib/booking-create.ts|computed:draftStatus|1": { kind: "NO_SALE_STATUS", why: "DRAFT or AWAITING_REVIEW" },
  "src/lib/booking-create.ts|computed:effectiveStatus|1": { kind: "NO_SALE_STATUS", why: "AWAITING_REVIEW or the requested PENDING, PAYMENT_PENDING or CONFIRMED" },
  "src/lib/payment-reconciliation.ts|computed:restoredStatus|1": { kind: "NO_SALE_STATUS", why: "a mark-paid reversal restores the unpaid status" },
  "src/lib/waitlist.ts|payload:updateData|1": { kind: "NO_SALE_STATUS", why: "an accepted offer: PENDING or PAYMENT_PENDING" },
  // --- spreads of a value the scan cannot read: none carries a status ---
  "src/app/api/admin/bookings/[id]/force-confirm/route.ts|spread:reviewBackfill|1": { kind: "NO_SALE_STATUS", why: "admin-review fields" },
  "src/app/api/bookings/[id]/guests/route.ts|spread:reviewFieldUpdates|1": { kind: "NO_SALE_STATUS", why: "admin-review fields" },
  "src/lib/school-booking-request.ts|spread:exclusiveHoldData|3": { kind: "NO_SALE_STATUS", why: "whole-lodge hold fields" },
};

/** Spreads of an imported constant, checked here to hold no `status` at all. */
const STATUS_FREE_CONSTANTS: Record<string, object> = {
  RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
  RELEASE_WHOLE_LODGE_HOLD_UPDATE,
};

const unwrap = (node: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) ? unwrap(node.expression) : node);

/** The BookingStatus a literal names (`BookingStatus.PAID`, `"PAID"`), or null for anything computed. */
function literalStatus(node: ts.Expression): string | null {
  const value = unwrap(node);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "BookingStatus") return value.name.text;
  return null;
}

/** The sites one data object yields: its `status`, and those of every object a conditional spread may add. */
function objectSites(object: ts.ObjectLiteralExpression, source: ts.SourceFile): string[] {
  const sites: string[] = [];
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText(source) === "status") {
      const status = literalStatus(property.initializer);
      if (status === null) sites.push(`computed:${property.initializer.getText(source)}`);
      else if (SALE_STATUSES.has(status)) sites.push(status);
    } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === "status") {
      sites.push("computed:status");
    } else if (ts.isSpreadAssignment(property)) {
      sites.push(...spreadSites(property.expression, source));
    }
  }
  return sites;
}

function spreadSites(node: ts.Expression, source: ts.SourceFile): string[] {
  const value = unwrap(node);
  if (ts.isObjectLiteralExpression(value)) return objectSites(value, source);
  if (ts.isConditionalExpression(value)) return [...spreadSites(value.whenTrue, source), ...spreadSites(value.whenFalse, source)];
  if (ts.isBinaryExpression(value) && (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    || value.operatorToken.kind === ts.SyntaxKind.BarBarToken || value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return spreadSites(value.right, source);
  }
  if (ts.isIdentifier(value) && value.text in STATUS_FREE_CONSTANTS) return [];
  return [`spread:${value.getText(source)}`];
}

/** A write's payload: an object literal, or a conditional choosing between payloads, read through; anything else opaque. */
function payloadSites(node: ts.Expression, source: ts.SourceFile): string[] {
  const value = unwrap(node);
  if (ts.isObjectLiteralExpression(value)) return objectSites(value, source);
  if (ts.isConditionalExpression(value)) return [...payloadSites(value.whenTrue, source), ...payloadSites(value.whenFalse, source)];
  return [`payload:${value.getText(source)}`];
}

/** Every classified site in one file's source, as `value` strings (one per occurrence). */
function bookingSaleStatusSites(text: string, file: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const sites: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && WRITE_METHODS.has(node.expression.name.text)) {
      const delegate = unwrap(node.expression.expression);
      const isBooking = (ts.isPropertyAccessExpression(delegate) && delegate.name.text === "booking")
        || (ts.isElementAccessExpression(delegate) && ts.isStringLiteralLike(delegate.argumentExpression) && delegate.argumentExpression.text === "booking");
      if (isBooking) {
        const [argument] = node.arguments;
        if (!argument || !ts.isObjectLiteralExpression(unwrap(argument))) {
          sites.push(`payload:${argument ? argument.getText(source) : "none"}`);
        } else {
          for (const property of (unwrap(argument) as ts.ObjectLiteralExpression).properties) {
            if (!ts.isPropertyAssignment(property) || !["data", "create", "update"].includes(property.name.getText(source))) continue;
            const payloads = ts.isArrayLiteralExpression(unwrap(property.initializer))
              ? (unwrap(property.initializer) as ts.ArrayLiteralExpression).elements
              : [property.initializer];
            for (const payload of payloads) sites.push(...payloadSites(payload, source));
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

/** A raw `UPDATE "Booking"` that sets the status, which no classification can admit. */
const RAW_STATUS_UPDATE = /\bUPDATE\s+(?:ONLY\s+)?(?:"?public"?\.)?"Booking"\s+(?:AS\s+\w+\s+)?SET\b[^;`]*?"status"\s*=/i;

const scanned = productionSourceFiles(ROOT).filter((file) => !file.startsWith("prisma/"));

function census(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of scanned) {
    const text = readFileSync(join(ROOT, file), "utf8");
    if (!/\bbooking\b/.test(text)) continue;
    for (const site of bookingSaleStatusSites(text, file)) found[`${file}|${site}`] = (found[`${file}|${site}`] ?? 0) + 1;
  }
  return found;
}

describe("every booking PAID/CANCELLED writer is classified (#4628)", () => {
  const found = census();

  it("finds exactly the reviewed writers, by file, value and count", () => {
    const actual = Object.entries(found).map(([site, count]) => `${site}|${count}`).sort();
    expect(actual, "a writer that sets a booking PAID or CANCELLED (or a status the scan cannot read) is unclassified").toEqual(Object.keys(REVIEWED).sort());
  });

  it("holds each POSTS writer to the posting call it names", () => {
    for (const [site, classification] of Object.entries(REVIEWED)) {
      if (classification.kind !== "POSTS") continue;
      const file = site.split("|")[0]!;
      expect(stripComments(readFileSync(join(ROOT, file), "utf8")), `${file} no longer calls ${classification.call}`).toMatch(new RegExp(`\\b${classification.call}\\(`));
    }
  });

  it("refuses a raw SQL status write to a booking", () => {
    const offenders = scanned.filter((file) => RAW_STATUS_UPDATE.test(stripComments(readFileSync(join(ROOT, file), "utf8"))));
    expect(offenders).toEqual([]);
    expect('await tx.$executeRaw`UPDATE "Booking" SET "status" = \'CANCELLED\' WHERE id = ${id}`').toMatch(RAW_STATUS_UPDATE);
    expect('await tx.$executeRaw`UPDATE "Booking" SET "deletedAt" = now() WHERE id = ${id}`').not.toMatch(RAW_STATUS_UPDATE);
  });

  it("checks the status-free constants it lets a spread name", () => {
    for (const [name, value] of Object.entries(STATUS_FREE_CONSTANTS)) expect(Object.keys(value), name).not.toContain("status");
  });

  it("sees every form a status write can take (fixture proof)", () => {
    const sites = (code: string) => bookingSaleStatusSites(code, "fixture.ts");
    expect(sites("await tx.booking.update({ where, data: { status: BookingStatus.PAID } });")).toEqual(["PAID"]);
    expect(sites('await prisma.booking.updateMany({ where, data: { status: "CANCELLED", x: 1 } });')).toEqual(["CANCELLED"]);
    expect(sites("await db.booking.create({ data: { status: BookingStatus.CONFIRMED } });")).toEqual([]);
    expect(sites("await tx.booking.update({ where, data: { status: next } });")).toEqual(["computed:next"]);
    expect(sites("await tx.booking.update({ where, data: { ...(legacy ? { status: BookingStatus.CANCELLED } : {}) } });")).toEqual(["CANCELLED"]);
    expect(sites("await tx.booking.update({ where, data: { ...(ok && { status: BookingStatus.PAID }) } });")).toEqual(["PAID"]);
    expect(sites("await tx.booking.update({ where, data: { ...extra } });")).toEqual(["spread:extra"]);
    expect(sites("await tx.booking.update({ where, data: { ...RELEASE_WHOLE_LODGE_HOLD_UPDATE } });")).toEqual([]);
    expect(sites("await tx.booking.updateMany({ where, data: payload });")).toEqual(["payload:payload"]);
    expect(sites("await tx.booking.update({ where, data: on ? { flag: true } : { status: BookingStatus.CANCELLED } });")).toEqual(["CANCELLED"]);
    expect(sites("await tx.booking.upsert({ where, create: { status: BookingStatus.PAID }, update: { status } });")).toEqual(["PAID", "computed:status"]);
    expect(sites('await tx["booking"].update({ where, data: { status: BookingStatus.PAID } });')).toEqual(["PAID"]);
    expect(sites("await tx.booking.findMany({ where: { status: BookingStatus.PAID } });")).toEqual([]);
    expect(sites("await tx.booking.updateMany({ where: { status: BookingStatus.PAID }, data: { notes: null } });")).toEqual([]);
  });
});
