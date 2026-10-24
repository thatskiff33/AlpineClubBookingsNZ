import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BookingStatus, ManualRefundTaskDirection, ManualRefundTaskKind, ManualRefundTaskStatus, PaymentSource } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { BANK_REFUND_VOID_FOLLOW_UP_KEY_PREFIX, BANK_REFUND_VOID_FOLLOW_UP_TASK_WHERE } from "@/lib/bank-refund-void-follow-up-key";
import {
  CARD_REFUND_PAID_ANOTHER_WAY_KEY_PREFIX,
  NON_CANCELLATION_HAND_BACK_KEY_PREFIXES,
} from "@/lib/manual-refund-task-settlement-rules";
import { EXCLUDED_LEDGER_REFUND_STATUSES } from "@/lib/payment-transaction-status";
import { BANK_TRANSFER_REFUND_SHORTFALL_ADVICE } from "@/lib/xero-inbound/credit-note-bank-transfer-floor";
import { CANCELLED_CREDIT_NOTE_STATUSES, readRefundCreditNoteLinkStatus, REFUND_CREDIT_NOTE_LINK_WHERE } from "@/lib/xero-refund-note-status";
import { recoverRefundCreditNoteLinkAmountCents } from "@/lib/xero-sync";

/**
 * #4230 (`INV-SSOT`, `INV-ADDPAY-021`): the deploy note's read-only SQL, which
 * lists bank-transfer payments whose paid-back refunds exceed their live refund
 * notes, spells by hand what the code defines once - the task kinds and
 * statuses, the hand-backs another note answers, the void follow-up, a refused
 * refund's statuses, a refund note's link and a cancelled note's statuses -
 * because an operator runs it in psql. This pins each literal to the code, so
 * a drift fails here rather than leaving a query that quietly lists nothing.
 * The real-PostgreSQL proof (`xero-bt-recount-handbacks`) runs the same query.
 * It also pins how the writers the doc names enqueue - a refund request's card
 * part still unkeyed, a later cancellation hand-back on its own record (#4287) -
 * and that the Xero guide quotes the alert's advice.
 */
const REPO_ROOT = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), "utf8");

function deployNoteSql(): string {
  const doc = read("docs/xero/ARCHITECTURE.md");
  const start = doc.indexOf("**Deploy note (#4230).**");
  expect(start).toBeGreaterThanOrEqual(0);
  const sql = /```sql\n([\s\S]*?)\n```/.exec(doc.slice(start))?.[1];
  expect(sql).toBeDefined();
  return sql!;
}

const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[1]!);
const list = (text: string) => text.split(", ").map((item) => item.slice(1, -1));

