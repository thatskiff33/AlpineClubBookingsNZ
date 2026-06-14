import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import fs from "fs/promises";
import path from "path";
import {
  ALLOWED_IMAGE_EXTS,
  ALLOWED_IMAGE_MIME,
  resolveInImagesRoot,
  storageUnavailableMessage,
} from "@/lib/image-storage";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file

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
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const dir =
    typeof formData.get("dir") === "string"
      ? (formData.get("dir") as string)
      : "";
  const files = formData.getAll("files") as File[];

  if (!files.length) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  const absDir = resolveInImagesRoot(dir);
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
    const filePath = path.join(absDir, safeName);

    // Double-check resolved path stays inside images root
    if (filePath !== absDir && !filePath.startsWith(absDir + path.sep)) {
      results.push({ filename: file.name, ok: false, error: "Invalid path" });
      continue;
    }

    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(filePath, buffer);
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

  return NextResponse.json({ results });
}
