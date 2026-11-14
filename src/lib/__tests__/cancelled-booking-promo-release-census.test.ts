/**
 * Every transaction that moves a booking to CANCELLED gives back its promo uses
 * in that same transaction (#4909, `INV-MONEY-005` corollary (c)).
 *
 * The census finds each `*.booking.create/update/updateMany/upsert` whose data
 * sets `status` to CANCELLED (enum or string form) and requires, in the block
 * that write sits in, a later call to the one release in `promo.ts`. A writer
 * whose booking can never carry a code is listed in `NO_PROMO` with the reason.
 * It also pins the lock order the release joins (`INV-LOCK-002`): the promo
 * rows come after every advisory key the transaction takes, so no lock call may
 * follow the release in the same function.
 *
 * `scripts/` and `prisma/` are not scanned: their only CANCELLED writes are
 * demo-seed fixtures created already cancelled, never a transition.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { productionSourceFiles } from "./support/prisma-delegate-read-scan";

// Keyed by file and the writer's ordinal within it, so a new writer in an
// exempt file still needs its own classification.
const NO_PROMO: Record<string, string> = {
  "src/lib/cron-confirm-pending.ts:3": "Split non-member guest children carry no promotion; booking-create attaches codes only to the parent.",
  "src/lib/cron-quote-expiry-reminders.ts:1": "Officer-priced quote holds never apply a promo code.",
  "src/lib/cron-quote-expiry-reminders.ts:2": "Officer-priced quote holds never apply a promo code.",
  "src/lib/booking-request-quotes.ts:1": "Officer-priced quote holds never apply a promo code.",
  "src/lib/cron-group-settlement-reaper.ts:1": "Organiser-settled PAYMENT_PENDING children are created without promotions by group-booking-join.",
  "src/lib/waitlist-cross-lodge.ts:1": "Replacement creation passes no code; promo-bearing entries are refused before cross-lodge confirmation.",
  "src/lib/waitlist-cross-lodge.ts:2": "Promo-bearing entries are refused before cross-lodge confirmation.",
};

const RELEASES = new Set(["releaseBookingPromoRedemptions", "releasePromoRedemptions"]);
// booking-cancel.ts probes for a code before releasing; it counts only when its
// own body releases and it is handed the claim's `tx`.
const RELEASE_WRAPPERS = new Set(["cleanupPromoRedemption"]);
const LOCK_CALLS = new Set(["acquireLodgeCapacityLock", "lockMemberCreditLedger", "lockMemberCreditLedgers"]);
const WRITE_METHODS = new Set(["create", "createMany", "update", "updateMany", "upsert"]);

interface Site {
  key: string;
  line: number;
  releases: boolean;
  /** Lock calls written after the release in the same function (lock-order breach). */
  locksAfterRelease: string[];
}

