// #4988 (`INV-PAY-151`): previewing, posting and reversing an opening-credit
// batch. The transaction client exposes only the delegates the writer may
// touch, so a stray write — a booking, an email row, a Xero outbox row — fails
// the test rather than passing silently.
import { CreditType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  member: { findMany: vi.fn() },
  openingCreditBatch: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  memberCredit: { createMany: vi.fn(), findMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

const ledger = vi.hoisted(() => ({ locked: [] as string[], balance: vi.fn() }));
vi.mock("@/lib/member-credit", () => ({
  lockMemberCreditLedger: vi.fn(async (memberId: string) => {
    ledger.locked.push(memberId);
  }),
  getMemberCreditBalance: (...args: unknown[]) => ledger.balance(...args),
}));
const audit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit", () => ({ createAuditLog: audit }));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/utils", () => ({ formatCents: (cents: number) => `$${(cents / 100).toFixed(2)}` }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const lots = vi.hoisted(() => vi.fn());
vi.mock("@/lib/xero-applied-credit-lots", () => ({ loadFreeCreditLots: lots }));
const notedGuard = vi.hoisted(() => vi.fn());
vi.mock("@/lib/admin-grant-credit-note", () => ({ assertDeductionLeavesNotedCreditUntouched: notedGuard }));

import { MemberCreditValidationError } from "@/lib/policies/member-credit";
import {
  buildOpeningCreditPreview,
  OpeningCreditBatchAlreadyPostedError,
  openingCreditBatchKey,
  postOpeningCreditBatch,
  reverseOpeningCreditBatch,
} from "@/lib/opening-credit-batch";

const MEMBERS = [
  { id: "m-b", email: "bea@example.com", firstName: "Bea", lastName: "Brown" },
  { id: "m-a", email: "al@example.com", firstName: "Al", lastName: "Adams" },
];

function membersFor(where: { id?: { in: string[] }; email?: { in: string[] } }) {
  if (where.id) return MEMBERS.filter((member) => where.id?.in.includes(member.id));
  return MEMBERS.filter((member) => where.email?.in.includes(member.email));
}

const FILE = "Email,Amount\nbea@example.com,40\nal@example.com,$12.50\n";

async function preview(text = FILE) {
  const result = await buildOpeningCreditPreview(text);
  if (!result.ok) throw new Error(result.error);
  return result.preview;
}

beforeEach(() => {
  vi.clearAllMocks();
  ledger.locked.length = 0;
  db.member.findMany.mockImplementation(async ({ where }) => membersFor(where));
  db.openingCreditBatch.findUnique.mockResolvedValue(null);
  db.openingCreditBatch.create.mockResolvedValue({ id: "batch-1", postedAt: new Date("2026-07-01T00:00:00Z") });
  db.memberCredit.createMany.mockImplementation(async ({ data }) => ({ count: data.length }));
  db.memberCredit.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ openingCreditBatch: db.openingCreditBatch, memberCredit: db.memberCredit }),
  );
});

