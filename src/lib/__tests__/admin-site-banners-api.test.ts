import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  siteBannerFindMany: vi.fn(),
  siteBannerFindUnique: vi.fn(),
  siteBannerCreate: vi.fn(),
  siteBannerUpdate: vi.fn(),
  siteBannerDelete: vi.fn(),
  auditLogCreate: vi.fn(),
  transaction: vi.fn(),
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditRequestContext: vi.fn(() => ({
    id: "req-1",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  })),
  invalidatePublicLayoutConfig: vi.fn(),
  revalidatePublicSite: vi.fn(),
}));

vi.mock("@/lib/public-layout-cache", () => ({
  PUBLIC_LAYOUT_CACHE_TAGS: { banners: "public-layout:banners" },
  invalidatePublicLayoutConfig: mocks.invalidatePublicLayoutConfig,
}));

// #2352 F3: banners are rendered INTO the public layout, so the route now clears
// the full-route ISR store as well as the tagged data caches. Stubbed because
// `revalidatePath` needs a static-generation store that no unit test has.
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicSite: mocks.revalidatePublicSite,
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: mocks.buildStructuredAuditLogCreateArgs,
  getAuditRequestContext: mocks.getAuditRequestContext,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    siteBanner: {
      findMany: mocks.siteBannerFindMany,
      findUnique: mocks.siteBannerFindUnique,
      create: mocks.siteBannerCreate,
      update: mocks.siteBannerUpdate,
      delete: mocks.siteBannerDelete,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
    $transaction: mocks.transaction,
  },
}));

import {
  GET as getSiteBanners,
  POST as createSiteBanner,
} from "@/app/api/admin/site-banners/route";
import {
  DELETE as deleteSiteBanner,
  PATCH as updateSiteBanner,
} from "@/app/api/admin/site-banners/[id]/route";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};
const memberSession = {
  user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};

function bannerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "banner-1",
    message: "Mountain closed",
    priority: "URGENT",
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    endDate: new Date("2026-07-10T00:00:00.000Z"),
    active: true,
    createdByMemberId: "admin-1",
    updatedByMemberId: "admin-1",
    createdAt: new Date("2026-06-30T01:00:00.000Z"),
    updatedAt: new Date("2026-06-30T02:00:00.000Z"),
    ...overrides,
  };
}

function request(url: string, body: unknown, method = "POST") {
  return new NextRequest(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-request-id": "req-1",
      "user-agent": "vitest",
    },
    body: JSON.stringify(body),
  });
}

