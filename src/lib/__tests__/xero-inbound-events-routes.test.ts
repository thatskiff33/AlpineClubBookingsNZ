import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockPrisma,
  mockAuth,
  mockRequireActiveSessionUser,
  mockLogAudit,
  mockReplayStoredXeroInboundEvent,
} = vi.hoisted(() => ({
  mockPrisma: {
    xeroInboundEvent: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    xeroObjectLink: {
      findMany: vi.fn(),
    },
  },
  mockAuth: vi.fn(),
  mockRequireActiveSessionUser: vi.fn(),
  mockLogAudit: vi.fn(),
  mockReplayStoredXeroInboundEvent: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mockRequireActiveSessionUser,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
}));
vi.mock("@/lib/xero-inbound-reconciliation", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-inbound-reconciliation");

  return {
    ...actual,
    replayStoredXeroInboundEvent: mockReplayStoredXeroInboundEvent,
  };
});
vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { GET as listInboundEvents } from "@/app/api/admin/xero/inbound-events/route";
import { POST as replayInboundEvent } from "@/app/api/admin/xero/inbound-events/[id]/replay/route";
import { XeroInboundReplayError } from "@/lib/xero-inbound-reconciliation";

describe("Xero inbound event admin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockRequireActiveSessionUser.mockResolvedValue(null);
    mockPrisma.xeroInboundEvent.count.mockResolvedValue(0);
    mockPrisma.xeroObjectLink.findMany.mockResolvedValue([]);
  });

  it("lists inbound events with filter support and replay metadata", async () => {
    const createdAt = new Date("2026-04-14T09:00:00Z");
    const staleUpdatedAt = new Date(Date.now() - 30 * 60_000);
    const freshUpdatedAt = new Date();
    mockPrisma.xeroInboundEvent.findMany.mockResolvedValue([
      {
        id: "evt_1",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "inv_1",
        eventCreatedAt: createdAt,
        correlationKey: "corr_1",
        payload: { resourceId: "inv_1" },
        status: "FAILED",
        errorMessage: "Still broken",
        processedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: "evt_stale",
        source: "webhook",
        eventCategory: "CONTACT",
        eventType: "UPDATE",
        resourceId: "contact_stale",
        eventCreatedAt: staleUpdatedAt,
        correlationKey: "corr_stale",
        payload: { resourceId: "contact_stale" },
        status: "PROCESSING",
        errorMessage: null,
        processedAt: null,
        createdAt: staleUpdatedAt,
        updatedAt: staleUpdatedAt,
      },
      {
        id: "evt_2",
        source: "webhook",
        eventCategory: "CONTACT",
        eventType: "UPDATE",
        resourceId: "contact_1",
        eventCreatedAt: createdAt,
        correlationKey: "corr_2",
        payload: { resourceId: "contact_1" },
        status: "PROCESSING",
        errorMessage: null,
        processedAt: null,
        createdAt,
        updatedAt: freshUpdatedAt,
      },
    ]);
    mockPrisma.xeroInboundEvent.count.mockResolvedValue(3);

    const response = await listInboundEvents(
      new NextRequest(
        "http://localhost/api/admin/xero/inbound-events?status=all&eventCategory=all&source=webhook&limit=25"
      )
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.xeroInboundEvent.findMany).toHaveBeenCalledWith({
      where: {
        source: "webhook",
      },
      orderBy: { createdAt: "desc" },
      skip: 0,
      take: 25,
    });

    const body = await response.json();
    expect(body.data).toHaveLength(3);
    expect(body.total).toBe(3);
    expect(body.data[0]).toMatchObject({
      id: "evt_1",
      canReplay: true,
      xeroObjectUrl: "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv_1",
    });
    expect(body.data[1]).toMatchObject({
      id: "evt_stale",
      canReplay: true,
      xeroObjectUrl: "https://go.xero.com/Contacts/View/contact_stale",
    });
    expect(body.data[2]).toMatchObject({
      id: "evt_2",
      canReplay: false,
      xeroObjectUrl: "https://go.xero.com/Contacts/View/contact_1",
    });
  });

  it("filters inbound events through local Xero object links", async () => {
    mockPrisma.xeroObjectLink.findMany.mockResolvedValue([
      {
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv_1",
      },
    ]);
    mockPrisma.xeroInboundEvent.findMany.mockResolvedValue([]);
    mockPrisma.xeroInboundEvent.count.mockResolvedValue(0);

    const response = await listInboundEvents(
      new NextRequest(
        "http://localhost/api/admin/xero/inbound-events?localModel=Payment&localId=pay_1&eventType=UPDATE&page=2&pageSize=10"
      )
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.xeroObjectLink.findMany).toHaveBeenCalledWith({
      where: {
        localModel: "Payment",
        localId: "pay_1",
        active: true,
      },
      select: {
        xeroObjectType: true,
        xeroObjectId: true,
      },
    });
    expect(mockPrisma.xeroInboundEvent.findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { eventType: "UPDATE" },
          { OR: [{ eventCategory: "INVOICE", resourceId: "inv_1" }] },
        ],
      },
      orderBy: { createdAt: "desc" },
      skip: 10,
      take: 10,
    });
  });

  it("replays a stored inbound event and records an audit entry", async () => {
    mockReplayStoredXeroInboundEvent.mockResolvedValue({
      result: {
        found: 1,
        processed: 1,
        succeeded: 1,
        failed: 0,
        skipped: 0,
      },
      event: {
        id: "evt_1",
        status: "PROCESSED",
        errorMessage: null,
        processedAt: new Date("2026-04-14T09:10:00Z"),
      },
    });

    const response = await replayInboundEvent(new NextRequest("http://localhost"), {
      params: Promise.resolve({ id: "evt_1" }),
    });

    expect(response.status).toBe(200);
    expect(mockReplayStoredXeroInboundEvent).toHaveBeenCalledWith("evt_1");
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: "XERO_INBOUND_EVENT_REPLAY",
      category: "xero",
      memberId: "admin-1",
      targetId: "evt_1",
      entityType: "XeroInboundEvent",
      entityId: "evt_1",
      details: "status=PROCESSED",
    });

    const body = await response.json();
    expect(body.message).toBe("Xero inbound event replayed.");
    expect(body.replay.result.succeeded).toBe(1);
  });

  it("returns the replay error status when replay is rejected", async () => {
    mockReplayStoredXeroInboundEvent.mockRejectedValue(
      new XeroInboundReplayError("This inbound event is already being processed.", 409)
    );

    const response = await replayInboundEvent(new NextRequest("http://localhost"), {
      params: Promise.resolve({ id: "evt_busy" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This inbound event is already being processed.",
    });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
