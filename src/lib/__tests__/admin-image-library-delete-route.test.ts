import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  mediaImageFindUnique: vi.fn(),
  mediaImageDelete: vi.fn(),
  pageContentFindMany: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    mediaImage: {
      findUnique: mocks.mediaImageFindUnique,
      delete: mocks.mediaImageDelete,
    },
    pageContent: {
      findMany: mocks.pageContentFindMany,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
  },
}));

import { DELETE } from "@/app/api/admin/image-library/[id]/route";

const adminSession = { user: { id: "admin-1", role: "ADMIN" } };
const memberSession = { user: { id: "member-1", role: "MEMBER" } };

function deleteRequest(id: string) {
  return new NextRequest(`http://localhost/api/admin/image-library/${id}`, {
    method: "DELETE",
  });
}

describe("DELETE /api/admin/image-library/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.pageContentFindMany.mockResolvedValue([]);
    mocks.mediaImageDelete.mockResolvedValue({});
    mocks.auditLogCreate.mockResolvedValue({});
  });

  it("requires an admin session", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await DELETE(deleteRequest("img-1"), {
      params: Promise.resolve({ id: "img-1" }),
    });
    expect(response.status).toBe(401);
    expect(mocks.mediaImageDelete).not.toHaveBeenCalled();
  });

  it("rejects non-admin members", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const response = await DELETE(deleteRequest("img-1"), {
      params: Promise.resolve({ id: "img-1" }),
    });
    expect(response.status).toBe(403);
    expect(mocks.mediaImageDelete).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown image", async () => {
    mocks.mediaImageFindUnique.mockResolvedValue(null);

    const response = await DELETE(deleteRequest("missing"), {
      params: Promise.resolve({ id: "missing" }),
    });

    expect(response.status).toBe(404);
    expect(mocks.mediaImageDelete).not.toHaveBeenCalled();
  });

  it("deletes an image that is not referenced by any page", async () => {
    mocks.mediaImageFindUnique.mockResolvedValue({
      id: "img-1",
      filename: "photo.png",
    });
    mocks.pageContentFindMany.mockResolvedValue([]);

    const response = await DELETE(deleteRequest("img-1"), {
      params: Promise.resolve({ id: "img-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, referencedBySlugs: [] });
    expect(mocks.mediaImageDelete).toHaveBeenCalledWith({
      where: { id: "img-1" },
    });
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  it("permits deletion of a referenced image and reports which pages use it", async () => {
    mocks.mediaImageFindUnique.mockResolvedValue({
      id: "img-1",
      filename: "hero.jpg",
    });
    mocks.pageContentFindMany.mockResolvedValue([
      { slug: "home" },
      { slug: "about" },
    ]);

    const response = await DELETE(deleteRequest("img-1"), {
      params: Promise.resolve({ id: "img-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      referencedBySlugs: ["home", "about"],
    });
    expect(mocks.mediaImageDelete).toHaveBeenCalledWith({
      where: { id: "img-1" },
    });

    expect(mocks.pageContentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { contentHtml: { contains: "/api/images/img-1" } },
            { headerText: { contains: "/api/images/img-1" } },
          ],
        },
      }),
    );
  });
});
