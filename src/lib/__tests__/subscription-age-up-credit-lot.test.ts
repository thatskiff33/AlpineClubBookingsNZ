// #5190 PR 3 (`INV-MONEY-053`): the credit lot an age-up credit becomes when the
// season invoice cannot take it. The transaction client exposes only the
// delegate the writer may touch, so a stray write fails the test. The claim
// that guards this writer, and the race on a real database, are in
// subscription-age-up-credit.test.ts and subscription-age-up.realdb.test.ts.
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ audit: vi.fn(), startOperation: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: unknown[]) => parts.join(":"),
  startXeroSyncOperation: mocks.startOperation,
}));

import { postAgeUpCreditLot } from "@/lib/member-credit";
import { MemberCreditValidationError } from "@/lib/policies/member-credit";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const DESCRIPTION = "Full membership 2026 - 2027 (10 months) — age group change credit, Youth to Adult";

function transaction() {
  const tx = { memberCredit: { create: vi.fn(async () => ({ id: "credit-lot-1" })) } };
  return { tx, client: tx as unknown as Prisma.TransactionClient };
}

const post = (client: Prisma.TransactionClient, amountCents: number) =>
  postAgeUpCreditLot(client, {
    adjustmentId: "adjustment-1",
    memberId: "member-1",
    amountCents,
    description: DESCRIPTION,
    format: CLUB_FORMAT_TEST,
  });

beforeEach(() => vi.clearAllMocks());

describe("postAgeUpCreditLot", () => {
  it("writes one positive lot, queues its Xero note on the membership-credit account, and audits it", async () => {
    const { tx, client } = transaction();

    expect(await post(client, 2_500)).toEqual({ id: "credit-lot-1" });

    expect(tx.memberCredit.create).toHaveBeenCalledTimes(1);
    expect(tx.memberCredit.create).toHaveBeenCalledWith({
      data: { memberId: "member-1", amountCents: 2_500, type: "ADMIN_ADJUSTMENT", description: DESCRIPTION },
      select: { id: true },
    });

    // One note, for the lot's own amount, keyed on the lot: written in the
    // caller's transaction so it commits or rolls back with the lot.
    expect(mocks.startOperation).toHaveBeenCalledTimes(1);
    const key = "member-credit:credit-lot-1:admin-grant-credit-note:2500:membershipCancellationCredit:v1";
    expect(mocks.startOperation).toHaveBeenCalledWith(expect.objectContaining({
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "MemberCredit",
      localId: "credit-lot-1",
      status: "PENDING",
      idempotencyKey: key,
      correlationKey: key,
      requestPayload: expect.objectContaining({
        amountCents: 2_500,
        mappingKey: "membershipCancellationCredit",
        memberCreditId: "credit-lot-1",
      }),
      store: client,
    }));

    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.credit.age_up_credit",
        category: "payment",
        entityType: "MemberSubscriptionAgeUpAdjustment",
        entityId: "adjustment-1",
        targetId: "member-1",
        details: expect.stringMatching(/^Posted age-up credit credit-lot-1 for adjustment adjustment-1: \+\$25\.00\. /),
      }),
      client,
    );
  });

  it.each([0, -2_500, 12.5, Number.NaN])("refuses %s cents and writes nothing", async (amountCents) => {
    const { tx, client } = transaction();

    await expect(post(client, amountCents)).rejects.toBeInstanceOf(MemberCreditValidationError);

    expect(tx.memberCredit.create).not.toHaveBeenCalled();
    expect(mocks.startOperation).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