describe("the #4230 deploy note's SQL matches the code's one definition", () => {
  const sql = deployNoteSql();

  it("counts completed hand-backs and a cancelled booking's member refunds by review, by the code's kinds, status and direction", () => {
    expect(new Set(all(sql, /m\.kind = '([^']*)'/g))).toEqual(new Set([ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK, ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW]));
    expect(all(sql, /m\.status = '([^']*)'/g)).toEqual([ManualRefundTaskStatus.COMPLETED]);
    expect(all(sql, /m\."settlementDirection" = '([^']*)'/g)).toEqual([ManualRefundTaskDirection.REFUND_TO_MEMBER]);
    expect(all(sql, /b\.status = '([^']*)'/g)).toEqual([BookingStatus.CANCELLED]);
  });

  it("leaves out exactly the hand-backs another note answers", () => {
    const excluded = all(sql, /NOT starts_with\(coalesce\(m\."occurrenceKey", ''\), '([^']*)'\)/g);
    // Every non-cancellation hand-back but a "Paid another way" close: a close is bank cash
    // answered by its own refund credit note (`paidAnotherWayTaskId`), so it counts beside it.
    // An edit's is answered by the edit's note, a request's by its own note, and a void
    // follow-up re-records the hand-back it undid (counted on its own line below).
    const expected = NON_CANCELLATION_HAND_BACK_KEY_PREFIXES.filter((prefix) => prefix !== CARD_REFUND_PAID_ANOTHER_WAY_KEY_PREFIX);
    expect(excluded).toHaveLength(expected.length);
    expect(new Set(excluded)).toEqual(new Set(expected));
  });

  it("takes back every void follow-up nobody has re-confirmed, read as the code reads a follow-up", () => {
    expect(all(sql, /v\.kind = '([^']*)'/g)).toEqual([BANK_REFUND_VOID_FOLLOW_UP_TASK_WHERE.kind]);
    expect(all(sql, /starts_with\(v\."occurrenceKey", '([^']*)'\)/g)).toEqual([BANK_REFUND_VOID_FOLLOW_UP_KEY_PREFIX]);
    expect(all(sql, /v\.status <> '([^']*)'/g)).toEqual([ManualRefundTaskStatus.COMPLETED]);
  });

  it("counts card refunds as the ledger does, never a refused one", () => {
    const statuses = all(sql, /f\.status NOT IN \(([^)]*)\)/g);
    expect(statuses).toHaveLength(1);
    expect(new Set(list(statuses[0]!))).toEqual(new Set(EXCLUDED_LEDGER_REFUND_STATUSES));
  });

  it("reads live refund notes' amounts by the link filter, field and statuses the code reads", async () => {
    const [link] = [...sql.matchAll(/l\."localModel" = '([^']*)' AND l\."localId" = p\.id AND l\."xeroObjectType" = '([^']*)' AND l\.role = '([^']*)' AND l\.active/g)];
    expect(link).toBeDefined();
    expect({ localModel: link![1], xeroObjectType: link![2], role: link![3] }).toEqual(REFUND_CREDIT_NOTE_LINK_WHERE);
    const cancelled = all(sql, /upper\(trim\(coalesce\(l\.metadata->>'status', ''\)\)\) NOT IN \(([^)]*)\)/g);
    expect(cancelled).toHaveLength(1);
    expect(new Set(list(cancelled[0]!))).toEqual(new Set(CANCELLED_CREDIT_NOTE_STATUSES));
    expect(readRefundCreditNoteLinkStatus({ status: " voided " })).toBe("VOIDED");
    const fields = new Set(all(sql, /l\.metadata->>?'([^']*)'/g).filter((key) => key !== "status"));
    expect(fields.size).toBeGreaterThan(0);
    for (const field of fields) {
      const noRow = { xeroSyncOperation: { findFirst: async () => null } } as never;
      expect(await recoverRefundCreditNoteLinkAmountCents("PAYMENT", { xeroObjectId: "NOTE", metadata: { [field]: 1234 } }, noRow)).toBe(1234);
    }
  });

  it("lists bank-transfer payments only", () => {
    expect(all(sql, /p\.source = '([^']*)'/g)).toEqual([PaymentSource.INTERNET_BANKING]);
  });
});

describe("how the writers the deploy note names enqueue a bank-transfer refund note (#4287)", () => {
  it("a refund request's card part: no keyed option, so the single-note branch absorbs it", () => {
    const route = read("src/app/api/admin/refund-requests/[id]/route.ts");
    expect(route).toMatch(/enqueueXeroRefundCreditNoteOperation\(payment\.id, cardNoteCents, \{\s*createdByMemberId: session\.user\.id,\s*\}\)/);
  });

  it("a cancellation hand-back's completion: a later one is keyed and sized on its own task, never absorbed", () => {
    const leg = read("src/lib/edit-financial-review-xero-leg.ts");
    expect(leg).toContain("const ownRecord = (await cancellationHandBackNotedOnItsOwnRecord(store, route.paymentId, task.id)) ? { paidAnotherWayTaskId: task.id } : {};");
    expect(leg).toContain('await enqueueXeroRefundCreditNoteOperation(route.paymentId, route.refundCents, { createdByMemberId: actingMemberId, refundMethod: "internet-banking", handBackTaskId: task.id, ...ownRecord, store });');
  });
});

describe("the bank-transfer floor's alert is the one the Xero guide describes (#4230)", () => {
  const guide = read("docs/guides/xero.md");

  it("quotes the advice word for word, in plain English with no issue numbers", () => {
    expect(guide).toContain(`"${BANK_TRANSFER_REFUND_SHORTFALL_ADVICE}"`);
    expect(BANK_TRANSFER_REFUND_SHORTFALL_ADVICE).not.toMatch(/#\d|`/);
  });

  it("names the symptom in the alert's own words", () => {
    const floor = read("src/lib/xero-inbound/credit-note-bank-transfer-floor.ts");
    expect(guide).toContain("A Xero sync alert says **the refunds Xero accounts for on a bank-transfer payment add up to less than the refunds the club recorded on it**");
    for (const phrase of ["the refunds Xero accounts for on it add up to", "less than the refunds the club recorded on it"]) {
      expect(floor).toContain(phrase);
    }
  });
});