function propertyNamed(node: ts.Node, name: string): node is ts.PropertyAssignment {
  return ts.isPropertyAssignment(node) && node.name.getText().replace(/["']/g, "") === name;
}

function calleeName(node: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return undefined;
}

/** Calls inside `root`, not descending into nested functions (callbacks run elsewhere). */
function callsWithin(root: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (node !== root && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return calls;
}

function isRelease(call: ts.CallExpression, source: ts.SourceFile): boolean {
  const name = calleeName(call);
  if (!name || !ts.isIdentifier(call.expression)) return false;
  if (RELEASES.has(name)) return true;
  if (!RELEASE_WRAPPERS.has(name) || call.arguments[0]?.getText() !== "tx") return false;
  const helper = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  return !!helper?.body && callsWithin(helper.body).some((inner) => isRelease(inner, source));
}

/** Advisory-lock acquisitions inside `root` after `after`, by name (nested functions skipped). */
function locksAfter(root: ts.Node, after: number): string[] {
  const locks: string[] = [];
  const visit = (node: ts.Node) => {
    if (node !== root && ts.isFunctionLike(node)) return;
    if (node.getStart() > after) {
      if (ts.isCallExpression(node) && LOCK_CALLS.has(calleeName(node) ?? "")) locks.push(calleeName(node)!);
      // `tx.$executeRaw\`SELECT pg_advisory_xact_lock(...)\`` is a tagged template, not a call.
      if (ts.isTaggedTemplateExpression(node) && node.template.getText().includes("pg_advisory")) locks.push("pg_advisory_xact_lock");
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return locks;
}

function setsCancelled(value: ts.Node): boolean {
  if (propertyNamed(value, "status")) {
    const init = value.initializer;
    if (init.getText() === "BookingStatus.CANCELLED" || (ts.isStringLiteral(init) && init.text === "CANCELLED")) return true;
  }
  return ts.forEachChild(value, (child) => setsCancelled(child) || undefined) === true;
}

function scan(text: string, file: string): Site[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sites: Site[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && WRITE_METHODS.has(node.expression.name.text)
      && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === "booking"
    ) {
      // Only data/create/update payloads, never `where` filters.
      const args = node.arguments[0];
      if (args && ts.isObjectLiteralExpression(args) && args.properties.some(
        (p) => (propertyNamed(p, "data") || propertyNamed(p, "create") || propertyNamed(p, "update")) && setsCancelled(p.initializer),
      )) {
        let block: ts.Node | undefined = node.parent;
        while (block && !ts.isBlock(block)) block = block.parent;
        let fn: ts.Node | undefined = node.parent;
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
        // A release only counts once the guarded write has run: a release
        // before it would give back uses on a claim that may then be lost.
        const release = block ? callsWithin(block).find((call) => call.getStart() > node.getStart() && isRelease(call, source)) : undefined;
        const locksAfterRelease = release && fn ? locksAfter(fn, release.getStart()) : [];
        sites.push({
          key: `${file}:${sites.length + 1}`,
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          releases: !!release,
          locksAfterRelease,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

describe("CANCELLED booking writers release promotions atomically (#4909)", () => {
  const sites = productionSourceFiles(process.cwd())
    .filter((file) => file.startsWith("src/"))
    .flatMap((file) => scan(readFileSync(file, "utf8"), file));

  it("classifies every cancellation, without accepting a release in a sibling branch or post-commit callback", () => {
    expect(sites.length).toBeGreaterThan(15);
    expect(sites.filter((site) => !site.releases && !NO_PROMO[site.key])).toEqual([]);
    // A stale exemption (the writer moved, or now releases) must be removed.
    expect(Object.keys(NO_PROMO).filter((key) => !sites.some((site) => site.key === key && !site.releases))).toEqual([]);
  });

  it("takes the promo rows after every advisory key the cancel transaction holds", () => {
    expect(sites.filter((site) => site.locksAfterRelease.length > 0)).toEqual([]);
  });

  it("ignores reads and other models, and detects both enum and string writes", () => {
    expect(scan(`tx.booking.findMany({where: {status: "CANCELLED"}}); tx.groupBooking.update({data: {status: "CANCELLED"}});`, "test.ts")).toEqual([]);
    for (const status of ['"CANCELLED"', "BookingStatus.CANCELLED"]) {
      const text = `async function cancel(tx) { await tx.booking.updateMany({data: {status: ${status}}}); await releaseBookingPromoRedemptions(tx, id); }`;
      expect(scan(text, "test.ts")[0]?.releases).toBe(true);
      expect(scan(text.replace("await releaseBookingPromoRedemptions(tx, id);", ""), "test.ts")[0]?.releases).toBe(false);
      expect(scan(`async function cancel(tx) { if (a) { tx.booking.updateMany({data: {status: ${status}}}); } else { releaseBookingPromoRedemptions(tx, id); } }`, "test.ts")[0]?.releases).toBe(false);
    }
  });

  it("rejects a release before the claim, one in a post-commit callback, and a lock taken after the release", () => {
    const write = `await tx.booking.updateMany({data: {status: "CANCELLED"}});`;
    expect(scan(`async function c(tx) { await releaseBookingPromoRedemptions(tx, id); ${write} }`, "t.ts")[0]?.releases).toBe(false);
    expect(scan(`async function c(tx) { ${write} after(() => releaseBookingPromoRedemptions(tx, id)); }`, "t.ts")[0]?.releases).toBe(false);
    expect(scan(`async function c(tx) { ${write} await releaseBookingPromoRedemptions(tx, id); await lockMemberCreditLedger(m, tx); }`, "t.ts")[0]?.locksAfterRelease)
      .toEqual(["lockMemberCreditLedger"]);
    expect(scan(`async function c(tx) { ${write} await releaseBookingPromoRedemptions(tx, id); await tx.$executeRaw\`SELECT pg_advisory_xact_lock(1)\`; }`, "t.ts")[0]?.locksAfterRelease)
      .toEqual(["pg_advisory_xact_lock"]);
    expect(scan(`async function c(tx) { await acquireLodgeCapacityLock(tx, l); ${write} await releaseBookingPromoRedemptions(tx, id); }`, "t.ts")[0]?.locksAfterRelease)
      .toEqual([]);
  });
});
