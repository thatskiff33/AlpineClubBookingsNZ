import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// `INV-SSOT-004`: the one comment/string stripper in the tree.
import { stripCommentsAndStrings } from "@/lib/__tests__/support/strip-comments";

/**
 * #3599 (programme #3527, `INV-MONEY-035`): EVERY CREDIT ROW A BOOKING OWNS
 * REACHES THE LEDGER, AND NO CREDIT ROW IS EVER REWRITTEN IN MONEY TERMS.
 *
 * Credit rows have no chokepoint — #3581's payment rows converge in
 * `reconcilePaymentAggregates`, but `MemberCredit` is written from ten places
 * in three modules. So "every writer calls the sync" is not a sentence in a
 * docblock; it is this census, which reads the tree:
 *
 *  1. **Every `memberCredit.create` / `createMany` is followed by
 *     `syncBookingLedgerCredits`** before the next credit write — except a row
 *     of `ADMIN_ADJUSTMENT`, which names no booking and so has no booking leg.
 *  2. **No `memberCredit.update` / `updateMany` changes a row's money or its
 *     booking link** (its member can change — a merge re-points it in raw SQL
 *     — but the booking's leg does not depend on whose account it is), and nothing upserts or deletes one. That is what makes
 *     the credit lines insert-only: a row posts one line keyed by its id, and
 *     a line is never reversed, because its row never changes. A writer that
 *     rewrote `amountCents` would leave the posted line wrong forever.
 *
 * Source is read with comments and strings stripped, so neither rule can be
 * satisfied — or tripped — by prose.
 */

const REPO_ROOT = resolve(__dirname, "../../..");

/** How far past a credit write its sync may sit: the replay branch of the reduction writer is the longest gap. */
const SYNC_WINDOW_CHARS = 2_500;

/**
 * Fields whose change would make a posted credit line disagree with its row,
 * as a key OR a shorthand property (`{ amountCents, description }`). The member
 * is deliberately absent: a merge re-points it (in raw SQL through a dynamic
 * delegate, `member-merge-relations.ts`), and the booking's leg does not
 * depend on whose account the credit sits in.
 */
const MONEY_FIELDS =
  /\b(?:amountCents|type|appliedToBookingId|appliedToBooking|sourceBookingId|sourceBooking|sourceBookingModificationId|sourceBookingModification|restoredFromBookingId|restoredFromBooking)\b\s*[:,}]/;

/**
 * `.memberCredit` taken as a bare VALUE — `const credits = tx.memberCredit;` —
 * hides every write made through the alias. Followed by `.` or `?.` it is a
 * call on the delegate or a relation field read (`slice.memberCredit?.memberId`).
 */
const CALLED_OR_READ = /^\s*\??\./;

/** A nested write through a relation that holds credit rows (`schema.prisma`: Member, Booking, BookingModification). */
const NESTED_WRITE =
  /\b(?:credits|creditsFromCancellation|creditsApplied|creditsFromModification|requestedCreditAdjustments|approvedCreditAdjustments)\s*:\s*\{\s*(?:create|createMany|connect|connectOrCreate|set|disconnect|update|updateMany|upsert|delete|deleteMany)\b/;

/** Raw SQL writing the table, read from the UNSTRIPPED source (the stripper blanks template literals). */
const RAW_SQL_WRITE = /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?"MemberCredit"/i;

/** The delegate reached by a string key, which the stripper would blank. */
const BRACKET_DELEGATE = /\[\s*["'`]memberCredit["'`]\s*\]/;

/** Only a literal, unconditional admin adjustment is exempt: it names no booking. */
const ADMIN_ADJUSTMENT_ONLY = /\btype\s*:\s*CreditType\s*\.\s*ADMIN_ADJUSTMENT\b/;

/**
 * Files that write credit rows and are NOT production writers, each with why.
 * The demo seed's rows are posted by C4's back-post (#3583), which walks
 * history the same way for every row.
 */
const NOT_PRODUCTION = new Map<string, string>([
  ["prisma/demo-seed.ts", "demo data; posted by the #3583 back-post like any historical row"],
]);

/**
 * An update whose payload is a variable, not a literal, cannot be read by a
 * scan; each is listed with the declared type that bounds it.
 */
const VARIABLE_PAYLOADS: ReadonlyArray<{ file: string; name: string; why: string }> = [
  {
    file: "src/lib/xero-inbound/credit-note-repairs.ts",
    name: "updates",
    why: "declared `{ description?: string }` beside the call",
  },
];

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "migrations") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      found.push(full);
    }
  };
  walk(join(REPO_ROOT, "src"));
  walk(join(REPO_ROOT, "scripts"));
  walk(join(REPO_ROOT, "prisma"));
  return found;
}

