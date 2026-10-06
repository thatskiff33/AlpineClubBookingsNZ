import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireCalendarDate } from "@/lib/club-time";
import { ApiError } from "@/lib/api-error";
import {
  OverCapacityConfirmationRequiredError,
  WholeLodgeHoldBlockedError,
} from "@/lib/over-capacity-confirmation";
import { NO_SEASON_RATE_MESSAGE } from "@/lib/booking-modify-plan";

/**
 * #3750: `PATCH /api/admin/booking-change-requests/[id]` EXECUTES an approval
 * when the booking's stay has finished, and only then. The executor is a double
 * (`booking-change-request-execution.test.ts` proves the engine); this suite
 * proves the route's half — which path it takes, what it sends the engine, how
 * each refusal reads, and that the audit row keeps `INV-PRIV-018`'s disclosure.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requestFindUnique: vi.fn(),
  requestUpdateMany: vi.fn(),
  execute: vi.fn(),
  prepare: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingChangeRequest: {
      findUnique: (...args: unknown[]) => mocks.requestFindUnique(...args),
      updateMany: (...args: unknown[]) => mocks.requestUpdateMany(...args),
    },
    bookingModification: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/audit", () => ({ logAudit: (...args: unknown[]) => mocks.logAudit(...args) }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/club-time/server", () => ({
  clubTime: async () => ({ today: () => requireCalendarDate("2026-07-01") }),
}));
vi.mock("@/lib/club-format-server", () => ({
  clubFormatValues: async () => ({ marker: "format" }),
}));
vi.mock("@/lib/booking-change-request-execution", () => ({
  approveAndExecuteLockedPeriodChangeRequest: (...args: unknown[]) => mocks.execute(...args),
}));
vi.mock("@/lib/booking-batch-modification-service", () => ({
  prepareBatchModificationForCallerTransaction: (...args: unknown[]) => mocks.prepare(...args),
}));

import { PATCH } from "@/app/api/admin/booking-change-requests/[id]/route";

function patch(body: Record<string, unknown>) {
  return PATCH(
    new NextRequest("http://localhost/api/admin/booking-change-requests/cr-1", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.1" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "cr-1" }) },
  );
}

function preRead(booking: Record<string, unknown>) {
  return {
    id: "cr-1",
    kind: "LOCKED_PERIOD",
    status: "REQUESTED",
    version: 2,
    booking: { id: "booking-1", memberId: "member-1", ...booking },
  };
}

const FINISHED = { checkOut: new Date("2026-06-14T00:00:00.000Z"), status: "COMPLETED" };

const EXECUTED = {
  outcome: "executed",
  requestId: "cr-1",
  bookingId: "booking-1",
  requestedByMemberId: "member-1",
  modificationId: "mod-9",
  addedGuestCount: 1,
  removedGuestCount: 0,
  priceDiffCents: 4_500,
  changeFeeCents: 0,
  additionalAmountCents: 4_500,
  refundAmountCents: 0,
  accountCreditAmountCents: 0,
  capacityOverridden: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "officer-1" } },
  });
  mocks.prepare.mockResolvedValue({ marker: "pre" });
  mocks.execute.mockResolvedValue(EXECUTED);
});

describe("PATCH booking change request — finished stay (#3750)", () => {
  it("executes the approval on a finished stay, with the screen's version and the officer's answers", async () => {
    mocks.requestFindUnique
      .mockResolvedValueOnce(preRead(FINISHED))
      .mockResolvedValueOnce({ id: "cr-1", status: "APPROVED", linkedModificationId: "mod-9" });

    const response = await patch({
      status: "APPROVED",
      adminNotes: "  Added the guest who stayed.  ",
      internalNotes: "Warden confirmed.",
      confirmOverCapacity: true,
      settlementMethod: "credit",
    });

    expect(response.status).toBe(200);
    expect(mocks.prepare).toHaveBeenCalledWith({ audience: "admin" });
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "cr-1",
        expectedVersion: 2,
        actorMemberId: "officer-1",
        adminNotes: "Added the guest who stayed.",
        internalNotes: "Warden confirmed.",
        confirmOverCapacity: true,
        settlementMethod: "credit",
        todayAtClub: "2026-07-01",
        preTransaction: { marker: "pre" },
        format: { marker: "format" },
      }),
    );
    // The acknowledgement path's claim never ran.
    expect(mocks.requestUpdateMany).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.execution).toMatchObject({
      executed: true,
      modificationId: "mod-9",
      additionalAmountCents: 4_500,
    });
  });

  it("also executes a PAID stay whose check-out day is behind today", async () => {
    mocks.requestFindUnique
      .mockResolvedValueOnce(
        preRead({ checkOut: new Date("2026-06-30T00:00:00.000Z"), status: "PAID" }),
      )
      .mockResolvedValueOnce({ id: "cr-1" });
    expect((await patch({ status: "APPROVED", adminNotes: "ok" })).status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("only acknowledges a stay that has not finished, exactly as before", async () => {
    mocks.requestFindUnique
      .mockResolvedValueOnce(
        preRead({ checkOut: new Date("2026-07-01T00:00:00.000Z"), status: "PAID" }),
      )
      .mockResolvedValueOnce({ id: "cr-1", status: "APPROVED" });
    mocks.requestUpdateMany.mockResolvedValue({ count: 1 });

    expect((await patch({ status: "APPROVED", adminNotes: "ok" })).status).toBe(200);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "APPROVED", version: { increment: 1 } }),
      }),
    );
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ executed: false }) }),
    );
  });

  it("never executes a rejection", async () => {
    mocks.requestFindUnique
      .mockResolvedValueOnce(preRead(FINISHED))
      .mockResolvedValueOnce({ id: "cr-1", status: "REJECTED" });
    mocks.requestUpdateMany.mockResolvedValue({ count: 1 });
    expect((await patch({ status: "REJECTED", adminNotes: "no" })).status).toBe(200);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("refuses a pasted modification id: an executed approval links its own", async () => {
    mocks.requestFindUnique.mockResolvedValueOnce(preRead(FINISHED));
    const response = await patch({
      status: "APPROVED",
      adminNotes: "ok",
      linkedModificationId: "mod-1",
    });
    expect(response.status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("audits the executed approval with what changed, and discloses only the member-facing note", async () => {
    mocks.requestFindUnique
      .mockResolvedValueOnce(preRead(FINISHED))
      .mockResolvedValueOnce({ id: "cr-1" });
    await patch({ status: "APPROVED", adminNotes: "Added.", internalNotes: "secret" });
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    const [row] = mocks.logAudit.mock.calls[0] as [Record<string, unknown>];
    expect(row).toMatchObject({
      action: "booking-change-request.approve",
      subjectMemberId: "member-1",
      memberDisclosure: { visibility: "member-facing", text: "Added." },
      metadata: expect.objectContaining({
        executed: true,
        modificationId: "mod-9",
        addedGuestCount: 1,
        additionalAmountCents: 4_500,
        capacityOverridden: false,
        internalNoteRecorded: true,
      }),
    });
    expect(JSON.stringify(row)).not.toContain("secret");
  });

  it("asks the officer to confirm an overbooking, and says the request is still pending", async () => {
    mocks.requestFindUnique.mockResolvedValueOnce(preRead(FINISHED));
    mocks.execute.mockRejectedValue(
      new OverCapacityConfirmationRequiredError([
        { date: "2026-06-11", available: -1 },
      ] as never),
    );
    const response = await patch({ status: "APPROVED", adminNotes: "ok" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: "REQUESTED",
      keptPending: true,
      needsCapacityConfirmation: true,
      code: "OVER_CAPACITY_CONFIRM_REQUIRED",
    });
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("refuses a whole-lodge hold outright", async () => {
    mocks.requestFindUnique.mockResolvedValueOnce(preRead(FINISHED));
    mocks.execute.mockRejectedValue(new WholeLodgeHoldBlockedError(["2026-06-11"]));
    const response = await patch({ status: "APPROVED", adminNotes: "ok", confirmOverCapacity: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "WHOLE_LODGE_HOLD_BLOCKED" });
  });

  it("explains a past season that has been switched off, and keeps the request pending", async () => {
    mocks.requestFindUnique.mockResolvedValueOnce(preRead(FINISHED));
    mocks.execute.mockRejectedValue(new ApiError(NO_SEASON_RATE_MESSAGE, 400));
    const response = await patch({ status: "APPROVED", adminNotes: "ok" });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ code: "NO_ACTIVE_SEASON", keptPending: true });
    expect(body.error).toMatch(/No active season/);
  });

  it("passes any other canonical refusal through with its own status", async () => {
    mocks.requestFindUnique.mockResolvedValueOnce(preRead(FINISHED));
    mocks.execute.mockRejectedValue(new ApiError("Locked in Xero", 409));
    const response = await patch({ status: "APPROVED", adminNotes: "ok" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "Locked in Xero", status: "REQUESTED" });
  });

  it.each([
    [{ outcome: "claimLost" }, 409],
    [{ outcome: "notAuthorized" }, 403],
    [{ outcome: "notFound" }, 404],
    [{ outcome: "keptPending", message: "This booking has changed" }, 409],
  ])("maps %o to %i with no audit row", async (outcome, status) => {
    mocks.requestFindUnique.mockResolvedValueOnce(preRead(FINISHED));
    mocks.execute.mockResolvedValue(outcome);
    expect((await patch({ status: "APPROVED", adminNotes: "ok" })).status).toBe(status);
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });
});
