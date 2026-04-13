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
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mockRequireActiveSessionUser,
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
}));
vi.mock("@/lib/xero-inbound-reconciliation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-inbound-reconciliation")>();

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
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mockRequireActiveSessionUser.mockResolvedValue(null);
  });

  it("lists inbound events with filter support and replay metadata", async () => {
    const createdAt = new Date("2026-04-14T09:00:00Z");
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
        updatedAt: createdAt,
      },
    ]);

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
      take: 25,
    });

    const body = await response.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({
      id: "evt_1",
      canReplay: true,
      xeroObjectUrl: "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv_1",
    });
    expect(body.data[1]).toMatchObject({
      id: "evt_2",
      canReplay: false,
      xeroObjectUrl: "https://go.xero.com/Contacts/View/contact_1",
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
      memberId: "admin-1",
      targetId: "evt_1",
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
