// #4381 (owner decision 28 Nov 2026 on #4381; INV-PAY-144, INV-PAY-122): the
// paid-another-way verdict reads a late change capture another writer's one
// invoice records as recorded against that invoice, so a close's bank note
// credits it. The card verdict never does: the capture's card refunds keep
// their own path, so the bank note is never counted as a card note.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  elsewhere: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ kind: "not-elsewhere" })),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/late-capture-recorded-elsewhere", () => ({
  readLateCaptureRecordedElsewhere: (...args: unknown[]) => mocks.elsewhere(...args),
}));

import { readLateCaptureXeroReceipt, readPaidAnotherWayLateCaptureXeroReceipt } from "@/lib/late-capture-xero-receipt";

function store(task: { id: string } | null = { id: "task-1" }) {
  return {
    manualRefundTask: { findUnique: vi.fn(async () => task) },
    xeroObjectLink: { findFirst: vi.fn(async () => null) },
    xeroSyncOperation: { findMany: vi.fn(async () => []) },
    paymentTransaction: { findUnique: vi.fn(async () => ({ amountCents: 8_000 })) },
    payment: {},
    bookingModification: {},
  };
}

beforeEach(() => {
  mocks.elsewhere.mockReset();
  mocks.elsewhere.mockResolvedValue({ kind: "not-elsewhere" });
});

describe("the paid-another-way verdict of a change capture another writer records", () => {
  it("MUTATION: one invoice in Xero records it - recorded against that invoice, for what it records", async () => {
    mocks.elsewhere.mockResolvedValue({ kind: "document", invoiceId: "inv-primary", recordedCents: 8_000 });
    const db = store();
    expect(await readPaidAnotherWayLateCaptureXeroReceipt("pi_late", db as never)).toEqual({
      kind: "recorded",
      invoiceId: "inv-primary",
      recordedCents: 8_000,
      recordedElsewhere: true,
    });
    expect(mocks.elsewhere).toHaveBeenCalledWith(db, "pi_late");
  });

  it("MUTATION: the card verdict never reads it - no card note is raised or counted against that invoice", async () => {
    mocks.elsewhere.mockResolvedValue({ kind: "document", invoiceId: "inv-primary", recordedCents: 8_000 });
    expect(await readLateCaptureXeroReceipt("pi_late", store() as never)).toEqual({ kind: "none" });
    expect(mocks.elsewhere).not.toHaveBeenCalled();
  });

  it.each([["credit-release-sweep"], ["unidentified"], ["not-elsewhere"]])("%s - none, as before", async (kind) => {
    mocks.elsewhere.mockResolvedValue({ kind });
    expect(await readPaidAnotherWayLateCaptureXeroReceipt("pi_late", store() as never)).toEqual({ kind: "none" });
  });

  it("no approval task - none, and nothing else is read", async () => {
    mocks.elsewhere.mockResolvedValue({ kind: "document", invoiceId: "inv-primary", recordedCents: 8_000 });
    expect(await readPaidAnotherWayLateCaptureXeroReceipt("pi_late", store(null) as never)).toEqual({ kind: "none" });
    expect(mocks.elsewhere).not.toHaveBeenCalled();
  });
});
