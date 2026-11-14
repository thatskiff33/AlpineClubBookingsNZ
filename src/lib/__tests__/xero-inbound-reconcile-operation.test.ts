/**
 * `INV-INT-038`: an inbound webhook reconcile never shares another attempt's
 * operation row. An abandoned (stale RUNNING) one is taken over under a fresh
 * claim; a live one fails this attempt as in flight. Runs under the frozen test
 * clock, so "stale" and "live" are measured from 2026-07-01T00:00Z.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "@/lib/__tests__/helpers/clock";
import { STALE_RUNNING_XERO_OPERATION_MINUTES } from "@/lib/xero-stale-operations";
import { XERO_ORPHANED_STALE_RUNNING_ERROR_CODE } from "@/lib/xero-operation-error-codes";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  findFirst: vi.fn(),
  updateManyAndReturn: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { xeroSyncOperation: { findFirst: mocks.findFirst, updateManyAndReturn: mocks.updateManyAndReturn } },
}));
vi.mock("@/lib/xero-sync", () => ({ startXeroSyncOperation: mocks.start }));

import { startInboundReconcileOperation, XeroInboundReconcileInFlightError } from "@/lib/xero-inbound/reconcile-operation";

const NOW = new Date(FROZEN_TEST_CLOCK_BASE_ISO);
const KEY = "xero-webhook:event-1";
const input = { entityType: "INVOICE", correlationKey: KEY, requestPayload: { resourceId: "inv-1" } };
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const uniqueViolation = () => Object.assign(new Error("unique"), { code: "P2002" });

function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "op_abandoned",
    direction: "INBOUND",
    operationType: "WEBHOOK_RECONCILE",
    status: "RUNNING",
    correlationKey: KEY,
    startedAt: minutesAgo(STALE_RUNNING_XERO_OPERATION_MINUTES + 1),
    ...overrides,
  };
}

describe("startInboundReconcileOperation (INV-INT-038)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateManyAndReturn.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => [
      { ...activeRow(), ...data },
    ]);
  });

  it("starts its own row, never asking to be handed another attempt's", async () => {
    mocks.start.mockResolvedValueOnce({ id: "op_new", startedAt: NOW });

    await expect(startInboundReconcileOperation(input)).resolves.toMatchObject({ id: "op_new" });
    expect(mocks.start).toHaveBeenCalledWith({
      direction: "INBOUND",
      entityType: "INVOICE",
      operationType: "WEBHOOK_RECONCILE",
      correlationKey: KEY,
      replayable: true,
      requestPayload: input.requestPayload,
      shareActiveOperation: false,
    });
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("takes an abandoned RUNNING row over under a fresh claim, guarded on the abandoned claim", async () => {
    const abandoned = activeRow();
    mocks.start.mockRejectedValueOnce(uniqueViolation());
    mocks.findFirst.mockResolvedValueOnce(abandoned);

    const taken = await startInboundReconcileOperation(input);

    expect(mocks.updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        id: "op_abandoned",
        direction: "INBOUND",
        operationType: "WEBHOOK_RECONCILE",
        status: "RUNNING",
        startedAt: abandoned.startedAt,
      },
      data: expect.objectContaining({
        startedAt: NOW,
        completedAt: null,
        attemptCount: { increment: 1 },
        lastErrorCode: XERO_ORPHANED_STALE_RUNNING_ERROR_CODE,
      }),
    });
    // The claim this attempt's outcomes carry is the fresh one, not the abandoned one.
    expect(taken.startedAt).toEqual(NOW);
  });

  it("fails as in flight, writing nothing, while the row's claim is still live", async () => {
    mocks.start.mockRejectedValueOnce(uniqueViolation());
    mocks.findFirst.mockResolvedValueOnce(activeRow({ startedAt: minutesAgo(STALE_RUNNING_XERO_OPERATION_MINUTES - 1) }));

    await expect(startInboundReconcileOperation(input)).rejects.toBeInstanceOf(XeroInboundReconcileInFlightError);
    expect(mocks.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it.each([
    ["an outbound row", { direction: "OUTBOUND", operationType: "CREATE" }],
    ["a queued row", { status: "PENDING", startedAt: null }],
    ["a row waiting on payment", { status: "WAITING_PAYMENT" }],
  ])("never takes over %s holding the key", async (_label, overrides) => {
    mocks.start.mockRejectedValueOnce(uniqueViolation());
    mocks.findFirst.mockResolvedValueOnce(activeRow(overrides));

    await expect(startInboundReconcileOperation(input)).rejects.toBeInstanceOf(XeroInboundReconcileInFlightError);
    expect(mocks.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("inserts again when an officer's reset ended the abandoned row before its takeover", async () => {
    mocks.start.mockRejectedValueOnce(uniqueViolation()).mockResolvedValueOnce({ id: "op_fresh", startedAt: NOW });
    mocks.findFirst.mockResolvedValueOnce(activeRow());
    mocks.updateManyAndReturn.mockResolvedValueOnce([]);

    await expect(startInboundReconcileOperation(input)).resolves.toMatchObject({ id: "op_fresh" });
    expect(mocks.start).toHaveBeenCalledTimes(2);
  });

  it("fails as in flight when a racing attempt's takeover won", async () => {
    mocks.start.mockRejectedValue(uniqueViolation());
    mocks.findFirst
      .mockResolvedValueOnce(activeRow())
      .mockResolvedValueOnce(activeRow({ startedAt: NOW }));
    mocks.updateManyAndReturn.mockResolvedValueOnce([]);

    await expect(startInboundReconcileOperation(input)).rejects.toMatchObject({
      name: "XeroInboundReconcileInFlightError",
      operationId: "op_abandoned",
    });
    expect(mocks.updateManyAndReturn).toHaveBeenCalledTimes(1);
  });

  it("gives up as in flight after its bounded rounds when the key keeps clashing with nothing to read", async () => {
    mocks.start.mockRejectedValue(uniqueViolation());
    mocks.findFirst.mockResolvedValue(null);

    await expect(startInboundReconcileOperation(input)).rejects.toBeInstanceOf(XeroInboundReconcileInFlightError);
    expect(mocks.start).toHaveBeenCalledTimes(3);
  });

  it("rethrows any error but the active-key clash", async () => {
    mocks.start.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(startInboundReconcileOperation(input)).rejects.toThrow("database unavailable");
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });
});
