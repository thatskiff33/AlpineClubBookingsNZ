import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ deduction: vi.fn(), grant: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/xero-admin-credit-deduction-correction", () => ({ completeAdminCreditDeductionCorrection: mocks.deduction }));
vi.mock("@/lib/xero-admin-grant-credit-note", () => ({ createAdminGrantCreditNote: mocks.grant }));

import { isAdminCreditQueuePayload, runAdminCreditQueueOperation } from "@/lib/xero-admin-credit-outbox";
import { resolvePrecheckRefusal } from "@/lib/xero-operation-resolve-guards";

const claim = { id: "operation", startedAt: new Date("2026-07-01T00:00:00.000Z") };
beforeEach(() => vi.resetAllMocks());

describe("the outbox's one admin-credit branch (#4431, #5241)", () => {
  it("takes a grant note and a deduction correction, and nothing else", () => {
    expect(isAdminCreditQueuePayload({ queueType: "ADMIN_GRANT_CREDIT_NOTE" })).toBe(true);
    expect(isAdminCreditQueuePayload({ queueType: "ADMIN_CREDIT_DEDUCTION_CORRECTION" })).toBe(true);
    expect(isAdminCreditQueuePayload({ queueType: "BOOKING_INVOICE" })).toBe(false);
    expect(isAdminCreditQueuePayload(null)).toBe(false);
  });

  it("sends a deduction to its correction and a grant to its note", async () => {
    const deduction = { queueType: "ADMIN_CREDIT_DEDUCTION_CORRECTION" as const, correctionId: "c1" };
    await runAdminCreditQueueOperation(claim, deduction);
    expect(mocks.deduction).toHaveBeenCalledWith({ syncOperation: claim, payload: deduction });
    expect(mocks.grant).not.toHaveBeenCalled();

    const grant = { queueType: "ADMIN_GRANT_CREDIT_NOTE", memberCreditId: "credit" } as unknown as Parameters<typeof runAdminCreditQueueOperation>[1];
    await runAdminCreditQueueOperation(claim, grant);
    expect(mocks.grant).toHaveBeenCalledWith({ syncOperation: claim, payload: grant });
    expect(mocks.deduction).toHaveBeenCalledTimes(1);
  });
});

describe("a deduction correction is never marked resolved in Xero (#5241)", () => {
  it("refuses the mark whatever the row's status, naming retry or cancel", async () => {
    for (const status of ["FAILED", "PARTIAL", "RUNNING"]) {
      await expect(resolvePrecheckRefusal({
        id: "operation", status, startedAt: null, queueType: "ADMIN_CREDIT_DEDUCTION_CORRECTION", requestPayload: {},
        correlationKey: null, entityType: "CREDIT_NOTE", operationType: "UPDATE", lastErrorCode: null, manuallyResolvedAt: null, xeroObjectId: null,
      })).resolves.toMatch(/cannot be marked resolved.*Retry it, or cancel/);
    }
  });
});
