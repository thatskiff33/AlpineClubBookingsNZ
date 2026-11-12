import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import path from "path";

vi.mock("server-only", () => ({}));

// #2352 slice-1 review: an upload that stores a file clears the STORED public pages,
// because `{{photo-gallery}}` resolves its file list server-side and freezes it into
// the page. `revalidatePath` needs a static-generation store that no unit test has,
// so the shared helper is stubbed; its contents are pinned by
// public-content-invalidation-contract.test.ts.
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicSite: vi.fn(),
  revalidatePublicPageContent: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
  writeImageDerivatives: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

// The route (and image-storage) do `import fs from "fs/promises"` — mock the
// default so the filesystem is never touched. resolveInImagesRoot stays REAL
// (a pure path computation under process.cwd()), exercising the containment
// path exactly as production would.
vi.mock("fs/promises", () => ({
  default: {
    mkdir: mocks.mkdir,
    writeFile: mocks.writeFile,
    rename: mocks.rename,
    unlink: mocks.unlink,
  },
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  rename: mocks.rename,
  unlink: mocks.unlink,
}));

// The copy writer has its own suite (image-derivatives.test.ts) against real
// sharp and a real directory; here only the route's call into it is pinned.
vi.mock("@/lib/image-derivatives", () => ({
  writeImageDerivatives: mocks.writeImageDerivatives,
}));