describe("buildOpeningCreditPreview (#4988)", () => {
  it("matches every row, totals the cents and offers a key", async () => {
    const result = await preview();
    expect(result.matchedCount).toBe(2);
    expect(result.errorCount).toBe(0);
    expect(result.totalCents).toBe(5250);
    expect(result.batchKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.alreadyPosted).toBeNull();
    expect(db.memberCredit.createMany).not.toHaveBeenCalled();
  });

  it("preserves the stored opening-credit file digest", () => {
    expect(openingCreditBatchKey([{ memberId: "m-a", amountCents: 1, description: "x" }])).toBe(
      "fc3db20fe38272937fa0a953d9933ac988c532e6e287065daf26c918881d706e",
    );
  });

  it("matches shared-email names with canonical Unicode and internal spacing", async () => {
    db.member.findMany.mockResolvedValue([
      { id: "m-1", email: "family@example.com", firstName: "Ana Maria", lastName: "Ngāti" },
      { id: "m-2", email: "family@example.com", firstName: "Ben", lastName: "Ngāti" },
    ]);
    const named = await preview("Email,First Name,Last Name,Amount\nfamily@example.com,Ana   Maria,Nga\u0304ti,10\n");
    expect(named.errorCount).toBe(0);
    expect(named.rows[0]?.memberId).toBe("m-1");
  });

  it("hashes the same content the same way whatever the row order", async () => {
    const reordered = await preview("Email,Amount\nal@example.com,12.50\nbea@example.com,40.00\n");
    expect(reordered.batchKey).toBe((await preview()).batchKey);
    expect(openingCreditBatchKey([{ memberId: "m-a", amountCents: 1, description: "x" }])).not.toBe(
      openingCreditBatchKey([{ memberId: "m-a", amountCents: 2, description: "x" }]),
    );
  });

  it("offers no key while any row is unmatched, and totals only the matched rows", async () => {
    const result = await preview("Email,Amount\nbea@example.com,40\nnobody@example.com,5\n");
    expect(result.batchKey).toBeNull();
    expect(result.errorCount).toBe(1);
    expect(result.totalCents).toBe(4000);
    expect(result.rows[1]?.errors[0]).toMatch(/no current member matches/);
  });

  it("refuses a member named twice in one file instead of summing", async () => {
    const result = await preview("Email,Amount\nbea@example.com,40\nBEA@example.com,40\n");
    expect(result.batchKey).toBeNull();
    expect(result.errorCount).toBe(2);
    expect(result.rows[0]?.errors).toEqual(["names the same member as line 3"]);
  });

  it("narrows a shared email by name and refuses when it stays ambiguous", async () => {
    db.member.findMany.mockImplementation(async () => [
      { id: "m-1", email: "family@example.com", firstName: "Ann", lastName: "Kay" },
      { id: "m-2", email: "family@example.com", firstName: "Ben", lastName: "Kay" },
    ]);
    const named = await preview("Email,First Name,Amount\nfamily@example.com,ben,10\n");
    expect(named.rows[0]?.memberId).toBe("m-2");
    const bare = await preview("Email,Amount\nfamily@example.com,10\n");
    expect(bare.rows[0]?.errors[0]).toMatch(/2 members share/);
  });

  it("reports a file already posted, without calling its own members holders", async () => {
    db.openingCreditBatch.findUnique.mockResolvedValue({ id: "batch-0", postedAt: new Date(0), reversedAt: null });
    db.memberCredit.findMany.mockResolvedValue([{ memberId: "m-b" }]);
    const result = await preview();
    expect(result.alreadyPosted).toMatchObject({ batchId: "batch-0" });
    expect(result.errorCount).toBe(0);
  });

  it("refuses a member still holding credit from an unreversed batch, so a corrected file cannot credit twice", async () => {
    db.memberCredit.findMany.mockResolvedValue([{ memberId: "m-b" }]);
    const result = await preview();
    expect(db.memberCredit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ amountCents: { gt: 0 }, openingCreditBatch: { is: { reversedAt: null } } }),
      }),
    );
    expect(result.batchKey).toBeNull();
    expect(result.errorCount).toBe(1);
    expect(result.totalCents).toBe(1250);
    expect(result.rows[0]?.errors[0]).toMatch(/already has an opening credit from an earlier batch/);
  });
});

