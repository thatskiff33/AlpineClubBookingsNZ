import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  mediaImageFindMany: vi.fn(),
  mediaImageCount: vi.fn(),
  mediaImageCreate: vi.fn(),
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
      findMany: mocks.mediaImageFindMany,
      count: mocks.mediaImageCount,
      create: mocks.mediaImageCreate,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
  },
}));

import { GET, POST } from "@/app/api/admin/image-library/route";

const adminSession = { user: { id: "admin-1", role: "ADMIN" } };
const memberSession = { user: { id: "member-1", role: "MEMBER" } };

const PNG_BYTES = (() => {
  const buf = Buffer.alloc(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(64, 16);
  buf.writeUInt32BE(32, 20);
  return buf;
})();

function listRequest(query = "") {
  return new NextRequest(`http://localhost/api/admin/image-library${query}`);
}

function uploadRequest(file: File, altText?: string) {
  const formData = new FormData();
  formData.append("file", file);
  if (altText !== undefined) {
    formData.append("altText", altText);
  }
  return new NextRequest("http://localhost/api/admin/image-library", {
    method: "POST",
    body: formData,
  });
}

describe("GET /api/admin/image-library", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.mediaImageFindMany.mockResolvedValue([]);
    mocks.mediaImageCount.mockResolvedValue(0);
  });

  it("requires an admin session", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await GET(listRequest());
    expect(response.status).toBe(401);
    expect(mocks.mediaImageFindMany).not.toHaveBeenCalled();
  });

  it("rejects non-admin members", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const response = await GET(listRequest());
    expect(response.status).toBe(403);
    expect(mocks.mediaImageFindMany).not.toHaveBeenCalled();
  });

  it("returns a paginated list with serving URLs and no raw bytes", async () => {
    mocks.mediaImageFindMany.mockResolvedValue([
      {
        id: "img-1",
        filename: "photo.png",
        contentType: "image/png",
        byteSize: 1234,
        altText: null,
        width: 64,
        height: 32,
        uploadedByMemberId: "admin-1",
        createdAt: new Date("2026-06-12T00:00:00.000Z"),
      },
    ]);
    mocks.mediaImageCount.mockResolvedValue(1);

    const response = await GET(listRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.images).toHaveLength(1);
    expect(body.images[0]).toMatchObject({
      id: "img-1",
      filename: "photo.png",
      contentType: "image/png",
      url: "/api/images/img-1",
    });
    expect(body.images[0].data).toBeUndefined();
  });

  it("paginates using page and pageSize query params", async () => {
    await GET(listRequest("?page=2&pageSize=10"));
    expect(mocks.mediaImageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 }),
    );
  });

  it("rejects invalid pagination params", async () => {
    const response = await GET(listRequest("?pageSize=0"));
    expect(response.status).toBe(400);
  });
});

describe("POST /api/admin/image-library", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.mediaImageCreate.mockImplementation(async ({ data }) => ({
      id: "img-new",
      filename: data.filename,
      contentType: data.contentType,
      byteSize: data.byteSize,
      altText: data.altText,
      width: data.width,
      height: data.height,
      uploadedByMemberId: data.uploadedByMemberId,
      createdAt: new Date("2026-06-12T00:00:00.000Z"),
    }));
    mocks.auditLogCreate.mockResolvedValue({});
  });

  it("requires an admin session", async () => {
    mocks.auth.mockResolvedValue(null);
    const file = new File([PNG_BYTES], "photo.png", { type: "image/png" });
    const response = await POST(uploadRequest(file));
    expect(response.status).toBe(401);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("rejects non-admin members", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const file = new File([PNG_BYTES], "photo.png", { type: "image/png" });
    const response = await POST(uploadRequest(file));
    expect(response.status).toBe(403);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("uploads a valid PNG, sniffing the content type from magic bytes", async () => {
    const file = new File([PNG_BYTES], "my photo.png", { type: "image/png" });
    const response = await POST(uploadRequest(file, "A scenic photo"));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.image).toMatchObject({
      id: "img-new",
      filename: "my_photo.png",
      contentType: "image/png",
      byteSize: PNG_BYTES.length,
      width: 64,
      height: 32,
      altText: "A scenic photo",
      url: "/api/images/img-new",
    });
    expect(mocks.mediaImageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contentType: "image/png",
          uploadedByMemberId: "admin-1",
        }),
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  it("rejects a request with no file field", async () => {
    const formData = new FormData();
    const request = new NextRequest("http://localhost/api/admin/image-library", {
      method: "POST",
      body: formData,
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("rejects a file whose magic bytes do not match an allowed image type", async () => {
    const file = new File([Buffer.from("just some text")], "fake.png", {
      type: "image/png",
    });
    const response = await POST(uploadRequest(file));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/Unsupported or invalid image file/);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("rejects an oversized file even when declared Content-Type is allowed", async () => {
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(2 * 1024 * 1024)]);
    const file = new File([big], "big.png", { type: "image/png" });
    const response = await POST(uploadRequest(file));
    expect(response.status).toBe(413);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("trusts magic bytes over a spoofed declared Content-Type", async () => {
    // Bytes are a real PNG, but the browser/client declares a disallowed type.
    const file = new File([PNG_BYTES], "photo.bin", {
      type: "application/octet-stream",
    });
    const response = await POST(uploadRequest(file));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.image.contentType).toBe("image/png");
  });
});
