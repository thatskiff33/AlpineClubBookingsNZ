import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  SubscriptionBillingError: class SubscriptionBillingError extends Error {},
  requireAdmin: vi.fn(),
  buildPreview: vi.fn(),
  confirmPreview: vi.fn(),
  reconcile: vi.fn(),
  enqueue: vi.fn(),
  audit: vi.fn(),
  revalidatePath: vi.fn(),
  charges: { findMany: vi.fn() },
  exceptions: { findMany: vi.fn() },
  settings: { findUnique: vi.fn(), upsert: vi.fn() },
  familyGroup: { findUnique: vi.fn() },
  familyMarker: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  transaction: vi.fn(),
  clubTimeSettings: { findUnique: vi.fn() },
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/membership-subscription-billing", () => ({
  buildSubscriptionBillingPreview: mocks.buildPreview,
  confirmSubscriptionBillingPreview: mocks.confirmPreview,
  reconcileSubscriptionBillingExceptions: mocks.reconcile,
  SubscriptionBillingError: mocks.SubscriptionBillingError,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn() },
}));
vi.mock("@/lib/xero-subscription-invoices", () => ({ enqueueMembershipSubscriptionChargeOperation: mocks.enqueue }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipSubscriptionCharge: mocks.charges,
    membershipBillingException: mocks.exceptions,
    membershipSubscriptionBillingSettings: mocks.settings,
    familyGroup: mocks.familyGroup,
    familyGroupSeasonInvoiceMarker: mocks.familyMarker,
    clubTimeSettings: mocks.clubTimeSettings,
    $transaction: mocks.transaction,
  },
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { GET, POST } from "@/app/api/admin/subscription-billing/route";

const preview = {
  seasonYear: 2026,
  decisionDate: "2026-07-13",
  dueDays: 30,
  scopeMemberIds: null,
  entries: [],
  exceptions: [],
  alreadyCoveredMemberIds: [],
  exemptMemberIds: [],
  exemptMembers: [],
  alreadyInvoiced: [],
  totalCents: 0,
  confirmationToken: "a".repeat(64),
};

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/subscription-billing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("admin subscription billing route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
    mocks.buildPreview.mockResolvedValue(preview);
    mocks.confirmPreview.mockResolvedValue({ chargeIds: ["charge-1"], exceptionCount: 0 });
    mocks.reconcile.mockResolvedValue({ resolvedCount: 0 });
    mocks.enqueue.mockResolvedValue({ queueOperationId: "op-1", message: "queued" });
    mocks.charges.findMany.mockResolvedValue([]);
    mocks.exceptions.findMany.mockResolvedValue([]);
    mocks.settings.findUnique.mockResolvedValue(null);
    mocks.familyGroup.findUnique.mockResolvedValue({ id: "family-1" });
    mocks.familyMarker.findFirst.mockResolvedValue(null);
    mocks.familyMarker.create.mockResolvedValue({ id: "marker-1" });
    mocks.familyMarker.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({ membershipSubscriptionBillingSettings: mocks.settings, familyGroupSeasonInvoiceMarker: mocks.familyMarker }));
  });

  it("requires finance-view permission for previews", async () => {
    const response = await GET(new NextRequest("http://localhost/api/admin/subscription-billing?seasonYear=2026&decisionDate=2026-07-13"));
    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "view" } });
  });

  it("returns the default 30 due days with preview and visible queues", async () => {
    const response = await GET(new NextRequest("http://localhost/api/admin/subscription-billing?seasonYear=2026&decisionDate=2026-07-13"));
    await expect(response.json()).resolves.toMatchObject({ preview, charges: [], exceptions: [], settings: { invoiceDueDays: 30 } });
  });

  it("preserves typed billing guidance but hides unexpected preview errors", async () => {
    mocks.buildPreview.mockRejectedValueOnce(
      new mocks.SubscriptionBillingError(
        "Decision date must fall within membership year 2026."
      )
    );
    const domainResponse = await GET(
      new NextRequest(
        "http://localhost/api/admin/subscription-billing?seasonYear=2026&decisionDate=2026-07-13"
      )
    );
    expect(domainResponse.status).toBe(409);
    await expect(domainResponse.json()).resolves.toEqual({
      error: "Decision date must fall within membership year 2026.",
    });

    mocks.buildPreview.mockRejectedValueOnce(
      new Error('password authentication failed for user "app_rw"')
    );
    const unexpectedResponse = await GET(
      new NextRequest(
        "http://localhost/api/admin/subscription-billing?seasonYear=2026&decisionDate=2026-07-13"
      )
    );
    expect(unexpectedResponse.status).toBe(500);
    await expect(unexpectedResponse.json()).resolves.toEqual({
      error: "Could not build subscription billing preview.",
    });
  });

  it("deduplicates a persisted exception already present in the current preview", async () => {
    mocks.buildPreview.mockResolvedValue({
      ...preview,
      exceptions: [{ fingerprint: "same", message: "Current exception" }],
    });
    mocks.exceptions.findMany.mockResolvedValue([
      { id: "persisted-same", fingerprint: "same", message: "Current exception" },
      { id: "persisted-other", fingerprint: "other", message: "Earlier exception" },
    ]);
    const response = await GET(new NextRequest("http://localhost/api/admin/subscription-billing?seasonYear=2026&decisionDate=2026-07-13"));
    await expect(response.json()).resolves.toMatchObject({
      exceptions: [{ id: "persisted-other", fingerprint: "other" }],
    });
  });

  it("rejects an annual run without the literal explicit confirmation", async () => {
    const response = await POST(request({
      action: "CONFIRM_ANNUAL_BATCH", seasonYear: 2026, decisionDate: "2026-07-13",
      confirmationToken: "a".repeat(64), confirmed: false,
    }));
    expect(response.status).toBe(400);
    expect(mocks.confirmPreview).not.toHaveBeenCalled();
  });

  it("rejects a stale preview and creates no charge or provider work", async () => {
    const response = await POST(request({
      action: "CONFIRM_ANNUAL_BATCH", seasonYear: 2026, decisionDate: "2026-07-13",
      confirmationToken: "b".repeat(64), confirmed: true,
    }));
    expect(response.status).toBe(409);
    expect(mocks.confirmPreview).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("confirms the unchanged snapshot and reports durable queue feedback", async () => {
    const response = await POST(request({
      action: "CONFIRM_ANNUAL_BATCH", seasonYear: 2026, decisionDate: "2026-07-13",
      confirmationToken: "a".repeat(64), confirmed: true,
    }));
    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });
    expect(mocks.confirmPreview).toHaveBeenCalledWith(expect.objectContaining({ source: "ANNUAL_BATCH", confirmedByMemberId: "admin-1" }));
    expect(mocks.enqueue).toHaveBeenCalledWith("charge-1", { createdByMemberId: "admin-1" });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin/subscriptions");
  });

  it("updates due days and audits the finance mutation", async () => {
    const response = await POST(request({ action: "UPDATE_SETTINGS", invoiceDueDays: 45 }));
    expect(response.status).toBe(200);
    expect(mocks.settings.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ invoiceDueDays: 45 }) }));
    // A plain due-days save never writes the family billing mode.
    expect(mocks.settings.upsert.mock.calls[0][0].update.familyBillingMode).toBeUndefined();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "membership-subscription-billing.settings.update" }), expect.anything());
  });

  it("defaults the family billing mode in the preview settings", async () => {
    const response = await GET(new NextRequest("http://localhost/api/admin/subscription-billing?seasonYear=2026&decisionDate=2026-07-13"));
    await expect(response.json()).resolves.toMatchObject({ settings: { familyBillingMode: "BILL_FAMILY_VIA_BILLING_MEMBER" } });
  });

  it("persists and audits the family billing mode when provided", async () => {
    const response = await POST(request({ action: "UPDATE_SETTINGS", invoiceDueDays: 30, familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY" }));
    expect(response.status).toBe(200);
    expect(mocks.settings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ invoiceDueDays: 30, familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY" }),
      create: expect.objectContaining({ id: "default", familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY" }),
    }));
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ details: JSON.stringify({ invoiceDueDays: 30, familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY" }) }),
      expect.anything(),
    );
  });

  it("rejects an invalid family billing mode", async () => {
    const response = await POST(request({ action: "UPDATE_SETTINGS", invoiceDueDays: 30, familyBillingMode: "NONSENSE" }));
    expect(response.status).toBe(400);
    expect(mocks.settings.upsert).not.toHaveBeenCalled();
  });

  it("queues email/invoice retry without creating provider work inline", async () => {
    const response = await POST(request({ action: "RETRY_CHARGE", chargeId: "charge-1" }));
    expect(response.status).toBe(200);
    expect(mocks.enqueue).toHaveBeenCalledWith("charge-1", { createdByMemberId: "admin-1" });
  });

  it("does not return unexpected provider queue details from a billing action", async () => {
    mocks.enqueue.mockRejectedValueOnce(
      new Error("Xero tenant secret-tenant-id rejected the invoice")
    );
    const response = await POST(
      request({ action: "RETRY_CHARGE", chargeId: "charge-1" })
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Subscription billing action failed.",
    });
  });

  it("returns the guard response before reading any billing data", async () => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) });
    const response = await GET(new NextRequest("http://localhost/api/admin/subscription-billing"));
    expect(response.status).toBe(403);
    expect(mocks.buildPreview).not.toHaveBeenCalled();
  });

  // #2148 (D2 / constraint 3): the read-only GET must never reconcile.
  it("the finance-view GET never reconciles (no mutation)", async () => {
    const response = await GET(new NextRequest("http://localhost/api/admin/subscription-billing?seasonYear=2026&decisionDate=2026-07-13"));
    expect(response.status).toBe(200);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it("REFRESH_PREVIEW is finance-edit gated, reconciles, and returns the refreshed billing data", async () => {
    mocks.reconcile.mockResolvedValue({ resolvedCount: 3 });
    const response = await POST(request({ action: "REFRESH_PREVIEW", seasonYear: 2026, decisionDate: "2026-07-13" }));
    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });
    expect(mocks.reconcile).toHaveBeenCalledWith({ seasonYear: 2026, decisionDate: expect.any(Date) });
    const body = await response.json();
    expect(body).toMatchObject({ success: true, reconciledCount: 3, preview, settings: { invoiceDueDays: 30 } });
    // Audits the reconciliation when it resolved rows.
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "membership-subscription-billing.reconcile" }),
    );
  });

  it("REFRESH_PREVIEW skips the audit log when nothing was reconciled", async () => {
    mocks.reconcile.mockResolvedValue({ resolvedCount: 0 });
    const response = await POST(request({ action: "REFRESH_PREVIEW", seasonYear: 2026, decisionDate: "2026-07-13" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, reconciledCount: 0 });
    expect(mocks.audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "membership-subscription-billing.reconcile" }),
    );
  });

  it("REFRESH_PREVIEW rejects a malformed decision date", async () => {
    const response = await POST(request({ action: "REFRESH_PREVIEW", seasonYear: 2026, decisionDate: "13-07-2026" }));
    expect(response.status).toBe(400);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  // #2161 (D2): mark/unmark family invoice markers.
  it("MARK_FAMILY_INVOICED is finance-edit gated, creates a marker, and audits", async () => {
    const response = await POST(request({ action: "MARK_FAMILY_INVOICED", seasonYear: 2026, familyGroupId: "family-1", note: "  INV-9  " }));
    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });
    // The note is trimmed before persistence.
    expect(mocks.familyMarker.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ familyGroupId: "family-1", seasonYear: 2026, note: "INV-9", markedByMemberId: "admin-1" }),
    }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "membership-subscription-billing.mark-family" }));
  });

  it("MARK_FAMILY_INVOICED is idempotent — an already-active marker is a no-op success (no create, no audit)", async () => {
    mocks.familyMarker.findFirst.mockResolvedValue({ id: "existing-marker" });
    const response = await POST(request({ action: "MARK_FAMILY_INVOICED", seasonYear: 2026, familyGroupId: "family-1" }));
    expect(response.status).toBe(200);
    expect(mocks.familyMarker.create).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "membership-subscription-billing.mark-family" }));
  });

  it("MARK_FAMILY_INVOICED returns 404 for an unknown family group", async () => {
    mocks.familyGroup.findUnique.mockResolvedValue(null);
    const response = await POST(request({ action: "MARK_FAMILY_INVOICED", seasonYear: 2026, familyGroupId: "ghost" }));
    expect(response.status).toBe(404);
    expect(mocks.familyMarker.create).not.toHaveBeenCalled();
  });

  it("UNMARK_FAMILY_INVOICED releases the active marker and audits", async () => {
    const response = await POST(request({ action: "UNMARK_FAMILY_INVOICED", seasonYear: 2026, familyGroupId: "family-1" }));
    expect(response.status).toBe(200);
    expect(mocks.familyMarker.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { familyGroupId: "family-1", seasonYear: 2026, releasedAt: null },
      data: expect.objectContaining({ releasedByMemberId: "admin-1" }),
    }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "membership-subscription-billing.unmark-family" }));
  });

  it("UNMARK_FAMILY_INVOICED is idempotent — releasing an unmarked family is a no-op success (no audit)", async () => {
    mocks.familyMarker.updateMany.mockResolvedValue({ count: 0 });
    const response = await POST(request({ action: "UNMARK_FAMILY_INVOICED", seasonYear: 2026, familyGroupId: "family-1" }));
    expect(response.status).toBe(200);
    expect(mocks.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "membership-subscription-billing.unmark-family" }));
  });

  it("mark/unmark require the edit guard — a denied guard blocks the write", async () => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) });
    const response = await POST(request({ action: "MARK_FAMILY_INVOICED", seasonYear: 2026, familyGroupId: "family-1" }));
    expect(response.status).toBe(403);
    expect(mocks.familyGroup.findUnique).not.toHaveBeenCalled();
    expect(mocks.familyMarker.create).not.toHaveBeenCalled();
  });
});