describe("postOpeningCreditBatch (#4988)", () => {
  async function confirm(overrides: Partial<{ expectedBatchKey: string; expectedTotalCents: number }> = {}) {
    const shown = await preview();
    return postOpeningCreditBatch({
      csvText: FILE,
      expectedBatchKey: overrides.expectedBatchKey ?? shown.batchKey ?? "",
      expectedTotalCents: overrides.expectedTotalCents ?? shown.totalCents,
      adminId: "officer-1",
    });
  }

  it("posts one ADMIN_ADJUSTMENT credit per member under sorted ledger locks, with one audit row", async () => {
    const posted = await confirm();
    expect(posted).toMatchObject({ batchId: "batch-1", totalCents: 5250, rowCount: 2 });
    expect(ledger.locked).toEqual(["m-a", "m-b"]);
    expect(db.memberCredit.createMany).toHaveBeenCalledTimes(1);
    expect(db.memberCredit.createMany.mock.calls[0]?.[0].data).toEqual([
      expect.objectContaining({ memberId: "m-a", amountCents: 1250, type: CreditType.ADMIN_ADJUSTMENT, openingCreditBatchId: "batch-1", approvedById: "officer-1" }),
      expect.objectContaining({ memberId: "m-b", amountCents: 4000, type: CreditType.ADMIN_ADJUSTMENT, openingCreditBatchId: "batch-1" }),
    ]);
    expect(db.openingCreditBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ totalCents: 5250, rowCount: 2, postedById: "officer-1" }) }),
    );
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({ action: "member.credit.opening_batch.post", category: "payment", entityId: "batch-1" });
  });

  it("refuses when the file changed since the preview, writing nothing", async () => {
    await expect(confirm({ expectedTotalCents: 5251 })).rejects.toMatchObject({ status: 409 });
    await expect(confirm({ expectedBatchKey: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a file already posted before opening a transaction", async () => {
    const shown = await preview();
    db.openingCreditBatch.findUnique.mockResolvedValue({ id: "batch-0", postedAt: new Date(0), reversedAt: null });
    await expect(
      postOpeningCreditBatch({ csvText: FILE, expectedBatchKey: shown.batchKey ?? "", expectedTotalCents: 5250, adminId: "o" }),
    ).rejects.toBeInstanceOf(OpeningCreditBatchAlreadyPostedError);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("turns a lost race on the batch key into the already-posted refusal", async () => {
    db.$transaction.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    await expect(confirm()).rejects.toBeInstanceOf(OpeningCreditBatchAlreadyPostedError);
  });

  it("refuses, under the locks, a member credited by another batch since the preview", async () => {
    const shown = await preview();
    db.memberCredit.findMany.mockResolvedValue([{ memberId: "m-a" }]);
    await expect(
      postOpeningCreditBatch({ csvText: FILE, expectedBatchKey: shown.batchKey ?? "", expectedTotalCents: 5250, adminId: "o" }),
    ).rejects.toMatchObject({ status: 400 });
    // The same race, lost only inside the transaction after the locks.
    db.memberCredit.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ memberId: "m-a" }]);
    await expect(
      postOpeningCreditBatch({ csvText: FILE, expectedBatchKey: shown.batchKey ?? "", expectedTotalCents: 5250, adminId: "o" }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already has an opening credit") });
    expect(ledger.locked).toEqual(["m-a", "m-b"]);
    expect(db.memberCredit.createMany).not.toHaveBeenCalled();
  });

  it("refuses a file with an error row", async () => {
    await expect(
      postOpeningCreditBatch({ csvText: "Email,Amount\nnobody@example.com,5\n", expectedBatchKey: "0".repeat(64), expectedTotalCents: 5, adminId: "o" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("reverseOpeningCreditBatch (#4988)", () => {
  const POSTED_AT = new Date("2026-06-01T00:00:00Z");
  const credits = [
    { id: "c-a", memberId: "m-a", amountCents: 1250, member: { firstName: "Al", lastName: "Adams" } },
    { id: "c-b", memberId: "m-b", amountCents: 4000, member: { firstName: "Bea", lastName: "Brown" } },
  ];

  beforeEach(() => {
    db.openingCreditBatch.findUnique.mockResolvedValue({ id: "batch-1", totalCents: 5250, postedAt: POSTED_AT, reversedAt: null, credits });
    db.openingCreditBatch.updateMany.mockResolvedValue({ count: 1 });
    lots.mockResolvedValue(
      new Map(credits.map((credit) => [credit.memberId, { lots: [{ memberCreditId: credit.id, remainingCents: credit.amountCents }] }])),
    );
    ledger.balance.mockImplementation(async (memberId: string) => credits.find((credit) => credit.memberId === memberId)?.amountCents ?? 0);
    notedGuard.mockResolvedValue(undefined);
  });

  it("posts a negative row per credit and stamps the batch, under the members' locks", async () => {
    const result = await reverseOpeningCreditBatch({ batchId: "batch-1", reason: " typo in file ", adminId: "officer-2" });
    expect(result).toEqual({ batchId: "batch-1", totalCents: 5250, rowCount: 2 });
    expect(ledger.locked).toEqual(["m-a", "m-b"]);
    expect(db.openingCreditBatch.updateMany).toHaveBeenCalledWith({
      where: { id: "batch-1", reversedAt: null },
      data: expect.objectContaining({ reversedById: "officer-2", reversalReason: "typo in file" }),
    });
    expect(db.memberCredit.createMany.mock.calls[0]?.[0].data.map((row: { amountCents: number }) => row.amountCents)).toEqual([
      -1250, -4000,
    ]);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({ action: "member.credit.opening_batch.reverse", category: "payment" });
    // The lots are read before the claim stamps the batch reversed, since a
    // reversed batch's credits stop being lots.
    expect(lots.mock.invocationCallOrder[0]).toBeLessThan(db.openingCreditBatch.updateMany.mock.invocationCallOrder[0] ?? 0);
  });

  it("refuses when a member has had any credit deducted since the batch posted, though the balance covers it", async () => {
    db.memberCredit.findMany.mockResolvedValue([{ memberId: "m-a" }]);
    await expect(reverseOpeningCreditBatch({ batchId: "batch-1", reason: "r", adminId: "o" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Al Adams"),
    });
    expect(db.memberCredit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          amountCents: { lt: 0 },
          createdAt: { gte: POSTED_AT },
          OR: [{ openingCreditBatchId: null }, { openingCreditBatchId: { not: "batch-1" } }],
        }),
      }),
    );
    expect(db.openingCreditBatch.updateMany).not.toHaveBeenCalled();
    expect(db.memberCredit.createMany).not.toHaveBeenCalled();
  });

  it("refuses when any credit has been partly spent, and writes no credit row", async () => {
    lots.mockResolvedValue(
      new Map([
        ["m-a", { lots: [{ memberCreditId: "c-a", remainingCents: 1250 }] }],
        ["m-b", { lots: [{ memberCreditId: "c-b", remainingCents: 3999 }] }],
      ]),
    );
    await expect(reverseOpeningCreditBatch({ batchId: "batch-1", reason: "r", adminId: "o" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Bea Brown"),
    });
    expect(db.memberCredit.createMany).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses when the member's balance no longer covers the credit", async () => {
    ledger.balance.mockResolvedValue(100);
    await expect(reverseOpeningCreditBatch({ batchId: "batch-1", reason: "r", adminId: "o" })).rejects.toMatchObject({ status: 409 });
    expect(db.memberCredit.createMany).not.toHaveBeenCalled();
  });

  it("refuses when the deduction would consume a Xero-noted credit", async () => {
    notedGuard.mockRejectedValueOnce(new MemberCreditValidationError("would consume a noted credit"));
    await expect(reverseOpeningCreditBatch({ batchId: "batch-1", reason: "r", adminId: "o" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("would consume a noted credit"),
    });
  });

  it("refuses a second reversal, and one that loses the claim", async () => {
    db.openingCreditBatch.findUnique.mockResolvedValueOnce({ id: "batch-1", totalCents: 5250, postedAt: POSTED_AT, reversedAt: new Date(), credits });
    await expect(reverseOpeningCreditBatch({ batchId: "batch-1", reason: "r", adminId: "o" })).rejects.toMatchObject({ status: 409 });
    db.openingCreditBatch.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(reverseOpeningCreditBatch({ batchId: "batch-1", reason: "r", adminId: "o" })).rejects.toMatchObject({ status: 409 });
    expect(db.memberCredit.createMany).not.toHaveBeenCalled();
  });

  it("needs a reason and a batch", async () => {
    await expect(reverseOpeningCreditBatch({ batchId: "batch-1", reason: "  ", adminId: "o" })).rejects.toMatchObject({ status: 400 });
    db.openingCreditBatch.findUnique.mockResolvedValueOnce(null);
    await expect(reverseOpeningCreditBatch({ batchId: "nope", reason: "r", adminId: "o" })).rejects.toMatchObject({ status: 404 });
  });
});
