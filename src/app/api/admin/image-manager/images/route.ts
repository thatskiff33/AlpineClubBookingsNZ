import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import fs from "fs/promises";
import path from "path";
import {
  ALLOWED_IMAGE_EXTS,
  ensureImagesRootForRead,
  imagePublicUrl,
  resolveInImagesRoot,
} from "@/lib/image-storage";

// GET /api/admin/image-manager/images?dir=<relative-path> – list images in a directory
export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const dir = request.nextUrl.searchParams.get("dir") ?? "";
  const absDir = resolveInImagesRoot(dir);
  if (!absDir) {
    return NextResponse.json({ error: "Invalid directory" }, { status: 400 });
  }

  await ensureImagesRootForRead();

  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return NextResponse.json({ images: [] });
  }

  const imageFiles = entries.filter(
    (e) => e.isFile() && ALLOWED_IMAGE_EXTS.has(path.extname(e.name).toLowerCase()),
  );

  const images = await Promise.all(
    imageFiles.map(async (e) => {
      const filePath = path.join(absDir, e.name);
      const stat = await fs.stat(filePath);
      return {
        filename: e.name,
        url: imagePublicUrl(filePath),
        byteSize: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
    }),
  );

  // Sort alphabetically
  images.sort((a, b) => a.filename.localeCompare(b.filename));

  return NextResponse.json({ images });
}

// DELETE /api/admin/image-manager/images – delete a single image file
export async function DELETE(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const dir =
    body !== null &&
    typeof body === "object" &&
    "dir" in body &&
    typeof (body as Record<string, unknown>).dir === "string"
      ? (body as Record<string, string>).dir
      : "";
  const filename =
    body !== null &&
    typeof body === "object" &&
    "filename" in body &&
    typeof (body as Record<string, unknown>).filename === "string"
      ? (body as Record<string, string>).filename
      : "";

  if (!filename || /[/\\]/.test(filename)) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_IMAGE_EXTS.has(ext)) {
    return NextResponse.json({ error: "Not an image file" }, { status: 400 });
  }

  const absDir = resolveInImagesRoot(dir);
  if (!absDir) {
    return NextResponse.json({ error: "Invalid directory" }, { status: 400 });
  }

  const filePath = path.join(absDir, filename);
  if (filePath !== absDir && !filePath.startsWith(absDir + path.sep)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    await fs.unlink(filePath);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to delete image" },
      { status: 500 },
    );
  }
}
