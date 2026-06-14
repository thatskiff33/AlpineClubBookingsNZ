import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import fs from "fs/promises";
import path from "path";
import {
  IMAGES_ROOT,
  ensureImagesRootForRead,
  isStorageUnavailableCode,
  resolveInImagesRoot,
  storageUnavailableMessage,
} from "@/lib/image-storage";

async function collectDirs(absDir: string, relBase: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      result.push(rel);
      const children = await collectDirs(path.join(absDir, entry.name), rel);
      result.push(...children);
    }
  }
  return result;
}

// GET /api/admin/image-manager/directories – list all directories
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  await ensureImagesRootForRead();
  const dirs = await collectDirs(IMAGES_ROOT, "");
  return NextResponse.json({ directories: ["", ...dirs] });
}

// POST /api/admin/image-manager/directories – create a new directory
export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name =
    body !== null &&
    typeof body === "object" &&
    "name" in body &&
    typeof (body as Record<string, unknown>).name === "string"
      ? (body as Record<string, string>).name.trim()
      : "";
  const parent =
    body !== null &&
    typeof body === "object" &&
    "parent" in body &&
    typeof (body as Record<string, unknown>).parent === "string"
      ? (body as Record<string, string>).parent
      : "";

  if (!name || /[/\\<>:"|?*\x00-\x1F]/.test(name)) {
    return NextResponse.json(
      { error: "Invalid directory name" },
      { status: 400 },
    );
  }

  const parentAbs = resolveInImagesRoot(parent);
  if (!parentAbs) {
    return NextResponse.json({ error: "Invalid parent path" }, { status: 400 });
  }

  const newAbs = path.join(parentAbs, name);
  if (newAbs !== IMAGES_ROOT && !newAbs.startsWith(IMAGES_ROOT + path.sep)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    // Non-recursive: a pre-existing directory throws EEXIST -> 409. The mkdir
    // stays inline here (right after the containment check above) so the
    // path-traversal barrier is local. The images root and parent already exist
    // (GET ensures the root; the UI only creates inside an existing directory).
    await fs.mkdir(newAbs);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") {
      return NextResponse.json(
        { error: "Directory already exists" },
        { status: 409 },
      );
    }
    // Path passed as a separate argument so a tainted value cannot act as a
    // format directive.
    console.error(
      "image-manager: failed to create directory:",
      newAbs,
      e.code,
      e.message,
    );
    // A missing/read-only storage volume gets the clear, actionable message;
    // anything else is an opaque failure.
    if (isStorageUnavailableCode(e.code)) {
      return NextResponse.json(
        { error: storageUnavailableMessage(e.code) },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: "Failed to create directory" },
      { status: 500 },
    );
  }
}

// PATCH /api/admin/image-manager/directories – rename a directory
export async function PATCH(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rel =
    body !== null &&
    typeof body === "object" &&
    "path" in body &&
    typeof (body as Record<string, unknown>).path === "string"
      ? (body as Record<string, string>).path
      : "";
  const newName =
    body !== null &&
    typeof body === "object" &&
    "newName" in body &&
    typeof (body as Record<string, unknown>).newName === "string"
      ? (body as Record<string, string>).newName.trim()
      : "";

  if (!rel) {
    return NextResponse.json(
      { error: "Cannot rename the root directory" },
      { status: 400 },
    );
  }
  if (!newName || /[/\\<>:"|?*\x00-\x1F]/.test(newName)) {
    return NextResponse.json(
      { error: "Invalid directory name" },
      { status: 400 },
    );
  }

  const oldAbs = resolveInImagesRoot(rel);
  if (!oldAbs || oldAbs === IMAGES_ROOT) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const newAbs = path.join(path.dirname(oldAbs), newName);
  if (!newAbs.startsWith(IMAGES_ROOT + path.sep)) {
    return NextResponse.json(
      { error: "Invalid rename target" },
      { status: 400 },
    );
  }

  try {
    await fs.rename(oldAbs, newAbs);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to rename directory" },
      { status: 500 },
    );
  }
}

// DELETE /api/admin/image-manager/directories – delete a directory and its contents
export async function DELETE(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rel =
    body !== null &&
    typeof body === "object" &&
    "path" in body &&
    typeof (body as Record<string, unknown>).path === "string"
      ? (body as Record<string, string>).path
      : "";

  if (!rel) {
    return NextResponse.json(
      { error: "Cannot delete the root directory" },
      { status: 400 },
    );
  }

  const absPath = resolveInImagesRoot(rel);
  if (!absPath || absPath === IMAGES_ROOT) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    await fs.rm(absPath, { recursive: true });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to delete directory" },
      { status: 500 },
    );
  }
}
