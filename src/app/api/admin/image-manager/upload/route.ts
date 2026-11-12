import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import {
  ALLOWED_IMAGE_EXTS,
  ALLOWED_IMAGE_MIME,
  resolveAlbumPathInImagesRoot,
  storageUnavailableMessage,
} from "@/lib/image-storage";
import { writeImageDerivatives } from "@/lib/image-derivatives";
import { readCappedMultipartFormData } from "@/lib/capped-multipart";
import {
  detectImageContentType,
  storableImageBytes,
} from "@/lib/media-image";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file

// This route accepts a whole batch (drag-and-drop of several files) and reports
// per-file results, so it keeps its own friendly per-file MAX_FILE_SIZE check.
// The streamed reader adds the memory backstop the batch path lacked: a hard
// ceiling on the total request body and the number of file parts, so a chunked
// or spoofed-Content-Length batch can't buffer unbounded bytes. The per-file
// busboy limit is set to the total ceiling (not MAX_FILE_SIZE) so a single
// oversize file is still surfaced as a per-file result rather than failing the
// whole batch — preserving the existing partial-success behaviour.
const MAX_UPLOAD_FILES = 25;
const MAX_UPLOAD_REQUEST_BYTES = 80 * 1024 * 1024; // 80 MB per request batch

function sanitizeFilename(name: string): string {
  // Strip any path components, then replace unsafe characters
  const base = path.basename(name);
  return (
    base
      .replace(/[<>:"|?*\x00-\x1F]/g, "_")
      .replace(/\.{2,}/g, ".")
      .substring(0, 200)
      .trim() || "image"
  );
}

// POST /api/admin/image-manager/upload – upload one or more image files
export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const multipart = await readCappedMultipartFormData(request, {
    maxRequestBytes: MAX_UPLOAD_REQUEST_BYTES,
    maxFileBytes: MAX_UPLOAD_REQUEST_BYTES,
    maxFiles: MAX_UPLOAD_FILES,
  });
  if (!multipart.ok) {
    if (multipart.reason === "too_large") {
      // Actionable, cause-specific copy (surfaced verbatim in the client toast):
      // too MANY files names the 25-file limit; an oversize aggregate names the
      // total-MB limit and tells the admin to split the batch. Kept as an
      // intentional DoS backstop — no client-side chunking (#2235 Finding 2).
      const error =
        multipart.cause === "count"
          ? `Too many files. Upload at most ${MAX_UPLOAD_FILES} files per batch.`
          : `Upload is too large. Keep each batch under ${
              MAX_UPLOAD_REQUEST_BYTES / (1024 * 1024)
            } MB in total — split the upload into smaller batches.`;
      return NextResponse.json({ error }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }
  const formData = multipart.formData;

  const dir =
    typeof formData.get("dir") === "string"
      ? (formData.get("dir") as string)
      : "";
  const files = formData.getAll("files") as File[];

  if (!files.length) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  // A copies folder is written only by the copy writer (#4935), never by hand.
  const absDir = resolveAlbumPathInImagesRoot(dir);
  if (!absDir) {
    return NextResponse.json({ error: "Invalid directory" }, { status: 400 });
  }

  // Create the target directory. Surface a clear, actionable reason when the
  // storage volume is missing or read-only instead of the raw 500 the UI used
  // to show as a generic "Upload failed". The mkdir stays inline here (right
  // after the containment check above) so the path-traversal barrier is local.
  try {
    await fs.mkdir(absDir, { recursive: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.error(
      "image-manager: failed to create upload directory:",
      absDir,
      e.code,
      e.message,
    );
    return NextResponse.json(
      { error: storageUnavailableMessage(e.code) },
      { status: 500 },
    );
  }

  const results: Array<{ filename: string; ok: boolean; error?: string }> = [];

  for (const file of files) {
    if (!ALLOWED_IMAGE_MIME.has(file.type)) {
      results.push({
        filename: file.name,
        ok: false,
        error: "Unsupported file type",
      });
      continue;
    }

    if (file.size > MAX_FILE_SIZE) {
      results.push({
        filename: file.name,
        ok: false,
        error: "File exceeds 10 MB limit",
      });
      continue;
    }

    const ext = path.extname(file.name).toLowerCase();
    if (!ALLOWED_IMAGE_EXTS.has(ext)) {
      results.push({
        filename: file.name,
        ok: false,
        error: "Unsupported file extension",
      });
      continue;
    }

    const safeName = sanitizeFilename(file.name);
    // Build the destination by concatenating onto absDir rather than calling
    // path.join(absDir, safeName). Turbopack's Node File Trace expands a
    // path.join() whose base it cannot statically resolve (absDir derives from
    // the request via resolveInImagesRoot) into a recursive read of
    // process.cwd(), tracing the entire repository into the `output: standalone`
    // build ("whole project was traced unintentionally"). sanitizeFilename above
    // reduces safeName to a bare filename (no separators, no ".."), and absDir is
    // already proven to live inside IMAGES_ROOT, so this is equivalent to
    // path.join here while keeping the route's trace scoped.
    const filePath: string = `${absDir}${path.sep}${safeName}`;

    // Double-check resolved path stays inside images root
    if (filePath !== absDir && !filePath.startsWith(absDir + path.sep)) {
      results.push({ filename: file.name, ok: false, error: "Invalid path" });
      continue;
    }

    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      // Strip EXIF/XMP/comment metadata (camera GPS coordinates live in JPEG
      // APP1) before the bytes hit disk. This is the WIDEST of the image-storing
      // paths — 10 MB per file, 25 files per batch — and everything under
      // IMAGES_ROOT (`public/images`) is served ANONYMOUSLY and effectively
      // forever, so a straight-from-phone lodge photo dragged into the image
      // manager would otherwise publish its location.
      //
      // FAIL-OPEN through the shared helper, exactly like the image-library and
      // config-transfer paths (and deliberately unlike the fail-CLOSED
      // member-photo route): an unconfirmed strip stores the ORIGINAL bytes and
      // logs, and never turns into a per-file rejection. The content type is
      // sniffed from the bytes rather than reusing the declared MIME above, so
      // the strip matches the real format; bytes that sniff as nothing
      // recognised are stored unchanged with the same warning rather than being
      // rejected, preserving this route's accept/reject behaviour exactly.
      const storable = storableImageBytes(
        buffer,
        detectImageContentType(buffer),
        { source: "image-manager upload", filename: safeName },
      );
      // Write-then-rename (#4935): replacing `lodge.jpg` swaps the file
      // atomically, so a visitor mid-download keeps the old bytes and the
      // streamed length still matches the Content-Length the serving route
      // sent. The `.part` name is hidden and has no image extension, so no
      // listing or the serving route ever sees it.
      const partPath = `${absDir}${path.sep}.${safeName}.${randomUUID()}.part`;
      try {
        await fs.writeFile(partPath, storable);
        await fs.rename(partPath, filePath);
      } catch (err) {
        await fs.unlink(partPath).catch(() => undefined);
        throw err;
      }
      // Website-sized WebP copies for the gallery (#4935, INV-PUB-004), made
      // from the bytes as stored. Fail-open: a photo that cannot be copied is
      // still a successful upload, served as the original.
      await writeImageDerivatives(storable, absDir, safeName);
      results.push({ filename: safeName, ok: true });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // Path passed as a separate argument so a tainted value cannot act as a
      // format directive.
      console.error(
        "image-manager: failed to write file:",
        filePath,
        e.code,
        e.message,
      );
      results.push({
        filename: file.name,
        ok: false,
        error: `Failed to save file (${e.code ?? "unknown error"})`,
      });
    }
  }

  // #2352 slice-1 review. `{{photo-gallery}}` / `{{photo-slideshow}}` are resolved
  // SERVER-side at render time — `listPhotoGalleryImagesFromDirectory()` in
  // src/lib/page-content-embeds.ts does an `fs.readdir` and passes the result as
  // props — so under full-route ISR that listing is frozen into the stored page. A
  // batch that stored nothing changed nothing, so only clear on a real write.
  if (results.some((result) => result.ok)) {
    revalidatePublicSite();
  }

  return NextResponse.json({ results });
}