/** The index just past the bracket that closes the one opened at `open`. */
function closeOf(code: string, open: number, [l, r]: readonly [string, string]): number {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === l) depth += 1;
    else if (code[i] === r) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return code.length;
}

type Finding = { file: string; problem: string };

const CREATE = /\bmemberCredit\s*\.\s*(?:create|createMany|createManyAndReturn)\s*\(/g;
const MUTATE = /\bmemberCredit\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\s*\(/g;

/**
 * STATED LIMIT: the window after a create is bounded by characters and by the
 * next credit write, not by control flow, so a create that returns early and a
 * sync (for the same booking) that only the other branch reaches would pass.
 * No writer has that shape; the real-Postgres suite and each writer's unit
 * test hold the handoff itself.
 */
function auditCreditWriters(file: string, source: string): Finding[] {
  const code = stripCommentsAndStrings(source);
  const findings: Finding[] = [];

  if (RAW_SQL_WRITE.test(source)) findings.push({ file, problem: "raw SQL writes MemberCredit, which no census can follow" });
  if (BRACKET_DELEGATE.test(source)) findings.push({ file, problem: "the memberCredit delegate is reached by a string key" });
  if (NESTED_WRITE.test(code)) findings.push({ file, problem: "a nested relation write creates or re-links credit rows" });
  for (const match of code.matchAll(/\.\s*memberCredit\b/g)) {
    const rest = code.slice(match.index + match[0].length);
    if (!CALLED_OR_READ.test(rest)) {
      findings.push({ file, problem: "the memberCredit delegate is taken as a value (an alias hides its writes)" });
    }
  }

  const creates = [...code.matchAll(CREATE)];
  creates.forEach((match, n) => {
    const open = match.index + match[0].length - 1;
    const end = closeOf(code, open, ["(", ")"]);
    const payload = code.slice(open, end);
    if (ADMIN_ADJUSTMENT_ONLY.test(payload) && !payload.includes("?")) return;
    const next = creates[n + 1]?.index ?? code.length;
    const after = code.slice(end, Math.min(next, end + SYNC_WINDOW_CHARS));
    if (!/\bsyncBookingLedgerCredits\s*\(/.test(after)) {
      findings.push({ file, problem: "a credit row is written with no syncBookingLedgerCredits after it" });
    }
  });

  for (const match of code.matchAll(MUTATE)) {
    const verb = match[1];
    if (verb !== "update" && verb !== "updateMany") {
      findings.push({ file, problem: `memberCredit.${verb} — a credit row is never replaced or removed` });
      continue;
    }
    const open = match.index + match[0].length - 1;
    const call = code.slice(open, closeOf(code, open, ["(", ")"]));
    const data = /\bdata\s*:\s*/.exec(call);
    if (!data) continue;
    const start = data.index + data[0].length;
    if (call[start] === "{") {
      const payload = call.slice(start, closeOf(call, start, ["{", "}"]));
      if (MONEY_FIELDS.test(payload) || payload.includes("...")) {
        findings.push({ file, problem: `memberCredit.${verb} rewrites, or may rewrite, a row's money or booking link` });
      }
      continue;
    }
    const name = /^[A-Za-z_$][\w$]*/.exec(call.slice(start))?.[0] ?? "";
    if (!VARIABLE_PAYLOADS.some((allowed) => allowed.file === file && allowed.name === name)) {
      findings.push({ file, problem: `memberCredit.${verb} with a payload (${name || "expression"}) this census cannot read` });
    }
  }
  return findings;
}

let cached: { findings: Finding[]; creates: number; syncedFiles: Set<string> } | null = null;

function scan() {
  if (cached) return cached;
  const findings: Finding[] = [];
  let creates = 0;
  const syncedFiles = new Set<string>();
  for (const full of sourceFiles()) {
    const source = readFileSync(full, "utf8");
    if (!/memberCredit/.test(source)) continue;
    const file = relative(REPO_ROOT, full).split("\\").join("/");
    if (NOT_PRODUCTION.has(file)) continue;
    const code = stripCommentsAndStrings(source);
    creates += [...code.matchAll(CREATE)].length;
    if (/\bsyncBookingLedgerCredits\s*\(/.test(code)) syncedFiles.add(file);
    findings.push(...auditCreditWriters(file, source));
  }
  cached = { findings, creates, syncedFiles };
  return cached;
}

describe("every booking credit row reaches the ledger, and none is rewritten (#3599, INV-MONEY-035)", () => {
  it("follows every credit-row write with the ledger sync, and rewrites no row's money", () => {
    expect(scan().findings).toEqual([]);
  });

  it("sees the writers it guards, so it cannot pass by seeing nothing", () => {
    const { creates, syncedFiles } = scan();
    // Ten writes across three modules when this was written (nine
    // booking-linked plus the admin adjustment). Fewer means the pattern stopped matching.
    expect(creates).toBeGreaterThanOrEqual(10);
    expect([...syncedFiles].sort()).toEqual(
      expect.arrayContaining([
        "src/lib/member-credit.ts",
        "src/lib/xero-inbound/credit-note-repairs.ts",
        "src/lib/xero-inbound/invoice-paid-effects.ts",
      ]),
    );
  });

  it("FAILS on a write with no sync, a money rewrite, an upsert and an unreadable payload (fixture proof)", () => {
    const f = "fixture.ts";
    expect(auditCreditWriters(f, "await tx.memberCredit.create({ data: { amountCents: 5, type: CreditType.BOOKING_APPLIED } });")).toHaveLength(1);
    expect(
      auditCreditWriters(
        f,
        "await tx.memberCredit.create({ data }); await syncBookingLedgerCredits({ bookingId, store: tx });",
      ),
    ).toEqual([]);
    // Only the SECOND write lacks a sync: the first's is found before it.
    expect(
      auditCreditWriters(
        f,
        "await tx.memberCredit.create({ data }); await syncBookingLedgerCredits({ bookingId, store: tx }); await tx.memberCredit.create({ data });",
      ),
    ).toHaveLength(1);
    expect(auditCreditWriters(f, "await tx.memberCredit.create({ data: { type: CreditType.ADMIN_ADJUSTMENT } });")).toEqual([]);
    expect(auditCreditWriters(f, "await tx.memberCredit.update({ where, data: { amountCents: 10 } });")).toHaveLength(1);
    expect(auditCreditWriters(f, "await tx.memberCredit.updateMany({ where, data: { appliedToBookingId: b } });")).toHaveLength(1);
    expect(auditCreditWriters(f, "await tx.memberCredit.update({ where: { amountCents: 1 }, data: { description: d } });")).toEqual([]);
    expect(auditCreditWriters(f, "await tx.memberCredit.upsert({ where, create, update });")).toHaveLength(1);
    expect(auditCreditWriters(f, "await tx.memberCredit.update({ where, data: patch });")).toHaveLength(1);
    // Review of #3609: each of these passed the first cut.
    expect(auditCreditWriters(f, "await tx.memberCredit.update({ where, data: { amountCents, description } });")).toHaveLength(1);
    expect(auditCreditWriters(f, "await tx.memberCredit.update({ where, data: { ...patch, description: d } });")).toHaveLength(1);
    expect(auditCreditWriters(f, "const credits = tx.memberCredit; await credits.create({ data });")).not.toEqual([]);
    expect(auditCreditWriters(f, 'await tx["memberCredit"].create({ data });')).not.toEqual([]);
    expect(auditCreditWriters(f, "await tx.booking.update({ where, data: { creditsApplied: { create: { amountCents: -5 } } } });")).toHaveLength(1);
    expect(auditCreditWriters(f, "await tx.booking.update({ where, data: { creditsApplied: { set: [] } } });")).toHaveLength(1);
    expect(auditCreditWriters(f, 'await tx.$executeRaw`UPDATE "MemberCredit" SET "amountCents" = 0`;')).toHaveLength(1);
    expect(auditCreditWriters(f, 'await tx.$executeRaw`INSERT INTO "MemberCredit" ("id") VALUES (1)`;')).toHaveLength(1);
    expect(
      auditCreditWriters(f, "await tx.memberCredit.create({ data: { type: admin ? CreditType.ADMIN_ADJUSTMENT : CreditType.CANCELLATION_REFUND } });"),
    ).toHaveLength(1);
    // Reads stay legal, and a table whose name merely STARTS with the model's is not it.
    expect(auditCreditWriters(f, 'await tx.memberCredit.findMany({ where }); await tx.$executeRaw`UPDATE "MemberCreditNoteAllocation" SET x = 1`;')).toEqual([]);
  });
});
