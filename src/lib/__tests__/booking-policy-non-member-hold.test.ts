import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  logAudit: vi.fn(),
  transaction: vi.fn(),
  cancellationFindMany: vi.fn(),
  cancellationDeleteMany: vi.fn(),
  cancellationCreateMany: vi.fn(),
  defaultsFindUnique: vi.fn(),
  defaultsUpsert: vi.fn(),
  periodFindMany: vi.fn(),
  periodFindUnique: vi.fn(),
  periodCreate: vi.fn(),
  periodUpdate: vi.fn(),
  periodDelete: vi.fn(),
  revalidatePublicPageContent: vi.fn(),
  hasAdminAreaAccess: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => h.requireAdmin(...args),
}));

// #3639 review F2: the late-capture refund choice needs finance:edit as well.
vi.mock("@/lib/admin-permissions", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/admin-permissions")),
  hasAdminAreaAccess: (...args: unknown[]) => h.hasAdminAreaAccess(...args),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => h.logAudit(...args),
}));

vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: (...args: unknown[]) =>
    h.revalidatePublicPageContent(...args),
}));

const tx = {
  cancellationPolicy: {
    deleteMany: (...args: unknown[]) => h.cancellationDeleteMany(...args),
    createMany: (...args: unknown[]) => h.cancellationCreateMany(...args),
    findMany: (...args: unknown[]) => h.cancellationFindMany(...args),
  },
  bookingDefaults: {
    findUnique: (...args: unknown[]) => h.defaultsFindUnique(...args),
    upsert: (...args: unknown[]) => h.defaultsUpsert(...args),
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => h.transaction(...args),
    cancellationPolicy: {
      findMany: (...args: unknown[]) => h.cancellationFindMany(...args),
      deleteMany: (...args: unknown[]) => h.cancellationDeleteMany(...args),
      createMany: (...args: unknown[]) => h.cancellationCreateMany(...args),
    },
    bookingDefaults: {
      findUnique: (...args: unknown[]) => h.defaultsFindUnique(...args),
      upsert: (...args: unknown[]) => h.defaultsUpsert(...args),
    },
    bookingPeriod: {
      findMany: (...args: unknown[]) => h.periodFindMany(...args),
      findUnique: (...args: unknown[]) => h.periodFindUnique(...args),
      create: (...args: unknown[]) => h.periodCreate(...args),
      update: (...args: unknown[]) => h.periodUpdate(...args),
      delete: (...args: unknown[]) => h.periodDelete(...args),
    },
  },
}));

import {
  GET as getDefaultPolicy,
  PUT as putDefaultPolicy,
} from "@/app/api/admin/booking-policies/cancellation/route";
import {
  POST as createPeriod,
} from "@/app/api/admin/booking-policies/periods/route";
import {
  PUT as updatePeriod,
} from "@/app/api/admin/booking-policies/periods/[id]/route";

