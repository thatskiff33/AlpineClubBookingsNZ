import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { queueOrganiserExtraForChange } from "@/lib/organiser-extra-invoice-queue";
const enqueue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/xero-operation-outbox", () => ({ enqueueOrganiserExtraInvoiceInTransaction: enqueue }));
const tx = {} as Prisma.TransactionClient;
const booking = { id: "child", organiserSettled: true, parentBookingId: "parent", payment: { source: "INTERNET_BANKING" } };
const change = { id: "change", memberId: "actor", priceDiffCents: 5000, changeFeeCents: 1000 };
beforeEach(() => vi.clearAllMocks());
describe("durable organiser bill", () => {
  it("queues this change's signed price and fee in the caller transaction", async () => {
    await queueOrganiserExtraForChange(tx, booking, { ...change, priceDiffCents: -500 });
    expect(enqueue).toHaveBeenCalledWith({ bookingId: "child", bookingModificationId: "change", priceDiffCents: -500,
      changeFeeCents: 1000, createdByMemberId: "actor" }, tx);
  });
  it.each([0, -1000])("does not invoice a nonpositive net %s", async (net) => {
    await queueOrganiserExtraForChange(tx, booking, { ...change, priceDiffCents: net - 1000 });
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("leaves a card booking to its existing settlement", async () => {
    await queueOrganiserExtraForChange(tx, { ...booking, payment: { source: "STRIPE" } }, change);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("rolls the edit back if the durable queue cannot be written", async () => {
    enqueue.mockRejectedValueOnce(new Error("queue write failed"));
    await expect(queueOrganiserExtraForChange(tx, booking, change)).rejects.toThrow("queue write failed");
  });
});
