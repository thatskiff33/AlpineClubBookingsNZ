import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inboundFindUnique: vi.fn(),
  inboundCreate: vi.fn(),
  inboundUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroInboundEvent: {
      findUnique: mocks.inboundFindUnique,
      create: mocks.inboundCreate,
      update: mocks.inboundUpdate,
    },
  },
}));

vi.mock("@/lib/xero-error-shape", () => ({
  getXeroErrorStatusCode: vi.fn(),
}));

vi.mock("@/lib/xero-links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-links")>();

  return {
    ...actual,
    buildXeroObjectUrl: vi.fn(),
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

import { recordXeroInboundEvent } from "@/lib/xero-sync";

describe("recordXeroInboundEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new inbound event when the correlation key is new", async () => {
    mocks.inboundFindUnique.mockResolvedValue(null);
    mocks.inboundCreate.mockResolvedValue({ id: "evt_1" });

    await recordXeroInboundEvent({
      correlationKey: "contact:update:abc",
      eventType: "UPDATE",
      eventCategory: "CONTACT",
      payload: { contactID: "abc" },
    });

    expect(mocks.inboundCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        correlationKey: "contact:update:abc",
        status: "RECEIVED",
        processedAt: null,
      }),
    });
    expect(mocks.inboundUpdate).not.toHaveBeenCalled();
  });

  it("preserves a processed inbound event when a duplicate delivery is recorded", async () => {
    const processedAt = new Date("2026-04-14T08:00:00.000Z");
    mocks.inboundFindUnique.mockResolvedValue({
      id: "evt_1",
      status: "PROCESSED",
      processedAt,
    });
    mocks.inboundUpdate.mockResolvedValue({ id: "evt_1" });

    await recordXeroInboundEvent({
      correlationKey: "contact:update:abc",
      eventType: "UPDATE",
      eventCategory: "CONTACT",
      payload: { contactID: "abc" },
      status: "RECEIVED",
    });

    expect(mocks.inboundUpdate).toHaveBeenCalledWith({
      where: {
        id: "evt_1",
      },
      data: expect.objectContaining({
        status: "PROCESSED",
        processedAt,
      }),
    });
  });
});