function request(url: string, body: Record<string, unknown>) {
  return new NextRequest(url, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const rules = [
  {
    daysBeforeStay: 14,
    refundPercentage: 100,
    creditRefundPercentage: 100,
    fixedFeeCents: 0,
    creditFixedFeeCents: 0,
  },
];

describe("non-member hold policy admin API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    h.hasAdminAreaAccess.mockReturnValue(true);
    h.transaction.mockImplementation((fn: (store: typeof tx) => Promise<unknown>) =>
      fn(tx)
    );
    h.cancellationFindMany.mockResolvedValue(rules);
    h.cancellationDeleteMany.mockResolvedValue({ count: 1 });
    h.cancellationCreateMany.mockResolvedValue({ count: 1 });
    h.defaultsFindUnique.mockResolvedValue({
      id: "default",
      nonMemberHoldEnabled: false,
      nonMemberHoldDays: 14,
    });
    h.defaultsUpsert.mockResolvedValue({
      id: "default",
      nonMemberHoldEnabled: false,
      nonMemberHoldDays: 365,
    });
  });

  it("returns the default enabled flag with the hold threshold", async () => {
    const res = await getDefaultPolicy(
      new NextRequest("http://localhost/api/admin/booking-policies/cancellation"),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      nonMemberHoldEnabled: false,
      nonMemberHoldDays: 14,
    });
  });

  it("updates the default enabled flag without dropping the stored threshold", async () => {
    const res = await putDefaultPolicy(
      request("https://example.test/api/admin/booking-policies/cancellation", {
        rules,
        nonMemberHoldEnabled: false,
        nonMemberHoldDays: 365,
      })
    );

    expect(res.status).toBe(200);
    expect(h.defaultsUpsert).toHaveBeenCalledWith({
      where: { id: "default" },
      update: { nonMemberHoldEnabled: false, nonMemberHoldDays: 365 },
      create: {
        id: "default",
        nonMemberHoldEnabled: false,
        nonMemberHoldDays: 365,
      },
    });
    expect(h.revalidatePublicPageContent).toHaveBeenCalledOnce();
  });

  describe("the late-payment refund setting (#3639, owner decision 26 Sep 2026)", () => {
    it("reads 'refund automatically' for a club that never saved it", async () => {
      const res = await getDefaultPolicy(
        new NextRequest("http://localhost/api/admin/booking-policies/cancellation"),
      );
      await expect(res.json()).resolves.toMatchObject({
        lateCaptureRefundNeedsApproval: false,
      });
    });

    it("stores treasurer approval, and audits the change", async () => {
      const res = await putDefaultPolicy(
        request("https://example.test/api/admin/booking-policies/cancellation", {
          rules,
          lateCaptureRefundNeedsApproval: true,
        }),
      );

      expect(res.status).toBe(200);
      expect(h.defaultsUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: { lateCaptureRefundNeedsApproval: true },
          create: expect.objectContaining({ lateCaptureRefundNeedsApproval: true }),
        }),
      );
      expect(h.logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.stringContaining("lateCaptureNeedsApproval=true"),
        }),
      );
    });

    it("writes its own payment-category audit entry for the switch, with before and after", async () => {
      await putDefaultPolicy(
        request("https://example.test/api/admin/booking-policies/cancellation", {
          rules,
          lateCaptureRefundNeedsApproval: true,
        }),
      );
      expect(h.logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking-defaults.late_capture_refund_approval.changed",
          category: "payment",
          severity: "important",
          details: JSON.stringify({ before: "refund_automatically", after: "treasurer_approves" }),
        }),
      );
      expect(h.hasAdminAreaAccess).toHaveBeenCalledWith(
        expect.anything(),
        { area: "finance", level: "edit" },
      );
    });

    it("refuses a bookings-only officer who tries to CHANGE it, and writes nothing (review F2)", async () => {
      h.hasAdminAreaAccess.mockReturnValue(false);

      const res = await putDefaultPolicy(
        request("https://example.test/api/admin/booking-policies/cancellation", {
          rules,
          lateCaptureRefundNeedsApproval: true,
        }),
      );

      expect(res.status).toBe(403);
      expect(h.transaction).not.toHaveBeenCalled();
      expect(h.logAudit).not.toHaveBeenCalled();
    });

    it("lets a bookings-only officer save the page when the stored answer is re-sent unchanged", async () => {
      h.hasAdminAreaAccess.mockReturnValue(false);
      h.defaultsFindUnique.mockResolvedValue({
        id: "default",
        nonMemberHoldEnabled: false,
        nonMemberHoldDays: 14,
        lateCaptureRefundNeedsApproval: true,
      });

      const res = await putDefaultPolicy(
        request("https://example.test/api/admin/booking-policies/cancellation", {
          rules,
          lateCaptureRefundNeedsApproval: true,
        }),
      );

      expect(res.status).toBe(200);
      expect(h.logAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "booking-defaults.late_capture_refund_approval.changed" }),
      );
    });

    it("leaves the stored answer alone on a save that does not mention it", async () => {
      await putDefaultPolicy(
        request("https://example.test/api/admin/booking-policies/cancellation", {
          rules,
          nonMemberHoldDays: 30,
        }),
      );
      const [upsert] = h.defaultsUpsert.mock.calls[0];
      expect(upsert.update).not.toHaveProperty("lateCaptureRefundNeedsApproval");
      expect(upsert.create).not.toHaveProperty("lateCaptureRefundNeedsApproval");
    });

    it("refuses it per lodge: it is how the club handles money", async () => {
      const res = await putDefaultPolicy(
        request("https://example.test/api/admin/booking-policies/cancellation", {
          rules,
          lodgeId: "lodge-1",
          lateCaptureRefundNeedsApproval: true,
        }),
      );
      expect(res.status).toBe(400);
      expect(h.transaction).not.toHaveBeenCalled();
    });
  });

  it("does not invalidate public content when the default policy update is rejected", async () => {
    const res = await putDefaultPolicy(
      request("https://example.test/api/admin/booking-policies/cancellation", {
        rules: [],
      })
    );

    expect(res.status).toBe(400);
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.revalidatePublicPageContent).not.toHaveBeenCalled();
  });

  it("creates a date-specific period with an independent enabled flag", async () => {
    h.periodCreate.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "period-1", ...args.data })
    );

    const res = await createPeriod(
      request("https://example.test/api/admin/booking-policies/periods", {
        name: "School Holidays",
        startDate: "2026-07-01",
        endDate: "2026-07-20",
        nonMemberHoldEnabled: false,
        nonMemberHoldDays: 365,
        cancellationRules: rules,
      })
    );

    expect(res.status).toBe(201);
    expect(h.periodCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nonMemberHoldEnabled: false,
          nonMemberHoldDays: 365,
        }),
      })
    );
  });

  it("updates a period with 365 hold days and the enabled flag", async () => {
    h.periodFindUnique.mockResolvedValue({
      id: "period-1",
      name: "School Holidays",
      startDate: new Date("2026-07-01"),
      endDate: new Date("2026-07-20"),
      nonMemberHoldEnabled: true,
      nonMemberHoldDays: 7,
      cancellationRules: rules,
      active: true,
    });
    h.periodUpdate.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "period-1", ...args.data })
    );

    const res = await updatePeriod(
      request("https://example.test/api/admin/booking-policies/periods/period-1", {
        nonMemberHoldEnabled: false,
        nonMemberHoldDays: 365,
      }),
      { params: Promise.resolve({ id: "period-1" }) }
    );

    expect(res.status).toBe(200);
    expect(h.periodUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nonMemberHoldEnabled: false,
          nonMemberHoldDays: 365,
        }),
      })
    );
  });
});
