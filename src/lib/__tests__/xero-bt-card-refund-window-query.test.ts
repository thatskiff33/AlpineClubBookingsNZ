import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PaymentSource, Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { cardRefundNoteKeyTag, cardRefundNoteRowsWhere } from "@/lib/card-refund-paid-another-way-cash";
import { CARD_REFUND_NOTE_CUTOVER_MIGRATION } from "@/lib/card-refund-own-note-share";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { parsePaymentCreditNoteRetryInput } from "@/lib/xero-payment-credit-note-payload";
import { EXCLUDED_LEDGER_REFUND_STATUSES } from "@/lib/payment-transaction-status";
import { buildRefundDocumentReference } from "@/lib/xero-refund-method";

/**
 * #4312 review (`INV-ADDPAY-047`, `INV-SSOT`): the UPGRADING switch-window
 * query, which lists the card refund notes this release raised for a
 * late-captured payment's refund made while the previous version still served,
 * spells by hand what the code defines once - the marker migration, a card
 * refund note row's fields and its key - because an operator runs it in psql.
 * This pins each literal to the code; `xero-bt-card-refund-notes` runs the
 * query against real PostgreSQL.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

/** The UPGRADING entry's switch-window section, from its heading to the next one. */
function cardRefundWindowSection(): string {
  const doc = readFileSync(resolve(REPO_ROOT, "docs/UPGRADING.md"), "utf8");
  const start = doc.indexOf("**Card refunds made in the switch window (#4312).**");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = doc.indexOf("**During the switch, and if you roll back.**", start);
  expect(end).toBeGreaterThan(start);
  return doc.slice(start, end);
}

function cardRefundWindowQuerySql(): string {
  const sql = /```sql\n([\s\S]*?)\n```/.exec(cardRefundWindowSection())?.[1];
  expect(sql).toBeDefined();
  return sql!;
}

/** The timestamp an operator replaces with the moment this version served alone: one PostgreSQL refuses to parse, so the query never runs unset. */
const CARD_REFUND_WINDOW_QUERY_PLACEHOLDER = "TIMESTAMPTZ 'SET-ME'";

describe("the #4312 switch-window query matches the code's one definition", () => {
  const sql = cardRefundWindowQuerySql();

  it("dates the window from the marker migration the code reads", () => {
    expect([...sql.matchAll(/m\."migration_name" = '([^']*)'/g)].map((match) => match[1])).toEqual([CARD_REFUND_NOTE_CUTOVER_MIGRATION]);
    expect(sql).toContain('m."rolled_back_at" IS NULL');
    expect(sql.split(CARD_REFUND_WINDOW_QUERY_PLACEHOLDER)).toHaveLength(2);
  });

  it("dates a refund as the app does (`madeSinceCardRefundNoteCutover`): Stripe's time else the record's, in UTC, in whole seconds", () => {
    // `PaymentRefund`'s times are UTC with no zone; the marker's finish and the operator's moment carry one, so
    // each is read in UTC - never compared through the session's zone - and the marker's own second counts.
    const madeAt = "date_trunc('second', COALESCE(r.\"stripeCreatedAt\", r.\"createdAt\"))";
    expect(sql).toContain(`${madeAt} >= (SELECT date_trunc('second', min(m."finished_at") AT TIME ZONE 'UTC')`);
    expect(sql).toContain(`${madeAt} <= (${CARD_REFUND_WINDOW_QUERY_PLACEHOLDER} AT TIME ZONE 'UTC')`);
    expect(sql).not.toMatch(/\bTIMESTAMP '/);
  });

  it("finds a card refund's note rows as the code does: its payload field, or its key", () => {
    const where = cardRefundNoteRowsWhere("PAYMENT", "re_X");
    expect(sql).toContain(`o."localModel" = '${where.localModel}' AND o."entityType" = '${where.entityType}' AND o."operationType" = '${where.operationType}'`);
    const payloadKey = (where.OR[0] as { requestPayload: { path: string[] } }).requestPayload.path[0];
    expect(sql).toContain(`o."requestPayload"->>'${payloadKey}'`);
    const tag = cardRefundNoteKeyTag("re_X").split("re_X");
    expect(sql).toContain(`LIKE '%${tag[0]}' || r."stripeRefundId" || '${tag[1]}%'`);
  });

  it("keeps to late-captured payments' counted refunds on a bank transfer: the capture a treasurer held, or one a note row names", () => {
    expect(sql).toContain(`p.source = '${PaymentSource.INTERNET_BANKING}'`);
    expect(sql).toContain(`r.status NOT IN (${EXCLUDED_LEDGER_REFUND_STATUSES.map((status) => `'${status}'`).join(", ")})`);
    expect(sql).toContain(`t."${Prisma.ManualRefundTaskScalarFieldEnum.lateCaptureApprovalIntentId}" = r."stripePaymentIntentId"`);
    const where = cardRefundNoteRowsWhere("PAYMENT", "re_X");
    expect(sql).toContain(`c."localModel" = '${where.localModel}' AND c."entityType" = '${where.entityType}' AND c."operationType" = '${where.operationType}'`);
    const named = /c\."requestPayload"->>'(\w+)' = r\."stripePaymentIntentId"/.exec(sql)?.[1];
    expect(named).toBeDefined();
    expect(parsePaymentCreditNoteRetryInput({ requestPayload: { queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE, refundAmountCents: 100, [named!]: "pi_X" } })?.paymentIntentId).toBe("pi_X");
  });

  it("names the reference the app's card refund note carries, for a failed row's look in Xero", () => {
    const head = buildRefundDocumentReference({ method: "card", bookingId: "" });
    expect(cardRefundWindowSection().replace(/\s+/g, " ")).toContain(`\`${head}<first eight characters of bookingId>\``);
    expect(buildRefundDocumentReference({ method: "card", bookingId: "ABCDEFGHIJKL" })).toBe(`${head}ABCDEFGH`);
  });
});
