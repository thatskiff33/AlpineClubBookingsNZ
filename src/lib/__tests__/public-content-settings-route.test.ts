import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const values = { requireAdmin: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), auditCreate: vi.fn(), revalidatePath: vi.fn() };
  const prisma = {
    publicContentSettings: { findUnique: values.findUnique, upsert: values.upsert },
    pageContent: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    auditLog: { create: values.auditCreate },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
  return { ...values, prisma };
});
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: (value: unknown) => value,
  getAuditRequestContext: () => ({}),
}));

import { Prisma } from "@prisma/client";
import { DEFAULT_PUBLIC_CONTENT_SETTINGS } from "@/config/club-settings-defaults";
import { GET, PUT } from "@/app/api/admin/public-content-settings/route";

const existing = {
  id: "default", membershipTypes: true, entranceFees: false, hutFees: true,
  bookingPolicySummary: false, cancellationPolicy: true, annualFees: true,
  showBookNow: true, bookNowTarget: "BOOKING_FLOW" as const, bookNowPageId: null,
  committeePhotoDisplay: "NONE" as const,
  updatedByMemberId: "admin-0", createdAt: new Date(), updatedAt: new Date(),
};

describe("public content settings route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
    mocks.findUnique.mockResolvedValue(existing);
    mocks.upsert.mockResolvedValue(existing);
  });

  it("serializes an existing Prisma row without leaking metadata", async () => {
    const response = await GET();
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "content", level: "view" } });
    expect(await response.json()).toEqual({ settings: {
      membershipTypes: true, entranceFees: false, hutFees: true,
      bookingPolicySummary: false, cancellationPolicy: true, annualFees: true,
      showBookNow: true, bookNowTarget: "BOOKING_FLOW", bookNowPageId: null,
      committeePhotoDisplay: "NONE",
    }, pages: [] });
  });

  // #2430: a club that has never saved the singleton sees the shipped default,
  // which now hides the public Book Now button. The panel must show the SAME
  // "unsaved" state the website renders, so it reads the one shared constant
  // rather than a second hand-written copy.
  it("synthesises the shared shipped defaults when no row is saved", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await GET();
    const body = (await response.json()) as {
      settings: Record<string, unknown>;
    };
    expect(body.settings).toEqual({
      ...DEFAULT_PUBLIC_CONTENT_SETTINGS,
      bookNowTarget: "BOOKING_FLOW",
      bookNowPageId: null,
    });
    expect(body.settings.showBookNow).toBe(false);
  });

  // The other half: the panel reports the stored value verbatim in both
  // directions and never re-derives it from the shipped default.
  //
  // Deliberately NOT a claim that an existing club keeps its saved choice
  // across the upgrade — the owner reversed that on PR #2466 (1 Aug 2026), and
  // 20260802100000_public_book_now_default_off writes false over every stored
  // row. This asserts only that whatever the column holds afterwards is what
  // the admin panel shows.
  it("returns a saved showBookNow choice unchanged in both directions", async () => {
    mocks.findUnique.mockResolvedValue({ ...existing, showBookNow: false });
    const off = (await (await GET()).json()) as { settings: { showBookNow: boolean } };
    expect(off.settings.showBookNow).toBe(false);

    mocks.findUnique.mockResolvedValue({ ...existing, showBookNow: true });
    const on = (await (await GET()).json()) as { settings: { showBookNow: boolean } };
    expect(on.settings.showBookNow).toBe(true);
  });

  it("audits writes and invalidates public routes", async () => {
    const body = { membershipTypes: true, entranceFees: false, hutFees: true, bookingPolicySummary: false, cancellationPolicy: true, annualFees: true, showBookNow: true, bookNowTarget: "BOOKING_FLOW", bookNowPageId: null, committeePhotoDisplay: "NONE" };
    const response = await PUT(new Request("http://localhost/api/admin/public-content-settings", { method: "PUT", body: JSON.stringify(body) }));
    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "content", level: "edit" } });
    expect(mocks.auditCreate).toHaveBeenCalledOnce();
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  // #3852: the published-page check runs before the transaction, so a page
  // deleted in between reaches the upsert as a foreign-key failure. That is the
  // same "not available" answer the check gives, not a 500.
  it("answers 400, not 500, when the chosen Book Now page is deleted mid-save", async () => {
    mocks.prisma.pageContent.findUnique.mockResolvedValue({ published: true });
    mocks.upsert.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Foreign key constraint violated", {
      code: "P2003", clientVersion: "test",
    }));
    const body = { membershipTypes: true, entranceFees: false, hutFees: true, bookingPolicySummary: false, cancellationPolicy: true, annualFees: true, showBookNow: true, bookNowTarget: "PAGE", bookNowPageId: "page-1", committeePhotoDisplay: "NONE" };
    const response = await PUT(new Request("http://localhost/api/admin/public-content-settings", { method: "PUT", body: JSON.stringify(body) }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "The selected Book Now page is not published." });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("still lets any other save failure escape", async () => {
    mocks.upsert.mockRejectedValue(new Error("deadlock detected"));
    const body = { membershipTypes: true, entranceFees: false, hutFees: true, bookingPolicySummary: false, cancellationPolicy: true, annualFees: true, showBookNow: true, bookNowTarget: "BOOKING_FLOW", bookNowPageId: null, committeePhotoDisplay: "NONE" };
    await expect(PUT(new Request("http://localhost/api/admin/public-content-settings", { method: "PUT", body: JSON.stringify(body) }))).rejects.toThrow("deadlock detected");
  });
});