/*
  CT-4 (#2870), epic #2988 — the default decision date is the CLUB's day.

  Omit `?decisionDate=` and the billing preview is dated "today". Which today
  that is decides which members are already covered, which are due, and
  therefore what a treasurer is about to invoice — so it is a business decision,
  and `INV-CONFIG-002` says a business decision reads the persisted
  `ClubTimeSettings.timeZone` rather than the container's `TZ`.

  The value's SHAPE matters as much as its day. An explicit `?decisionDate=` is
  parsed to a date-only value at UTC midnight, and the default has to be the same
  kind of thing: the billing engine and the `@db.Date` columns it compares
  against both hold UTC midnight as the encoding of a calendar day
  (`INV-DATE-010`). A club-midnight instant would be the previous day once
  narrowed — that is `INV-DATE-026`'s corollary, which is the rule for a bound
  against one of these columns.
*/
describe("subscription billing — the default decision date is the club's day (CT-4, #2870)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.buildPreview.mockResolvedValue(preview);
    mocks.charges.findMany.mockResolvedValue([]);
    mocks.exceptions.findMany.mockResolvedValue([]);
    mocks.settings.findUnique.mockResolvedValue(null);
    mocks.clubTimeSettings.findUnique.mockResolvedValue({
      timeZone: "America/Denver",
      updatedByMemberId: null,
      updatedAt: new Date(0),
    });
  });

  it("defaults to the club's calendar day, encoded as UTC midnight", async () => {
    // The premise, measured as an ANSWER rather than as a zone identifier. What
    // has to hold for the assertion below to discriminate is that the
    // ENVIRONMENT authority names a different day; comparing the two zone NAMES
    // does not establish that, because two different names can agree
    // (`America/Chicago` gives Denver's answer at this instant) and the check
    // would then pass while the assertion went vacuous.
    const { getTodayDateOnly } = await import("@/lib/date-only");
    expect(
      getTodayDateOnly(APP_TIME_ZONE).toISOString(),
      "INV-CONFIG-002: the environment authority now names the same day as the " +
        "persisted club zone, so this default cannot tell which of the two " +
        "produced it. Pick a persisted zone the environment disagrees with.",
    ).not.toBe("2026-06-30T00:00:00.000Z");

    const response = await GET(
      new NextRequest("http://localhost/api/admin/subscription-billing?seasonYear=2026"),
    );
    expect(response.status).toBe(200);

    // The suite runs on the repository's frozen clock, 2026-07-01T00:00:00Z.
    // That is midday on 1 July in New Zealand and still the evening of 30 JUNE
    // in Denver, so the two candidate authorities name different days — which
    // is what makes this assertion worth making.
    const { decisionDate } = mocks.buildPreview.mock.calls[0][0] as {
      decisionDate: Date;
    };
    expect(decisionDate.toISOString()).toBe("2026-06-30T00:00:00.000Z");
  });

  it("leaves an explicitly supplied decision date alone", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/admin/subscription-billing?seasonYear=2026&decisionDate=2026-07-13",
      ),
    );
    expect(response.status).toBe(200);

    const { decisionDate } = mocks.buildPreview.mock.calls[0][0] as {
      decisionDate: Date;
    };
    expect(decisionDate.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });
});