function deleteRequest(url: string) {
  return new NextRequest(url, {
    method: "DELETE",
    headers: {
      "x-request-id": "req-1",
      "user-agent": "vitest",
    },
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

const validCreateBody = {
  message: "Mountain closed",
  priority: "URGENT",
  startDate: "2026-07-01",
  endDate: "2026-07-10",
  active: true,
};

describe("Admin site banners API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.siteBannerFindMany.mockResolvedValue([]);
    mocks.siteBannerFindUnique.mockResolvedValue(bannerRow());
    mocks.siteBannerCreate.mockImplementation(async ({ data }) =>
      bannerRow(data),
    );
    mocks.siteBannerUpdate.mockImplementation(async ({ data }) =>
      bannerRow(data),
    );
    mocks.siteBannerDelete.mockResolvedValue(bannerRow());
    mocks.auditLogCreate.mockResolvedValue({});
    // Interactive transaction: run the callback against the mocked models.
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        siteBanner: {
          create: mocks.siteBannerCreate,
          update: mocks.siteBannerUpdate,
          delete: mocks.siteBannerDelete,
        },
        auditLog: {
          create: mocks.auditLogCreate,
        },
      }),
    );
  });

  describe("auth gating", () => {
    it("rejects unauthenticated list requests", async () => {
      mocks.auth.mockResolvedValue(null);

      const response = await getSiteBanners(new Request("http://localhost/api/admin/site-banners"));

      expect(response.status).toBe(401);
      expect(mocks.siteBannerFindMany).not.toHaveBeenCalled();
    });

    it("rejects non-admin list requests", async () => {
      mocks.auth.mockResolvedValue(memberSession);

      const response = await getSiteBanners(new Request("http://localhost/api/admin/site-banners"));

      expect(response.status).toBe(403);
      expect(mocks.siteBannerFindMany).not.toHaveBeenCalled();
    });

    it("rejects non-admin create requests", async () => {
      mocks.auth.mockResolvedValue(memberSession);

      const response = await createSiteBanner(
        request("http://localhost/api/admin/site-banners", validCreateBody),
      );

      expect(response.status).toBe(403);
      expect(mocks.siteBannerCreate).not.toHaveBeenCalled();
    });

    it("rejects non-admin update requests", async () => {
      mocks.auth.mockResolvedValue(memberSession);

      const response = await updateSiteBanner(
        request(
          "http://localhost/api/admin/site-banners/banner-1",
          { active: false },
          "PATCH",
        ),
        params("banner-1"),
      );

      expect(response.status).toBe(403);
      expect(mocks.siteBannerUpdate).not.toHaveBeenCalled();
    });

    it("rejects non-admin delete requests", async () => {
      mocks.auth.mockResolvedValue(memberSession);

      const response = await deleteSiteBanner(
        deleteRequest("http://localhost/api/admin/site-banners/banner-1"),
        params("banner-1"),
      );

      expect(response.status).toBe(403);
      expect(mocks.siteBannerDelete).not.toHaveBeenCalled();
    });
  });

  describe("validation", () => {
    it("rejects malformed date strings", async () => {
      const response = await createSiteBanner(
        request("http://localhost/api/admin/site-banners", {
          ...validCreateBody,
          startDate: "01/07/2026",
        }),
      );

      expect(response.status).toBe(400);
      expect(mocks.siteBannerCreate).not.toHaveBeenCalled();
    });

    it("rejects an end date before the start date", async () => {
      const response = await createSiteBanner(
        request("http://localhost/api/admin/site-banners", {
          ...validCreateBody,
          startDate: "2026-07-10",
          endDate: "2026-07-01",
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("End date must be on or after the start date");
      expect(mocks.siteBannerCreate).not.toHaveBeenCalled();
    });

    it("rejects unknown fields (strict schema)", async () => {
      const response = await createSiteBanner(
        request("http://localhost/api/admin/site-banners", {
          ...validCreateBody,
          linkUrl: "https://example.com",
        }),
      );

      expect(response.status).toBe(400);
      expect(mocks.siteBannerCreate).not.toHaveBeenCalled();
    });

    it("rejects messages longer than 500 characters", async () => {
      const response = await createSiteBanner(
        request("http://localhost/api/admin/site-banners", {
          ...validCreateBody,
          message: "x".repeat(501),
        }),
      );

      expect(response.status).toBe(400);
      expect(mocks.siteBannerCreate).not.toHaveBeenCalled();
    });

    it("rejects a patch that inverts the merged date window", async () => {
      // Existing banner runs 2026-07-01..2026-07-10; moving the end before
      // the untouched start must fail against the merged values.
      const response = await updateSiteBanner(
        request(
          "http://localhost/api/admin/site-banners/banner-1",
          { endDate: "2026-06-30" },
          "PATCH",
        ),
        params("banner-1"),
      );

      expect(response.status).toBe(400);
      expect(mocks.siteBannerUpdate).not.toHaveBeenCalled();
    });
  });

  describe("happy paths", () => {
    it("creates a banner and writes a structured audit log", async () => {
      const response = await createSiteBanner(
        request("http://localhost/api/admin/site-banners", validCreateBody),
      );
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(mocks.revalidatePublicSite).toHaveBeenCalledWith(
        "public-layout:banners",
      );
      expect(mocks.siteBannerCreate).toHaveBeenCalledWith({
        data: {
          message: "Mountain closed",
          priority: "URGENT",
          startDate: new Date("2026-07-01T00:00:00.000Z"),
          endDate: new Date("2026-07-10T00:00:00.000Z"),
          active: true,
          createdByMemberId: "admin-1",
          updatedByMemberId: "admin-1",
        },
      });
      expect(mocks.auditLogCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "SITE_BANNER_CREATED",
          actor: { memberId: "admin-1" },
        }),
      });
      expect(body.banner).toMatchObject({
        message: "Mountain closed",
        priority: "URGENT",
        startDate: "2026-07-01",
        endDate: "2026-07-10",
        active: true,
      });
    });

    it("updates a banner and records before/after audit metadata", async () => {
      const response = await updateSiteBanner(
        request(
          "http://localhost/api/admin/site-banners/banner-1",
          { message: "Mountain reopened", priority: "NOTIFY" },
          "PATCH",
        ),
        params("banner-1"),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mocks.revalidatePublicSite).toHaveBeenCalledWith(
        "public-layout:banners",
      );
      expect(mocks.siteBannerUpdate).toHaveBeenCalledWith({
        where: { id: "banner-1" },
        data: {
          message: "Mountain reopened",
          priority: "NOTIFY",
          updatedByMemberId: "admin-1",
        },
      });
      expect(mocks.auditLogCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "SITE_BANNER_UPDATED",
          metadata: expect.objectContaining({
            before: expect.objectContaining({
              message: "Mountain closed",
              priority: "URGENT",
            }),
            after: expect.objectContaining({
              message: "Mountain reopened",
              priority: "NOTIFY",
            }),
          }),
        }),
      });
      expect(body.banner).toMatchObject({
        message: "Mountain reopened",
        priority: "NOTIFY",
      });
    });

    it("returns 404 when patching a missing banner", async () => {
      mocks.siteBannerFindUnique.mockResolvedValue(null);

      const response = await updateSiteBanner(
        request(
          "http://localhost/api/admin/site-banners/missing",
          { active: false },
          "PATCH",
        ),
        params("missing"),
      );

      expect(response.status).toBe(404);
      expect(mocks.siteBannerUpdate).not.toHaveBeenCalled();
    });

    it("deletes a banner and writes a structured audit log", async () => {
      const response = await deleteSiteBanner(
        deleteRequest("http://localhost/api/admin/site-banners/banner-1"),
        params("banner-1"),
      );

      expect(response.status).toBe(200);
      expect(mocks.revalidatePublicSite).toHaveBeenCalledWith(
        "public-layout:banners",
      );
      expect(mocks.siteBannerDelete).toHaveBeenCalledWith({
        where: { id: "banner-1" },
      });
      expect(mocks.auditLogCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "SITE_BANNER_DELETED",
          metadata: expect.objectContaining({
            before: expect.objectContaining({ message: "Mountain closed" }),
          }),
        }),
      });
    });

    it("returns 404 when deleting a missing banner", async () => {
      mocks.siteBannerFindUnique.mockResolvedValue(null);

      const response = await deleteSiteBanner(
        deleteRequest("http://localhost/api/admin/site-banners/missing"),
        params("missing"),
      );

      expect(response.status).toBe(404);
      expect(mocks.siteBannerDelete).not.toHaveBeenCalled();
    });

    it("lists banner groups for admins", async () => {
      const response = await getSiteBanners(new Request("http://localhost/api/admin/site-banners"));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ current: [], upcoming: [], past: [] });
    });
  });
});
