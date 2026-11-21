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

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
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
import { pngBytes } from "@/lib/__tests__/helpers/png-fixture";
import { IMAGE_NOT_CLEAN_MESSAGE } from "@/lib/image-metadata";

const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } };
const memberSession = { user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } };

// A structurally complete PNG, so the metadata strip can confirm it clean
// (#5244: an unconfirmed image is refused).
const PNG_BYTES = pngBytes({ width: 64, height: 32 });

// The GPS payload carried in the EXIF fixtures below, so a test can assert it is
// present in the raw upload and absent from the bytes actually stored.
const GPS_MARKER = Buffer.from("GPS:-41.29,174.78", "latin1");

/**
 * A JPEG carrying an APP1 EXIF/GPS segment. `withEoi` decides whether it ends
 * with a primary EOI (FF D9): with one, the fail-closed parser reaches its clean
 * exit and the strip is CONFIRMED; without one, the strip is unconfirmed and
 * the upload is refused (#5244).
 */
function exifJpeg(withEoi: boolean): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), GPS_MARKER]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2, 0);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), len, payload]);
  const sof0 = Buffer.alloc(11);
  sof0.writeUInt8(0xff, 0);
  sof0.writeUInt8(0xc0, 1);
  sof0.writeUInt16BE(9, 2);
  sof0.writeUInt8(8, 4);
  sof0.writeUInt16BE(16, 5); // height
  sof0.writeUInt16BE(16, 7); // width
  sof0.writeUInt8(1, 9);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x01, 0x77]);
  const parts = [soi, app1, sof0, sos];
  if (withEoi) parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

const EXIF_JPEG_WITH_EOI = exifJpeg(true);
const EXIF_JPEG_NO_EOI = exifJpeg(false);

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

function rawImageMultipartBody(sizeBytes: number): Buffer {
  const boundary = "----imageLibraryTestBoundary";
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.png"\r\nContent-Type: image/png\r\n\r\n`,
    "utf8",
  );
  const trailer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const dataLen = Math.max(0, sizeBytes - header.length - trailer.length);
  return Buffer.concat([header, Buffer.alloc(dataLen, 0x61), trailer]);
}

/**
 * A streamed upload whose body exceeds the request cap but declares a tiny,
 * honest-looking Content-Length — the chunked/spoofed bypass #2235 closes.
 */
function chunkedOversizeUploadRequest(): NextRequest {
  const body = rawImageMultipartBody(3 * 1024 * 1024); // > 2MB + 64KB request cap
  let offset = 0;
  let cancelled = false;
  // Cancel-safe source: once the reader stops/cancels, never enqueue again, so
  // the fixture can't race a closed controller if the runtime tears the
  // abandoned body down mid-stream.
  const stream = new ReadableStream({
    pull(controller) {
      if (cancelled) return;
      if (offset >= body.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 64 * 1024, body.length);
      controller.enqueue(new Uint8Array(body.subarray(offset, end)));
      offset = end;
    },
    cancel() {
      cancelled = true;
    },
  });
  return new NextRequest("http://localhost/api/admin/image-library", {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=----imageLibraryTestBoundary",
      "content-length": "1024",
    },
    body: stream,
    duplex: "half",
  } as ConstructorParameters<typeof NextRequest>[1] & { duplex: "half" });
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

  it("lists only CONTENT images, never member photos (MP1, #171)", async () => {
    await GET(listRequest());
    // Both the page and the total are scoped to kind = CONTENT so a
    // MEMBER_PHOTO row can never surface in the website content picker.
    expect(mocks.mediaImageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { kind: "CONTENT" } }),
    );
    expect(mocks.mediaImageCount).toHaveBeenCalledWith({
      where: { kind: "CONTENT" },
    });
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
          // Content-picker uploads are always stamped CONTENT (MP1, #171).
          kind: "CONTENT",
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

  it("rejects a chunked, spoofed-Content-Length oversize body with 413 (streamed cap, #2235)", async () => {
    const response = await POST(chunkedOversizeUploadRequest());
    expect(response.status).toBe(413);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("accepts a valid image of EXACTLY the 2MB cap (inclusive boundary, #2235 off-by-one guard)", async () => {
    // busboy trips its file limit at `size === cap`; the streamed reader passes
    // `cap + 1` so a file of exactly MAX_MEDIA_IMAGE_BYTES still succeeds, as it
    // did under the old post-parse `size > MAX` check. Guards the exact-cap 413
    // regression the raw busboy limit would otherwise produce.
    const MAX_MEDIA_IMAGE_BYTES = 2 * 1024 * 1024;
    const exact = Buffer.concat([
      PNG_BYTES,
      Buffer.alloc(MAX_MEDIA_IMAGE_BYTES - PNG_BYTES.length),
    ]);
    expect(exact.length).toBe(MAX_MEDIA_IMAGE_BYTES);
    const file = new File([exact], "exact.png", { type: "image/png" });
    const response = await POST(uploadRequest(file));

    expect(response.status).toBe(201);
    expect(mocks.mediaImageCreate).toHaveBeenCalledTimes(1);
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

  // ---------------------------------------------------------------------------
  // #2242 finding 3. A library image is served ANONYMOUSLY from /api/images/[id]
  // with `public, max-age=31536000, immutable`, so a straight-from-phone photo
  // dropped into a website page used to publish its GPS coordinates effectively
  // forever. Assertions are on the REAL stored bytes, not on a strip mock.
  // ---------------------------------------------------------------------------
  it("strips EXIF/GPS from an uploaded JPEG before storing it", async () => {
    expect(EXIF_JPEG_WITH_EOI.includes(GPS_MARKER)).toBe(true);

    const file = new File([new Uint8Array(EXIF_JPEG_WITH_EOI)], "holiday.jpg", {
      type: "image/jpeg",
    });
    const response = await POST(uploadRequest(file));

    expect(response.status).toBe(201);
    const data = mocks.mediaImageCreate.mock.calls[0][0].data;
    const stored = Buffer.from(data.data as Uint8Array);
    expect(stored.includes(GPS_MARKER)).toBe(false);
    expect(stored.length).toBeLessThan(EXIF_JPEG_WITH_EOI.length);
    // byteSize must describe the bytes actually written, not the upload.
    expect(data.byteSize).toBe(stored.length);
  });

  it("refuses an image whose strip could not be confirmed, saying why (#5244)", async () => {
    // Every image-storing path fails closed: nothing unconfirmed is stored.
    const file = new File([new Uint8Array(EXIF_JPEG_NO_EOI)], "holiday.jpg", {
      type: "image/jpeg",
    });
    const response = await POST(uploadRequest(file));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(IMAGE_NOT_CLEAN_MESSAGE);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("stores a GIF with its comment block removed (#5244)", async () => {
    const gif = Buffer.concat([
      Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00", "latin1"),
      Buffer.from([0x21, 0xfe, 0x05]),
      Buffer.from("Jane!", "latin1"),
      Buffer.from([0x00]),
      Buffer.from("\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b", "latin1"),
    ]);
    const file = new File([gif], "spin.gif", { type: "image/gif" });
    const response = await POST(uploadRequest(file));

    expect(response.status).toBe(201);
    const data = mocks.mediaImageCreate.mock.calls[0][0].data;
    const stored = Buffer.from(data.data as Uint8Array);
    expect(stored.includes(Buffer.from("Jane!", "latin1"))).toBe(false);
    expect(stored.length).toBe(gif.length - 9);
    expect(data.contentType).toBe("image/gif");
    expect([data.width, data.height]).toEqual([1, 1]);
  });
});