import { POST } from "@/app/api/admin/image-manager/upload/route";
import { IMAGES_ROOT } from "@/lib/image-storage";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};
const memberSession = {
  user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // mirrors the route constant
const MAX_UPLOAD_FILES = 25;
const MAX_UPLOAD_REQUEST_BYTES = 80 * 1024 * 1024;
const BOUNDARY = "----imageManagerTestBoundary";

function pngFile(name: string, size = 8): File {
  // The route trusts the declared type + extension (it does not sniff magic
  // bytes), so a small buffer with an image/png type and .png name is a valid
  // upload for its purposes.
  return new File([Buffer.alloc(size, 0x61)], name, { type: "image/png" });
}

// The GPS payload carried in the EXIF fixtures below, so a test can assert it is
// present in the raw upload and absent from the bytes actually written to disk.
const GPS_MARKER = Buffer.from("GPS:-41.29,174.78", "latin1");

/**
 * A JPEG carrying an APP1 EXIF/GPS segment. `withEoi` decides whether it ends
 * with a primary EOI (FF D9): with one the strip is CONFIRMED, without one it is
 * unconfirmed and this route's fail-open policy writes the original.
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

function uploadRequest(files: File[], dir?: string): NextRequest {
  const formData = new FormData();
  if (dir !== undefined) formData.append("dir", dir);
  for (const f of files) formData.append("files", f);
  return new NextRequest(
    "http://localhost/api/admin/image-manager/upload",
    { method: "POST", body: formData },
  );
}

/**
 * A chunked (no Content-Length) body that streams past the 80 MB request cap
 * WITHOUT ever allocating 80 MB in the test: a single 64 KB buffer is re-sent
 * until the counter trips. The streamed reader cancels the source mid-flight.
 */
function oversizeAggregateRequest(): NextRequest {
  const header = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="big.png"\r\nContent-Type: image/png\r\n\r\n`,
    "utf8",
  );
  const CHUNK = new Uint8Array(64 * 1024).fill(0x61);
  const LIMIT = MAX_UPLOAD_REQUEST_BYTES + 2 * 1024 * 1024; // a touch over the cap
  let sent = 0;
  let headerSent = false;
  let cancelled = false;
  // Cancel-safe source: once the reader stops/cancels, never enqueue again, so
  // the fixture can't race a closed controller if the runtime tears the
  // abandoned body down mid-stream.
  const stream = new ReadableStream({
    pull(controller) {
      if (cancelled) return;
      if (!headerSent) {
        headerSent = true;
        controller.enqueue(new Uint8Array(header));
        sent += header.length;
        return;
      }
      if (sent >= LIMIT) {
        controller.close();
        return;
      }
      controller.enqueue(CHUNK);
      sent += CHUNK.length;
    },
    cancel() {
      cancelled = true;
    },
  });
  return new NextRequest("http://localhost/api/admin/image-manager/upload", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: stream,
    duplex: "half",
  } as ConstructorParameters<typeof NextRequest>[1] & { duplex: "half" });
}

describe("POST /api/admin/image-manager/upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.rename.mockResolvedValue(undefined);
    mocks.unlink.mockResolvedValue(undefined);
    mocks.writeImageDerivatives.mockResolvedValue([400, 800]);
  });

  it("requires an admin (content:edit) session", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await POST(uploadRequest([pngFile("a.png")]));
    expect(response.status).toBe(401);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("rejects a non-admin member", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const response = await POST(uploadRequest([pngFile("a.png")]));
    expect(response.status).toBe(403);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("uploads a valid multi-file batch, reporting per-file success", async () => {
    const response = await POST(
      uploadRequest([pngFile("a.png"), pngFile("b.png")]),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(2);
    expect(body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
  });

  it("preserves partial success: one >10MB file fails per-file while the rest succeed", async () => {
    const tooBig = pngFile("big.png", MAX_FILE_SIZE + 1);
    const ok = pngFile("ok.png");
    const response = await POST(uploadRequest([tooBig, ok]));
    const body = await response.json();

    // The whole batch is NOT rejected — the oversize file is a per-file failure
    // (the streamed reader's per-file cap is the 80MB request ceiling, not the
    // friendly 10MB, so a single big file surfaces here rather than 413ing).
    expect(response.status).toBe(200);
    const big = body.results.find((r: { filename: string }) =>
      r.filename.includes("big"),
    );
    const good = body.results.find(
      (r: { filename: string }) => r.filename === "ok.png",
    );
    expect(big.ok).toBe(false);
    expect(big.error).toMatch(/10 MB/);
    expect(good.ok).toBe(true);
    // Only the valid file was written.
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
  });

  it("rejects a batch of more than 25 files with an actionable 413 (names the file limit)", async () => {
    const files = Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, i) =>
      pngFile(`f${i}.png`),
    );
    const response = await POST(uploadRequest(files));
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.error).toMatch(new RegExp(`${MAX_UPLOAD_FILES} files`));
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("rejects an aggregate body over the request cap with an actionable 413 (says to split the batch)", async () => {
    const response = await POST(oversizeAggregateRequest());
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.error).toMatch(/split the upload/i);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // #2242 finding 3. This is the WIDEST image-storing path — 10 MB per file,
  // 25 files per batch — and everything it writes under `public/images` is
  // served anonymously and effectively forever, so EXIF/GPS must not reach
  // disk. Assertions are on the REAL bytes handed to fs.writeFile.
  // -------------------------------------------------------------------------
  it("strips EXIF/GPS from an uploaded JPEG before it is written to disk", async () => {
    expect(EXIF_JPEG_WITH_EOI.includes(GPS_MARKER)).toBe(true);

    const file = new File([new Uint8Array(EXIF_JPEG_WITH_EOI)], "holiday.jpg", {
      type: "image/jpeg",
    });
    const response = await POST(uploadRequest([file]));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results[0].ok).toBe(true);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    const written = Buffer.from(mocks.writeFile.mock.calls[0][1] as Buffer);
    expect(written.includes(GPS_MARKER)).toBe(false);
    expect(written.length).toBeLessThan(EXIF_JPEG_WITH_EOI.length);
  });

  it("FAILS OPEN: writes the original bytes when the strip cannot be confirmed", async () => {
    // A per-file rejection here would change this route's accept/reject
    // behaviour, so an unconfirmed strip stores the original and logs instead.
    const file = new File([new Uint8Array(EXIF_JPEG_NO_EOI)], "holiday.jpg", {
      type: "image/jpeg",
    });
    const response = await POST(uploadRequest([file]));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results[0].ok).toBe(true);
    const written = Buffer.from(mocks.writeFile.mock.calls[0][1] as Buffer);
    expect(written.equals(EXIF_JPEG_NO_EOI)).toBe(true);
  });

  it("still accepts a buffer it cannot sniff, writing it unchanged", async () => {
    // The route trusts the declared MIME + extension and must never start
    // rejecting files just because the bytes do not sniff as a known format.
    const unsniffable = Buffer.from("not-an-image-at-all");
    const file = new File([unsniffable], "a.png", { type: "image/png" });
    const response = await POST(uploadRequest([file]));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results[0].ok).toBe(true);
    const written = Buffer.from(mocks.writeFile.mock.calls[0][1] as Buffer);
    expect(written.equals(unsniffable)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // #4935: website-sized copies, and an atomic replace of the original.
  // -------------------------------------------------------------------------
  it("writes the original under a temporary name and renames it into place", async () => {
    const response = await POST(uploadRequest([pngFile("lodge.png")], "gallery"));
    expect(response.status).toBe(200);

    const [partPath] = mocks.writeFile.mock.calls[0] as [string];
    const [from, to] = mocks.rename.mock.calls[0] as [string, string];
    expect(from).toBe(partPath);
    expect(path.basename(partPath)).toMatch(/^\.lodge\.png\..+\.part$/);
    expect(to).toBe(path.join(IMAGES_ROOT, "gallery", "lodge.png"));
  });

  it("makes website copies from the stored (EXIF-stripped) bytes, in the upload's folder", async () => {
    const file = new File([new Uint8Array(EXIF_JPEG_WITH_EOI)], "holiday.jpg", {
      type: "image/jpeg",
    });
    await POST(uploadRequest([file], "gallery"));

    expect(mocks.writeImageDerivatives).toHaveBeenCalledTimes(1);
    const [bytes, absDir, fileName] = mocks.writeImageDerivatives.mock
      .calls[0] as [Buffer, string, string];
    expect(bytes.includes(GPS_MARKER)).toBe(false);
    expect(bytes.equals(Buffer.from(mocks.writeFile.mock.calls[0][1]))).toBe(true);
    expect(absDir).toBe(path.join(IMAGES_ROOT, "gallery"));
    expect(fileName).toBe("holiday.jpg");
  });

  it("still succeeds when no copy could be made (fail-open)", async () => {
    mocks.writeImageDerivatives.mockResolvedValue([]);
    const response = await POST(uploadRequest([pngFile("a.png")]));
    const body = await response.json();
    expect(body.results[0].ok).toBe(true);
  });

  it("removes the temporary file and reports a failure when the rename fails", async () => {
    mocks.rename.mockRejectedValue(
      Object.assign(new Error("read-only"), { code: "EROFS" }),
    );
    const response = await POST(uploadRequest([pngFile("a.png")]));
    const body = await response.json();

    expect(body.results[0].ok).toBe(false);
    expect(mocks.unlink).toHaveBeenCalledWith(mocks.writeFile.mock.calls[0][0]);
    expect(mocks.writeImageDerivatives).not.toHaveBeenCalled();
  });

  it("refuses to upload into a copies folder", async () => {
    const response = await POST(
      uploadRequest([pngFile("a.png")], "gallery/.sizes"),
    );
    expect(response.status).toBe(400);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
